/**
 * Mål: utfall mot mål per månad (intäkt, vinst, antal automater i drift), prognos för
 * månadens utfall och om målet är i fas.
 *
 * Regler:
 * - Utfall för intäkt och vinst räknas med domänens lönsamhet för månaden till och med
 *   `asOf` (eller hela månaden om den är slut), för organisationen, en butik eller en
 *   automat. Intäkt = nettointäkt för alla order (även utan inköpspris). Vinst =
 *   lönsamhetens vinst (prissatta order, hyra per dag för delmånad).
 * - Prognos för intäkt och vinst:
 *   - Månaden är slut: prognos = utfall ('final').
 *   - Minst `minElapsedDays` (standard 7) dagar har gått: utfall + snitt per dag hittills ×
 *     återstående dagar ('run-rate').
 *   - Färre dagar, eller månaden har inte börjat: utfall + snitt per dag de senaste
 *     `trailingDays` (standard 28) dagarna till och med `asOf` × återstående dagar ('trailing').
 * - Automater i drift = antal automater som är placerade i en butik (i butiken, för en
 *   butik) en viss dag. Utfall = antalet `asOf` (månadens sista dag om den är slut); har
 *   månaden inte börjat är utfallet 0, eftersom inget har hänt i den månaden än. Prognos =
 *   antalet månadens sista dag enligt kända placeringar ('placements').
 * - Status: prognos ≥ mål → 'on-track' (i fas), annars 'behind' (efter). När månaden är slut:
 *   'met' (nått) eller 'missed' (missat).
 * - Dagar (samma regel som @/analytics/days): med `today` räknas bara hela dagar, till och
 *   med i går, och med `dataStart` delar snitten bara med dagar från första ordern. En
 *   automat som sålt i 21 dagar ger alltså snitt = försäljning / 21, inte / 28.
 * - Behov per dag = (mål − utfall) / återstående dagar, avrundat uppåt till helt öre.
 * - Underlaget för intäkt och vinst pekar ut orderna och försäljningsdagarna utfallet (och
 *   en prognos på de senaste dagarna) bygger på: alla order för intäkt, prissatta order för
 *   vinst, i målets butik eller automat.
 */

import {
  addDays,
  buildLedger,
  ceilDiv,
  daysBetween,
  DomainError,
  monthEnd,
  monthStart,
  maxDate,
  minDate,
  mulDivRound,
  parseIsoMonth,
  periodDays,
  profitabilityViews,
  ratioBp,
  roundHalfUp,
  type EconomicsSources,
  type IsoDate,
  type IsoMonth,
  type OrderLine,
  type Period,
  type ProfitabilityResult,
} from "@/domain";
import { lastCompleteDay } from "../days";
import { nameLookup } from "../todos/common";
import { day, kr, monthName, plural, sentence } from "../todos/text";
import {
  fig,
  orderTrail,
  scenarioEvidence,
  signedPct,
  type OrderTrail,
  type ScenarioEvidence,
} from "../expansion/common";

/** Måttet för ett mål (goals.metric). */
export type GoalMetric = "revenue" | "profit" | "active_machines";

/** Vad målet gäller (goals.scope). */
export type GoalScope = "organization" | "store" | "machine";

/** Ett mål för en månad. `target` i öre för intäkt och vinst, antal för automater. */
export interface Goal {
  readonly id: string;
  readonly month: IsoMonth;
  readonly metric: GoalMetric;
  readonly target: number;
  readonly scope: GoalScope;
  readonly storeId?: string | null;
  readonly machineId?: string | null;
}

/** Inställningar för prognosen. */
export interface GoalOptions {
  /** Dagar som måste ha gått i månaden för att snittet hittills ska användas. Standard 7. */
  readonly minElapsedDays?: number;
  /** Fönster för snittet när månaden är för ung. Standard 28 dagar. */
  readonly trailingDays?: number;
}

/** Standardvärden. */
export const GOAL_DEFAULTS = { minElapsedDays: 7, trailingDays: 28 } as const;

