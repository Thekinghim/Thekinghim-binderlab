/**
 * Effekt av Binderlab: nyckeltal per månad jämfört med utgångsläget (baselines), med
 * förbättring i procent och kronor.
 *
 * Mått och riktning:
 *
 * | Mått                       | Enhet   | Bättre | Värde per månad                                               |
 * | -------------------------- | ------- | ------ | ------------------------------------------------------------- |
 * | profit_per_machine_month   | öre     | högre  | räknas: vinst / automatmånader (se nedan)                     |
 * | stockout_days_month        | dagar   | lägre  | mätvärde (`observations`)                                     |
 * | refill_hours_month         | minuter | lägre  | mätvärde (`observations`)                                     |
 * | admin_hours_month          | minuter | lägre  | mätvärde (`observations`)                                     |
 *
 * Vinst per automat och månad = round(vinst × dagar i månaden / automatdagar), där vinsten
 * är lönsamhetens vinst för månaden (till och med `asOf` om månaden pågår) och automatdagar
 * = Σ dagar varje automat var placerad i en butik. Hela månaden med en automat ger alltså
 * exakt månadens vinst.
 *
 * Förbättring (positiv = bättre):
 * - högre är bättre: värde − utgångsläge; lägre är bättre: utgångsläge − värde.
 * - i procent: round(förbättring × 10 000 / |utgångsläge|) bp, `null` när utgångsläget är 0.
 * - i kronor:
 *   - vinst: förbättring per automatmånad × automatmånader i månaden,
 *   - tid: minuter × timkostnad / 60 (bara om `hourlyCostOre` anges),
 *   - slutsålda dagar: dagar × värde per dag; anges inget värde används månadens vinst per
 *     automat och dag (uppskattning, minst 0).
 */

import {
  changeBp,
  DomainError,
  intersectPeriods,
  minDate,
  monthEnd,
  monthStart,
  mulDivRound,
  parseIsoMonth,
  periodDays,
  profitabilityViews,
  roundHalfUp,
  type EconomicsSources,
  type IsoDate,
  type IsoMonth,
  type OrderLine,
  type Period,
  type ProfitabilityResult,
} from "@/domain";
import { MINUS, NBSP } from "@/lib/format";
import { nameLookup } from "../todos/common";
import { kr, monthName } from "../todos/text";
import { fig, scenarioEvidence, signedKr, type ScenarioEvidence } from "../expansion/common";

/** Mått i utgångsläget (baselines.metric). */
export type BaselineMetric =
  | "profit_per_machine_month"
  | "stockout_days_month"
  | "refill_hours_month"
  | "admin_hours_month";

/** Enhet (baselines.unit). */
export type BaselineUnit = "ore" | "days" | "minutes" | "count";

/** Omfattning. */
export type EffectScope = "organization" | "store" | "machine";

/** Utgångsläget före Binderlab. */
export interface Baseline {
  readonly id: string;
  readonly metric: BaselineMetric;
  /** Heltal i `unit`. */
  readonly value: number;
  readonly unit: BaselineUnit;
  readonly scope: EffectScope;
  readonly storeId?: string | null;
  readonly machineId?: string | null;
  /** Perioden utgångsläget mättes under. */
  readonly measuredPeriod?: Period | null;
  /** Varifrån värdet kommer, t.ex. "Egen uppskattning, sommaren 2026". */
  readonly source?: string | null;
}

/** Ett mätvärde för en månad (för mått som inte räknas ur order). */
export interface EffectObservation {
  readonly metric: Exclude<BaselineMetric, "profit_per_machine_month">;
  readonly month: IsoMonth;
  /** Heltal i samma enhet som utgångsläget. */
  readonly value: number;
  readonly scope: EffectScope;
  readonly storeId?: string | null;
  readonly machineId?: string | null;
  /** Dagarna som ligger bakom värdet (t.ex. de slutsålda dagarna), för länkning. */
  readonly dates?: readonly IsoDate[];
  readonly machineIds?: readonly string[];
}