/** Indata till `goalProgress`. */
export interface GoalInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly goals: readonly Goal[];
  /** Dagens affärsdatum (sista dag med kända order). */
  readonly asOf: IsoDate;
  /**
   * Dagens datum. När det anges räknas bara hela dagar (till och med i går, samma regel som
   * @/analytics/days): i dag pågår och skulle annars räknas som en dag utan försäljning.
   */
  readonly today?: IsoDate;
  /**
   * Första dagen med data (första ordern). Dagar före den räknas inte i snitten: en automat
   * som funnits i 21 dagar delar med 21, inte med 28.
   */
  readonly dataStart?: IsoDate | null;
  readonly stores?: readonly { id: string; name: string }[];
  readonly machines?: readonly { id: string; name: string }[];
  readonly options?: GoalOptions;
}

/** Hur prognosen räknats. */
export type ForecastMethod = "final" | "run-rate" | "trailing" | "placements";

/** Läget för ett mål. */
export type GoalStatus = "on-track" | "behind" | "met" | "missed";

/** Utfall och prognos för ett mål. */
export interface GoalProgress {
  readonly goalId: string;
  readonly month: IsoMonth;
  readonly metric: GoalMetric;
  readonly scope: GoalScope;
  readonly scopeId: string | null;
  readonly target: number;
  /** Utfall hittills (öre eller antal). */
  readonly actual: number;
  /** Sista dag som utfallet räknas till och med. `null` när månaden inte har börjat. */
  readonly measuredThrough: IsoDate | null;
  readonly elapsedDays: number;
  readonly daysInMonth: number;
  readonly remainingDays: number;
  readonly forecast: number;
  readonly forecastMethod: ForecastMethod;
  readonly status: GoalStatus;
  /** Prognos − mål. */
  readonly gap: number;
  /** Utfall / mål i bp. `null` när målet är 0. */
  readonly progressBp: number | null;
  /** Snitt per dag hittills (intäkt/vinst). `null` för automater eller utan dagar. */
  readonly averagePerDay: number | null;
  /** Vad som behövs per återstående dag för att nå målet (intäkt/vinst). `null` när inga dagar återstår. */
  readonly requiredPerDay: number | null;
  /** Order utan inköpspris i utfallet (ingår inte i vinsten). */
  readonly unpricedOrders: number;
  readonly text: string;
  readonly detail: string;
  readonly evidence: ScenarioEvidence;
}

const METRIC_NAME: Record<GoalMetric, string> = {
  revenue: "Intäkt",
  profit: "Vinst",
  active_machines: "Automater i drift",
};

const METRIC_ORDER: Record<GoalMetric, number> = { revenue: 0, profit: 1, active_machines: 2 };

function scopeId(goal: Goal): string | null {
  if (goal.scope === "store") {
    if (!goal.storeId) throw new DomainError("invalid_input", `Målet ${goal.id} saknar butik.`);
    return goal.storeId;
  }
  if (goal.scope === "machine") {
    if (!goal.machineId) throw new DomainError("invalid_input", `Målet ${goal.id} saknar automat.`);
    return goal.machineId;
  }
  return null;
}

function assertGoal(goal: Goal): void {
  parseIsoMonth(goal.month);
  if (!Number.isSafeInteger(goal.target)) {
    throw new DomainError("invalid_amount", `Målet ${goal.id} måste vara ett heltal.`);
  }
  if (goal.metric !== "profit" && goal.target < 0) {
    throw new DomainError("invalid_amount", `Målet ${goal.id} får inte vara negativt.`);
  }
}

/** Antal automater placerade (i butiken `storeId`, om angiven) dagen `date`. */
export function activeMachinesOn(
  placements: EconomicsSources["placements"],
  date: IsoDate,
  filter: { storeId?: string | null; machineId?: string | null } = {},
): string[] {
  const ids = new Set<string>();
  for (const p of placements) {
    if (p.from > date || (p.to !== null && p.to < date)) continue;
    if (filter.storeId && p.storeId !== filter.storeId) continue;
    if (filter.machineId && p.machineId !== filter.machineId) continue;
    ids.add(p.machineId);
  }
  return [...ids].sort();
}