/** Inställningar. */
export interface EffectOptions {
  /** Timkostnad i öre, för att räkna tid i kronor. `null` = tid visas bara i tid. */
  readonly hourlyCostOre?: number | null;
  /** Värde per undviken slutsåld dag i öre. Utan värde: månadens vinst per automat och dag. */
  readonly stockoutDayValueOre?: number | null;
}

/** Indata till `binderlabEffect`. */
export interface EffectInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly baselines: readonly Baseline[];
  readonly observations?: readonly EffectObservation[];
  /** Månader att jämföra. */
  readonly months: readonly IsoMonth[];
  /** Sista dag med data. Månader efter den hoppas över; en pågående månad räknas till och med den. */
  readonly asOf?: IsoDate;
  readonly stores?: readonly { id: string; name: string }[];
  readonly machines?: readonly { id: string; name: string }[];
  readonly options?: EffectOptions;
}

/** Ett måttvärde för en månad. */
export interface EffectPoint {
  readonly month: IsoMonth;
  /** `null` när värde saknas (inga automatdagar eller inget mätvärde). */
  readonly value: number | null;
  /** Sant när månaden pågår (`asOf` i månaden). */
  readonly partial: boolean;
  /** Förbättring i måttets enhet, positiv = bättre. */
  readonly improvement: number | null;
  readonly improvementBp: number | null;
  /** Förbättringen i kronor för månaden (öre). `null` när den inte kan räknas. */
  readonly improvementOre: number | null;
  /** Automatdagar i månaden (för vinst och slutsålda dagar). */
  readonly machineDays: number;
  readonly evidence: ScenarioEvidence;
}

/** Effekten för ett utgångsläge över tid. */
export interface EffectSeries {
  readonly baselineId: string;
  readonly metric: BaselineMetric;
  readonly scope: EffectScope;
  readonly scopeId: string | null;
  readonly unit: BaselineUnit;
  readonly baseline: number;
  readonly higherIsBetter: boolean;
  readonly points: EffectPoint[];
  /** Senaste månaden med värde. */
  readonly latest: EffectPoint | null;
  /** Snitt av månaderna med värde, avrundat. */
  readonly averageValue: number | null;
  readonly averageImprovementBp: number | null;
  /** Σ förbättring i kronor över månaderna (där den kan räknas). */
  readonly totalImprovementOre: number | null;
  readonly text: string;
  readonly detail: string;
  readonly evidence: ScenarioEvidence;
}

const EXPECTED_UNIT: Record<BaselineMetric, BaselineUnit> = {
  profit_per_machine_month: "ore",
  stockout_days_month: "days",
  refill_hours_month: "minutes",
  admin_hours_month: "minutes",
};

const METRIC_NAME: Record<BaselineMetric, string> = {
  profit_per_machine_month: "Vinst per automat",
  stockout_days_month: "Slutsålda dagar",
  refill_hours_month: "Tid för påfyllning",
  admin_hours_month: "Tid för administration",
};

/** Minuter som text: 200 → "3 h 20 min", 60 → "1 h", 45 → "45 min". */
export function minutesText(minutes: number): string {
  const sign = minutes < 0 ? MINUS : "";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs - h * 60;
  if (h === 0) return `${sign}${m}${NBSP}min`;
  if (m === 0) return `${sign}${h}${NBSP}h`;
  return `${sign}${h}${NBSP}h ${m}${NBSP}min`;
}

function valueText(metric: BaselineMetric, value: number): string {
  switch (EXPECTED_UNIT[metric]) {
    case "ore":
      return kr(value);
    case "minutes":
      return minutesText(value);
    default:
      return String(value);
  }
}

/** "+23 %", "67 % färre", "33 % mindre". */
function improvementPctText(metric: BaselineMetric, bp: number): string {
  const whole = Math.abs(roundHalfUp(bp, 100));
  if (metric === "profit_per_machine_month") return `${bp < 0 ? MINUS : "+"}${whole}${NBSP}%`;
  const better = bp >= 0;
  if (metric === "stockout_days_month") return `${whole}${NBSP}% ${better ? "färre" : "fler"}`;
  return `${whole}${NBSP}% ${better ? "mindre" : "mer"}`;
}

function scopeKey(scope: EffectScope, storeId?: string | null, machineId?: string | null) {
  if (scope === "store") return storeId ?? "";
  if (scope === "machine") return machineId ?? "";
  return "";
}

/** Automatdagar per omfattning i perioden, och vilka automater. */
function machineDaysIn(
  placements: EconomicsSources["placements"],
  period: Period,
  scope: EffectScope,
  id: string | null,
): { days: number; machineIds: string[] } {
  let days = 0;
  const ids = new Set<string>();
  for (const p of placements) {
    if (scope === "store" && p.storeId !== id) continue;
    if (scope === "machine" && p.machineId !== id) continue;
    const end = p.to ?? (p.from > period.end ? p.from : period.end);
    const overlap = intersectPeriods(period, { start: p.from, end });
    if (!overlap) continue;
    days += periodDays(overlap);
    ids.add(p.machineId);
  }
  return { days, machineIds: [...ids].sort() };
}

/**
 * Effekten per utgångsläge och månad. Se reglerna överst i filen. Serierna kommer i samma
 * ordning som `baselines`, punkterna i månadsordning.
 */
export function binderlabEffect(input: EffectInput): EffectSeries[] {
  const opts = input.options ?? {};
  const hourly = opts.hourlyCostOre ?? null;
  const stockoutValue = opts.stockoutDayValueOre ?? null;
  for (const [v, label] of [
    [hourly, "Timkostnaden"],
    [stockoutValue, "Värdet per slutsåld dag"],
  ] as const) {
    if (v !== null && (!Number.isSafeInteger(v) || v < 0)) {
      throw new DomainError("invalid_amount", `${label} måste vara ett heltal i öre ≥ 0.`);
    }
  }
  const months = [...new Set(input.months)].sort();
  for (const m of months) parseIsoMonth(m);
  const asOf = input.asOf ?? null;
  const storeName = nameLookup(input.stores ?? []);
  const machineName = nameLookup(input.machines ?? []);

  // Mätperiod per månad (hoppar över månader efter asOf).
  const monthPeriods = new Map<IsoMonth, { period: Period; partial: boolean }>();
  for (const m of months) {
    const start = monthStart(m);
    const end = monthEnd(m);
    if (asOf !== null && asOf < start) continue;
    const last = asOf === null ? end : minDate(end, asOf);
    monthPeriods.set(m, { period: { start, end: last }, partial: last < end });
  }

  const cache = new Map<IsoMonth, Record<"store" | "machine", ProfitabilityResult>>();
  const views = (m: IsoMonth) => {
    let v = cache.get(m);
    if (!v) {
      v = profitabilityViews({ ...input, period: monthPeriods.get(m)!.period }, [
        "store",
        "machine",
      ]);
      cache.set(m, v);
    }
    return v;
  };
  const profitIn = (m: IsoMonth, scope: EffectScope, id: string | null): number => {
    const v = views(m);
    if (scope === "organization") return v.store.totals.profitOre;
    const rows = scope === "store" ? v.store.rows : v.machine.rows;
    return rows.find((r) => r.kind === "item" && r.key === id)?.profitOre ?? 0;
  };

  // Mätvärden per (mått, omfattning, månad).
  const obs = new Map<string, EffectObservation>();
  for (const o of input.observations ?? []) {
    parseIsoMonth(o.month);
    if (!Number.isSafeInteger(o.value)) {
      throw new DomainError("invalid_amount", `Mätvärdet för ${o.metric} ${o.month} måste vara ett heltal.`);
    }
    const key = `${o.metric}|${o.scope}|${scopeKey(o.scope, o.storeId, o.machineId)}|${o.month}`;
    if (obs.has(key)) {
      throw new DomainError("invalid_input", `Två mätvärden för ${o.metric} ${o.month}.`);
    }
    obs.set(key, o);
  }

  return input.baselines.map((b) => {
    if (EXPECTED_UNIT[b.metric] !== b.unit) {
      throw new DomainError(
        "invalid_input",
        `Utgångsläget ${b.id} (${b.metric}) ska anges i ${EXPECTED_UNIT[b.metric]}, inte ${b.unit}.`,
      );
    }
    if (!Number.isSafeInteger(b.value)) {
      throw new DomainError("invalid_amount", `Utgångsläget ${b.id} måste vara ett heltal.`);
    }
    if (b.scope === "store" && !b.storeId) {
      throw new DomainError("invalid_input", `Utgångsläget ${b.id} saknar butik.`);
    }
    if (b.scope === "machine" && !b.machineId) {
      throw new DomainError("invalid_input", `Utgångsläget ${b.id} saknar automat.`);
    }
    const id = b.scope === "store" ? b.storeId! : b.scope === "machine" ? b.machineId! : null;
    const higher = b.metric === "profit_per_machine_month";
    const scopeLabel =
      b.scope === "store"
        ? ` för ${storeName(id!)}`
        : b.scope === "machine"
          ? ` för ${machineName(id!)}`
          : "";
    const name = `${METRIC_NAME[b.metric]}${scopeLabel}`;

    const points: EffectPoint[] = [];
    for (const m of months) {
      const mp = monthPeriods.get(m);
      if (!mp) continue;
      const dim = periodDays({ start: monthStart(m), end: monthEnd(m) });
      const md = machineDaysIn(input.placements, mp.period, b.scope, id);
      let value: number | null = null;
      let improvementOre: number | null = null;
      const figures = [fig("baseline", "Utgångsläge", b.value, b.unit)];
      let dates: readonly IsoDate[] = [];
      let machineIds: readonly string[] = md.machineIds;

      if (b.metric === "profit_per_machine_month") {
        const profit = profitIn(m, b.scope, id);
        figures.push(
          fig("profitOre", "Vinst i månaden", profit, "ore"),
          fig("machineDays", "Automatdagar", md.days, "days"),
        );
        if (md.days > 0) {
          value = mulDivRound(profit, dim, md.days);
          // Förbättring per automatmånad × automatmånader (= automatdagar / dagar i månaden).
          improvementOre = mulDivRound(value - b.value, md.days, dim);
        }
      } else {
        const o = obs.get(`${b.metric}|${b.scope}|${scopeKey(b.scope, b.storeId, b.machineId)}|${m}`);
        if (o) {
          value = o.value;
          dates = o.dates ?? [];
          if (o.machineIds) machineIds = o.machineIds;
          const improvement = b.value - o.value;
          if (b.metric === "stockout_days_month") {
            let perDay = stockoutValue;
            if (perDay === null && md.days > 0) {
              perDay = Math.max(0, roundHalfUp(profitIn(m, b.scope, id), md.days));
              figures.push(fig("stockoutDayValueOre", "Vinst per automat och dag (värde per dag)", perDay, "ore"));
            }
            improvementOre = perDay === null ? null : improvement * perDay;
          } else if (hourly !== null) {
            improvementOre = mulDivRound(improvement, hourly, 60);
            figures.push(fig("hourlyCostOre", "Timkostnad", hourly, "ore"));
          }
        }
      }

      const improvement = value === null ? null : higher ? value - b.value : b.value - value;
      const improvementBp =
        value === null || b.value === 0
          ? null
          : higher
            ? changeBp(value, b.value)
            : mulDivRound(b.value - value, 10_000, Math.abs(b.value));
      if (value !== null) figures.push(fig("value", "Värde i månaden", value, b.unit));
      if (improvementOre !== null) figures.push(fig("improvementOre", "Förbättring i kronor", improvementOre, "ore"));

      points.push({
        month: m,
        value,
        partial: mp.partial,
        improvement,
        improvementBp,
        improvementOre,
        machineDays: md.days,
        evidence: scenarioEvidence({
          rule:
            b.metric === "profit_per_machine_month"
              ? "Vinst per automat och månad = vinst × dagar i månaden / automatdagar, jämfört med utgångsläget."
              : `${METRIC_NAME[b.metric]} enligt mätvärdet för månaden, jämfört med utgångsläget.`,
          period: mp.period,
          dates,
          storeIds: b.scope === "store" ? [id!] : [],
          machineIds,
          figures,
        }),
      });
    }

    const withValue = points.filter((p) => p.value !== null);
    const latest = withValue[withValue.length - 1] ?? null;
    const averageValue =
      withValue.length === 0
        ? null
        : roundHalfUp(
            withValue.reduce((s, p) => s + p.value!, 0),
            withValue.length,
          );
    const averageImprovementBp =
      averageValue === null || b.value === 0
        ? null
        : higher
          ? changeBp(averageValue, b.value)
          : mulDivRound(b.value - averageValue, 10_000, Math.abs(b.value));
    const oreParts = withValue.filter((p) => p.improvementOre !== null);
    const totalImprovementOre =
      oreParts.length === 0 ? null : oreParts.reduce((s, p) => s + p.improvementOre!, 0);

    let text: string;
    let detail: string;
    if (!latest) {
      text = `${name}: inga värden ännu att jämföra med utgångsläget ${valueText(b.metric, b.value)}.`;
      detail =
        b.metric === "profit_per_machine_month"
          ? "Ingen automat var placerad under månaderna."
          : "Lägg in mätvärden per månad.";
    } else {
      const unitSuffix = b.metric === "profit_per_machine_month" ? " per månad" : "";
      const pctPart =
        latest.improvementBp === null ? "" : improvementPctText(b.metric, latest.improvementBp);
      const krPart =
        b.metric === "profit_per_machine_month" && latest.improvement !== null
          ? `${signedKr(latest.improvement)} per automat och månad`
          : latest.improvementOre !== null
            ? `värt ${signedKr(latest.improvementOre)}`
            : "";
      const paren = [pctPart, krPart].filter((s) => s !== "").join(", ");
      text = `${name}: ${valueText(b.metric, latest.value!)}${unitSuffix} i ${monthName(latest.month)}${
        latest.partial ? " (hittills)" : ""
      } mot ${valueText(b.metric, b.value)} före Binderlab${paren ? ` (${paren})` : ""}.`;
      const parts: string[] = [];
      if (withValue.length > 1) {
        parts.push(
          `Snitt ${valueText(b.metric, averageValue!)} över ${withValue.length} månader`,
        );
      }
      if (totalImprovementOre !== null) {
        parts.push(`sammanlagt ${signedKr(totalImprovementOre)} sedan ${monthName(withValue[0]!.month)}`);
      }
      if (b.metric !== "profit_per_machine_month" && b.metric !== "stockout_days_month" && hourly === null) {
        parts.push("ange timkostnad för att räkna tiden i kronor");
      }
      if (b.metric === "stockout_days_month" && stockoutValue === null) {
        parts.push("kronor uppskattade med vinst per automat och dag");
      }
      detail = parts.length === 0 ? "" : `${parts.join(", ").replace(/^./, (c) => c.toUpperCase())}.`;
    }

    return {
      baselineId: b.id,
      metric: b.metric,
      scope: b.scope,
      scopeId: id,
      unit: b.unit,
      baseline: b.value,
      higherIsBetter: higher,
      points,
      latest,
      averageValue,
      averageImprovementBp,
      totalImprovementOre,
      text,
      detail,
      evidence: scenarioEvidence({
        rule: `Jämförelse mot utgångsläget${b.source ? ` (${b.source})` : ""}; positiv förbättring = bättre.`,
        period: b.measuredPeriod ?? null,
        storeIds: b.scope === "store" ? [id!] : [],
        machineIds: b.scope === "machine" ? [id!] : [],
        figures: [
          fig("baseline", "Utgångsläge", b.value, b.unit),
          ...(averageValue === null
            ? []
            : [fig("averageValue", "Snitt", averageValue, b.unit)]),
          ...(totalImprovementOre === null
            ? []
            : [fig("totalImprovementOre", "Förbättring i kronor, sammanlagt", totalImprovementOre, "ore")]),
        ],
      }),
    };
  });
}