/** Dagar i perioden från `dataStart`. */
function measuredDaysIn(period: Period, dataStart: IsoDate | null): number {
  if (dataStart === null) return 0;
  const startAt = maxDate(period.start, dataStart);
  return startAt <= period.end ? periodDays({ start: startAt, end: period.end }) : 0;
}

/**
 * Utfall, prognos och status för varje mål, sorterat på månad, mått, omfattning och id.
 * Se reglerna överst i filen.
 */
export function goalProgress(input: GoalInput): GoalProgress[] {
  const opts = { ...GOAL_DEFAULTS, ...input.options };
  if (!Number.isSafeInteger(opts.minElapsedDays) || opts.minElapsedDays < 0) {
    throw new DomainError("invalid_input", "Minsta antal dagar måste vara ett heltal ≥ 0.");
  }
  if (!Number.isSafeInteger(opts.trailingDays) || opts.trailingDays < 1) {
    throw new DomainError("invalid_input", "Fönstret måste vara minst 1 dag.");
  }
  const { asOf } = input;
  addDays(asOf, 0); // kontrollerar datumet
  // Sista hela dagen med data: asOf, men aldrig i dag (dagen pågår).
  const today = input.today ?? null;
  const lastDay = today !== null ? minDate(asOf, lastCompleteDay(today)) : asOf;
  const orgDataStart = input.dataStart ?? null;
  /**
   * Första dagen med data för målets butik eller automat: första ordern, eller den första
   * placeringen i butiken/automaten om den kom senare (en ny automat i en gammal flotta).
   */
  const dataStartOf = (goal: Goal): IsoDate | null => {
    if (orgDataStart === null || goal.scope === "organization") return orgDataStart;
    let first: IsoDate | null = null;
    for (const p of input.placements) {
      if (goal.scope === "store" && p.storeId !== goal.storeId) continue;
      if (goal.scope === "machine" && p.machineId !== goal.machineId) continue;
      if (first === null || p.from < first) first = p.from;
    }
    return first === null ? orgDataStart : maxDate(orgDataStart, first);
  };
  const storeName = nameLookup(input.stores ?? []);
  const machineName = nameLookup(input.machines ?? []);

  // Lönsamhet per period, byggd en gång per period.
  const cache = new Map<string, Record<"store" | "machine", ProfitabilityResult>>();
  const views = (period: Period) => {
    const key = `${period.start}/${period.end}`;
    let v = cache.get(key);
    if (!v) {
      v = profitabilityViews({ ...input, period }, ["store", "machine"]);
      cache.set(key, v);
    }
    return v;
  };
  const ledgers = new Map<string, ReturnType<typeof buildLedger>>();
  const trail = (goal: Goal, period: Period): OrderTrail => {
    const key = `${period.start}/${period.end}`;
    let l = ledgers.get(key);
    if (!l) {
      l = buildLedger({ ...input, period });
      ledgers.set(key, l);
    }
    return orderTrail(l.entries, {
      storeId: goal.scope === "store" ? goal.storeId : null,
      machineId: goal.scope === "machine" ? goal.machineId : null,
      pricedOnly: goal.metric === "profit",
    });
  };
  const moneyValue = (
    goal: Goal,
    period: Period,
  ): { value: number; unpriced: number; orders: number } => {
    const v = views(period);
    const id = scopeId(goal);
    const row =
      goal.scope === "organization"
        ? v.store.totals
        : (goal.scope === "store" ? v.store : v.machine).rows.find(
            (r) => r.kind === "item" && r.key === id,
          );
    if (!row) return { value: 0, unpriced: 0, orders: 0 };
    const value =
      goal.metric === "revenue" ? row.revenueOre + row.unpricedRevenueOre : row.profitOre;
    return { value, unpriced: row.unpricedOrders, orders: row.orders };
  };

  const out: GoalProgress[] = [];
  for (const goal of input.goals) {
    assertGoal(goal);
    const id = scopeId(goal);
    const start = monthStart(goal.month);
    const end = monthEnd(goal.month);
    const dim = periodDays({ start, end });
    const finished = lastDay >= end;
    const started = (today ?? asOf) >= start;
    const through = finished ? end : lastDay >= start ? lastDay : null;
    const elapsed = through === null ? 0 : daysBetween(start, through) + 1;
    const remaining = dim - elapsed;
    const label = `${METRIC_NAME[goal.metric]} ${monthName(goal.month)}${
      goal.scope === "store"
        ? ` för ${storeName(id!)}`
        : goal.scope === "machine"
          ? ` för ${machineName(id!)}`
          : ""
    }`;
    const goalDataStart = dataStartOf(goal);
    /** Dagar i perioden att dela med: bara dagar från första dagen med data. */
    const rateDays = (period: Period): number =>
      input.dataStart === undefined ? periodDays(period) : measuredDaysIn(period, goalDataStart);
    const scopeIds = {
      storeIds: goal.scope === "store" ? [id!] : [],
      machineIds: goal.scope === "machine" ? [id!] : [],
    };

    let actual: number;
    let forecast: number;
    let method: ForecastMethod;
    let averagePerDay: number | null = null;
    let trailingWindowDays = opts.trailingDays;
    let requiredPerDay: number | null = null;
    let unpriced = 0;
    let evidenceMachineIds: string[] = scopeIds.machineIds;
    const evidenceOrderIds: string[] = [];
    const evidenceDates: IsoDate[] = [];
    const figures = [
      fig("target", "Mål", goal.target, goal.metric === "active_machines" ? "count" : "ore"),
    ];

    if (goal.metric === "active_machines") {
      const filter = { storeId: goal.storeId, machineId: goal.machineId };
      const nowIds = started
        ? activeMachinesOn(input.placements, finished ? end : (today ?? asOf), filter)
        : [];
      const endIds = activeMachinesOn(input.placements, end, filter);
      actual = nowIds.length;
      forecast = finished ? actual : endIds.length;
      method = finished ? "final" : "placements";
      evidenceMachineIds = [...new Set([...nowIds, ...endIds])];
      figures.push(
        fig("actual", "Automater i drift nu", actual, "count"),
        fig("forecast", "Automater i drift vid månadens slut", forecast, "count"),
      );
    } else {
      const measured = through === null ? null : moneyValue(goal, { start, end: through });
      if (through !== null) {
        const t = trail(goal, { start, end: through });
        evidenceOrderIds.push(...t.orderIds);
        evidenceDates.push(...t.dates);
      }
      actual = measured?.value ?? 0;
      unpriced = goal.metric === "profit" ? (measured?.unpriced ?? 0) : 0;
      // Dagar med data i månaden hittills (före första ordern fanns ingen automat).
      const measuredInMonth = through === null ? 0 : rateDays({ start, end: through });
      if (measuredInMonth > 0) averagePerDay = roundHalfUp(actual, measuredInMonth);
      if (finished) {
        forecast = actual;
        method = "final";
      } else if (measuredInMonth >= opts.minElapsedDays && measuredInMonth > 0) {
        forecast = actual + mulDivRound(actual, remaining, measuredInMonth);
        method = "run-rate";
      } else {
        const window = { start: addDays(lastDay, -(opts.trailingDays - 1)), end: lastDay };
        const windowDays = rateDays(window);
        const trailing = windowDays > 0 ? moneyValue(goal, window).value : 0;
        if (windowDays > 0) {
          const t = trail(goal, window);
          evidenceOrderIds.push(...t.orderIds);
          evidenceDates.push(...t.dates);
        }
        forecast = actual + (windowDays > 0 ? mulDivRound(trailing, remaining, windowDays) : 0);
        method = "trailing";
        trailingWindowDays = windowDays;
        figures.push(
          fig("trailingValue", `Utfall senaste ${windowDays} dagarna`, trailing, "ore"),
          fig("trailingDays", "Dagar i snittet", windowDays, "days"),
        );
      }
      if (remaining > 0) requiredPerDay = Math.max(0, ceilDiv(goal.target - actual, remaining));
      figures.push(
        fig("actual", "Utfall hittills", actual, "ore"),
        fig("forecast", "Prognos för månaden", forecast, "ore"),
        fig("elapsedDays", "Dagar som gått", elapsed, "days"),
        fig("remainingDays", "Dagar kvar", remaining, "days"),
      );
      if (unpriced > 0)
        figures.push(fig("unpricedOrders", "Order utan inköpspris", unpriced, "count"));
    }

    const gap = forecast - goal.target;
    const status: GoalStatus = finished
      ? actual >= goal.target
        ? "met"
        : "missed"
      : forecast >= goal.target
        ? "on-track"
        : "behind";
    const progressBp = ratioBp(actual, goal.target);
    const isMoney = goal.metric !== "active_machines";
    const val = (v: number) => (isMoney ? kr(v) : String(v));

    let text: string;
    let detail: string;
    if (finished) {
      const diff =
        status === "met" ? "målet nått" : `målet missat med ${val(goal.target - actual)}`;
      const pctPart =
        isMoney && goal.target !== 0
          ? ` (${signedPct(mulDivRound(actual - goal.target, 10_000, Math.abs(goal.target)))})`
          : "";
      text = `${label}: ${val(actual)} av ${val(goal.target)}, ${diff}${pctPart}.`;
      detail = isMoney
        ? `Hela månaden, ${plural(dim, "dag", "dagar")}.`
        : sentence(`Antal placerade automater ${day(end)}`);
    } else if (!isMoney) {
      const state = status === "on-track" ? "i fas" : `efter med ${val(goal.target - forecast)}`;
      const progress = started
        ? `${val(actual)} av ${val(goal.target)}`
        : `månaden har inte börjat, mål ${val(goal.target)}`;
      text = `${label}: ${progress}. Prognos ${val(forecast)} vid månadens slut, ${state}.`;
      detail = "Prognosen bygger på kända placeringar till och med månadens sista dag.";
    } else {
      const state = status === "on-track" ? "i fas" : `efter med ${val(goal.target - forecast)}`;
      const progress = started
        ? `${val(actual)} av ${val(goal.target)} efter ${elapsed} av ${dim} dagar`
        : `månaden har inte börjat, mål ${val(goal.target)}`;
      text = `${label}: ${progress}. Prognos ${val(forecast)}, ${state}.`;
      const basis =
        method === "run-rate"
          ? `snittet hittills, ${kr(averagePerDay ?? 0)} per dag`
          : trailingWindowDays === opts.trailingDays
            ? `snittet de senaste ${opts.trailingDays} dagarna`
            : `snittet per dag sedan första ordern (${trailingWindowDays} dagar)`;
      const need =
        requiredPerDay !== null && status === "behind"
          ? ` Behöver ${kr(requiredPerDay)} per dag resten av månaden.`
          : "";
      detail = `Prognosen bygger på ${basis}.${need}`;
      if (unpriced > 0) {
        detail += ` ${plural(unpriced, "order", "order")} utan inköpspris ingår inte i vinsten.`;
      }
    }

    out.push({
      goalId: goal.id,
      month: goal.month,
      metric: goal.metric,
      scope: goal.scope,
      scopeId: id,
      target: goal.target,
      actual,
      measuredThrough: through,
      elapsedDays: elapsed,
      daysInMonth: dim,
      remainingDays: remaining,
      forecast,
      forecastMethod: method,
      status,
      gap,
      progressBp,
      averagePerDay,
      requiredPerDay,
      unpricedOrders: unpriced,
      text,
      detail,
      evidence: scenarioEvidence({
        rule:
          goal.metric === "active_machines"
            ? "Automater i drift = automater placerade i en butik dagen; prognosen = antalet månadens sista dag enligt placeringarna."
            : "Utfall enligt lönsamheten till och med sista hela dagen (i dag räknas inte); prognos = utfall + snitt per dag × dagar kvar (snittet hittills efter minst 7 dagar med data, annars de senaste 28 dagarna). Dagar före första ordern räknas inte.",
        period: through === null ? null : { start, end: through },
        storeIds: scopeIds.storeIds,
        machineIds: evidenceMachineIds,
        orderIds: evidenceOrderIds,
        dates: evidenceDates,
        figures,
      }),
    });
  }

  return out.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    if (a.metric !== b.metric) return METRIC_ORDER[a.metric] - METRIC_ORDER[b.metric];
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    return a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0;
  });
}
