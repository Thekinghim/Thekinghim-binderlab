/**
 * Larmregler. Varje regel är en ren funktion som ger kandidater (AlertCandidate) med stabil
 * incidentnyckel, svensk text och underlag. Dedupliceringen över tid sköts av reconcileAlerts.
 */

import { assortmentKey } from "../todos/assortment";
import {
  addDays,
  dailyUnits,
  dayOfWeek,
  daysOfStockLeft,
  DomainError,
  roundHalfUp,
  salesVelocity,
  stockoutDate,
  type IsoDate,
} from "@/domain";
import { evidence, isMachineActive, links, nameLookup } from "@/analytics/todos/common";
import {
  plural,
  ratioTenths,
  sentence,
  tenths,
  weekdayDay,
  weekdayPlural,
} from "@/analytics/todos/text";
import { businessDateAt, DEFAULT_TIME_ZONE, parseInstant } from "@/analytics/todos/time";
import type { AnalyticsOrder, MachineRef, StockLevelRef, TitleRef } from "@/analytics/todos/types";
import type { MachineHealth } from "@/analytics/health/types";
import { poissonCdf, poissonSf, probabilityToBp } from "@/analytics/health/poisson";
import { durationText, probabilityText, whenText } from "@/analytics/health/text";
import type {
  AlertCandidate,
  AlertEvidence,
  AlertGroup,
  AlertKind,
  AlertSeverity,
  DataSourceRef,
  DayForecast,
  ImportRunRef,
} from "./types";

/** Familj per larmtyp. */
export const ALERT_GROUP: Record<AlertKind, AlertGroup> = {
  machine_suspected_fault: "machine",
  machine_fault: "machine",
  machine_offline: "machine",
  low_stock: "stock",
  import_failed: "import",
  day_anomaly: "sales",
  report_failed: "system",
  job_failed: "system",
  // Kommer från Awish-synken, som importerna.
  machine_discovered: "import",
  // Daglig kontroll: skrivs direkt av kontrollen och stängs när den går igenom.
  self_check: "system",
};

/** Rang för allvar: högre är allvarligare. */
export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Rang inom familjen machine: offline > fel > misstänkt fel. */
const KIND_RANK: Record<AlertKind, number> = {
  machine_offline: 3,
  machine_fault: 2,
  machine_suspected_fault: 1,
  low_stock: 0,
  import_failed: 0,
  day_anomaly: 0,
  report_failed: 0,
  job_failed: 0,
  machine_discovered: 0,
  self_check: 0,
};

const MINUTE_MS = 60_000;

/** Nyckel för automatens driftproblem: alla tre maskinlarm delar den. */
export function machineIncidentKey(machineId: string): string {
  return `machine:${machineId}`;
}

// ---------------------------------------------------------------------------
// Maskinhälsa
// ---------------------------------------------------------------------------

/**
 * Larm ur maskinhälsan:
 *   offline          → machine_offline, critical
 *   fault            → machine_fault, critical
 *   suspected_fault  → machine_suspected_fault, warning
 * Övriga statusar ger inget larm (tom automat larmas via lagerregeln).
 * Alla tre delar nyckeln 'machine:<id>', så att misstänkt fel som blir offline är en incident.
 */
export function healthAlerts(health: readonly MachineHealth[]): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  for (const h of health) {
    let kind: AlertKind;
    let severity: AlertSeverity;
    if (h.status === "offline") {
      kind = "machine_offline";
      severity = "critical";
    } else if (h.status === "fault") {
      kind = "machine_fault";
      severity = "critical";
    } else if (h.status === "suspected_fault") {
      kind = "machine_suspected_fault";
      severity = "warning";
    } else continue;
    out.push({
      key: machineIncidentKey(h.machineId),
      kind,
      severity,
      machineId: h.machineId,
      titleId: null,
      title: h.title,
      detail: h.detail,
      evidence: h.evidence,
      link: h.link,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Titel nära slut
// ---------------------------------------------------------------------------

/** Indata till lagerregeln. */
export interface LowStockInput {
  readonly orders: readonly AnalyticsOrder[];
  readonly stock: readonly StockLevelRef[];
  readonly machines: readonly MachineRef[];
  readonly titles: readonly TitleRef[];
  /**
   * Par (automat, titel) som gått ur sortimentet (utgår), som `assortmentKey` i
   * @/analytics/todos/assortment. De säljs ut och larmar aldrig (samma regel som Lager).
   */
  readonly retired?: ReadonlySet<string>;
  readonly options?: {
    readonly timeZone?: string;
    /** Fönster för takten. Standard 14 dagar. */
    readonly windowDays?: number;
    /** Larm när lagret räcker högst så många hela dagar. Standard 2. */
    readonly thresholdDays?: number;
  };
}

/**
 * Titel nära slut i en automat:
 *   takt        = sålda pack de senaste `windowDays` hela dagarna t.o.m. i går
 *                 (domain.salesVelocity), samma fönster som påfyllningspunkterna i Att göra,
 *                 Lager och besöksplanen: dagen i dag är inte slut och skulle sänka takten
 *   dagar kvar  = golv(i lager / takt) (domain.daysOfStockLeft)
 *   slut        = domain.stockoutDate(i går, i lager, takt), samma som i Att göra
 *   i lager 0 och titeln har sålt i fönstret  → critical ("slut")
 *   dagar kvar ≤ thresholdDays                → warning
 * Titlar utan försäljning i fönstret larmar inte (de tar inte slut med nuvarande takt).
 * Titlar som gått ur automaten (`retired`, "Utgår" på Lager) larmar inte heller.
 * Nyckel: 'low_stock:<automat>:<titel>'.
 */
export function lowStockAlerts(
  input: LowStockInput,
  now: Date | string | number,
): AlertCandidate[] {
  const tz = input.options?.timeZone ?? DEFAULT_TIME_ZONE;
  const windowDays = input.options?.windowDays ?? 14;
  const thresholdDays = input.options?.thresholdDays ?? 2;
  if (
    !Number.isSafeInteger(windowDays) ||
    windowDays < 1 ||
    !Number.isSafeInteger(thresholdDays) ||
    thresholdDays < 0
  ) {
    throw new DomainError(
      "invalid_input",
      "Fönster och gräns för lagerlarm måste vara heltal ≥ 1 resp. ≥ 0.",
    );
  }
  const today = businessDateAt(now, tz);
  // Takten räknas på hela dagar t.o.m. i går (som Att göra); saldot är dagens.
  const asOf = addDays(today, -1);
  const machineName = nameLookup(input.machines);
  const titleName = nameLookup(input.titles);
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  const byPair = new Map<string, AnalyticsOrder[]>();
  for (const o of input.orders) {
    if (o.machineId === null || o.businessDate > asOf) continue;
    const k = `${o.machineId}\u0000${o.titleId}`;
    const list = byPair.get(k);
    if (list) list.push(o);
    else byPair.set(k, [o]);
  }
  const out: AlertCandidate[] = [];
  for (const s of input.stock) {
    const m = machines.get(s.machineId);
    if (!m || !isMachineActive(m, today)) continue;
    if (input.retired?.has(assortmentKey(s.machineId, s.titleId))) continue;
    const orders = byPair.get(`${s.machineId}\u0000${s.titleId}`) ?? [];
    const v = salesVelocity(dailyUnits(orders), {
      asOf,
      days: windowDays,
      ...(m.activeFrom !== null ? { activeFrom: m.activeFrom } : {}),
    });
    if (v.units === 0) continue;
    const onHand = Math.max(0, s.onHand);
    const daysLeft = daysOfStockLeft(onHand, v) ?? 0;
    if (onHand > 0 && daysLeft > thresholdDays) continue;
    const windowOrders = orders.filter((o) => o.businessDate >= v.start && o.businessDate <= v.end);
    const empty = onHand === 0;
    const end = stockoutDate(asOf, onHand, v);
    const rate = `${ratioTenths(v.units, v.days)} pack/dag (${v.units} pack på ${plural(v.days, "dag", "dagar")})`;
    const title = empty
      ? `${titleName(s.titleId)} är slut i ${machineName(m.id)}`
      : `${titleName(s.titleId)} i ${machineName(m.id)} tar slut ${
          // Samma uträkning som "Beräknat slut" i texten (stockoutDate), så att rubrik och text
          // aldrig säger olika saker.
          end === null
            ? `om ${plural(daysLeft, "dag", "dagar")}`
            : end <= today
              ? "i dag"
              : end === addDays(today, 1)
                ? "i morgon"
                : weekdayDay(end)
        }`;
    const detail = empty
      ? `0 pack kvar. Titeln säljer ${rate}.`
      : `${plural(onHand, "pack", "pack")} kvar, säljer ${rate}.${end ? ` ${sentence(`Beräknat slut ${weekdayDay(end)}`)}` : ""}`;
    out.push({
      key: `low_stock:${m.id}:${s.titleId}`,
      kind: "low_stock",
      severity: empty ? "critical" : "warning",
      machineId: m.id,
      titleId: s.titleId,
      title,
      detail,
      evidence: evidence({
        rule: `Larm när lagret räcker högst ${plural(thresholdDays, "dag", "dagar")} vid takten de senaste ${windowDays} dagarna, eller är slut.`,
        period: { start: v.start, end: v.end },
        orderIds: windowOrders.map((o) => o.id),
        dates: end ? [end] : [],
        titleIds: [s.titleId],
        machineIds: [m.id],
        figures: [
          { key: "onHand", label: "Pack i automaten", value: onHand, unit: "packs" },
          { key: "unitsInWindow", label: "Sålda pack i fönstret", value: v.units, unit: "packs" },
          { key: "windowDays", label: "Dagar i fönstret", value: v.days, unit: "days" },
          { key: "daysLeft", label: "Hela dagar kvar", value: daysLeft, unit: "days" },
        ],
      }),
      link: links.stock(m.id, s.titleId),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Indata till importregeln. */
export interface ImportAlertInput {
  readonly sources: readonly DataSourceRef[];
  readonly imports: readonly ImportRunRef[];
  readonly options?: {
    readonly timeZone?: string;
    /** En import som körts längre än så här räknas som hängd. Standard 60 minuter. */
    readonly stuckAfterMinutes?: number;
    /**
     * En schemalagd källa utan lyckad hämtning på så här många intervall larmar.
     * Standard 3 (gRPC var 5:e minut → 15 minuter, men minst `minStaleMinutes`).
     */
    readonly staleIntervals?: number;
    /** Minsta tid utan hämtning innan larm. Standard 60 minuter. */
    readonly minStaleMinutes?: number;
  };
}

function importTime(i: ImportRunRef): number {
  return parseInstant(i.finishedAt ?? i.startedAt ?? i.createdAt);
}

/**
 * Misslyckad import, per datakälla (nyckel 'import:<källa>', så att upprepade misslyckanden
 * blir en incident):
 *   senaste avslutade importen misslyckades                → critical
 *   källans status är 'error'                              → critical
 *   en import har kört längre än stuckAfterMinutes         → warning
 *   senaste importen lyckades men hade rader med fel       → warning
 *   schemalagd källa utan hämtning på staleIntervals × intervallet (minst minStaleMinutes) → warning
 * Pausade källor larmar inte. En lyckad import utan fel efter ett misslyckande löser incidenten.
 */
export function importAlerts(
  input: ImportAlertInput,
  now: Date | string | number,
): AlertCandidate[] {
  const nowMs = parseInstant(now);
  const tz = input.options?.timeZone ?? DEFAULT_TIME_ZONE;
  const stuckAfter = input.options?.stuckAfterMinutes ?? 60;
  const staleIntervals = input.options?.staleIntervals ?? 3;
  const minStale = input.options?.minStaleMinutes ?? 60;
  const out: AlertCandidate[] = [];
  for (const src of input.sources) {
    if (src.status === "paused") continue;
    const runs = input.imports
      .filter((i) => i.dataSourceId === src.id && importTime(i) <= nowMs)
      .sort((a, b) => importTime(a) - importTime(b) || (a.id < b.id ? -1 : 1));
    const finished = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
    const last = finished[finished.length - 1];
    let consecutiveFailures = 0;
    for (let i = finished.length - 1; i >= 0 && finished[i]?.status === "failed"; i--)
      consecutiveFailures++;
    const failedRuns = finished.slice(finished.length - consecutiveFailures);
    const base = {
      key: `import:${src.id}`,
      kind: "import_failed" as const,
      machineId: null,
      titleId: null,
      // Datakällor (det finns ingen egen sida per källa); en misslyckad import länkar till
      // importens detaljsida nedan.
      link: "/datakallor",
    };
    const ev = (
      rule: string,
      runIds: string[],
      figures: { key: string; label: string; value: number }[],
    ): AlertEvidence => ({
      ...evidence({ rule, figures: figures.map((f) => ({ ...f, unit: "count" as const })) }),
      importIds: [...new Set(runIds)].sort(),
      dataSourceIds: [src.id],
    });

    if (last?.status === "failed") {
      const when = whenText(importTime(last), tz);
      const reason = last.message?.trim() ? ` Fel: ${last.message.trim()}` : "";
      out.push({
        ...base,
        link: `/datakallor/importer/${encodeURIComponent(last.id)}`,
        severity: "critical",
        title: `Import från ${src.name} misslyckades`,
        detail:
          consecutiveFailures > 1
            ? `${consecutiveFailures} misslyckade importer i rad, senast ${when}.${reason ? `${reason}.` : ""} Order efter senaste lyckade import saknas i siffrorna.`
            : `Importen ${when}${last.fileName ? ` (${last.fileName})` : ""} misslyckades.${reason ? `${reason}.` : ""} Order efter senaste lyckade import saknas i siffrorna.`,
        evidence: ev(
          "Larm när senaste avslutade import från källan misslyckades.",
          failedRuns.map((r) => r.id),
          [{ key: "consecutiveFailures", label: "Misslyckade i rad", value: consecutiveFailures }],
        ),
      });
      continue;
    }
    if (src.status === "error") {
      out.push({
        ...base,
        severity: "critical",
        title: `Datakällan ${src.name} har fel`,
        detail: "Källan är markerad med fel. Kontrollera inloggning och inställningar.",
        evidence: ev("Larm när datakällans status är fel.", [], []),
      });
      continue;
    }
    const stuck = runs.find(
      (r) =>
        r.status === "running" &&
        r.startedAt !== null &&
        nowMs - parseInstant(r.startedAt) > stuckAfter * MINUTE_MS,
    );
    if (stuck && stuck.startedAt) {
      const minutes = Math.floor((nowMs - parseInstant(stuck.startedAt)) / MINUTE_MS);
      out.push({
        ...base,
        severity: "warning",
        title: `Import från ${src.name} har hängt sig`,
        detail: `Importen startade ${whenText(parseInstant(stuck.startedAt), tz)} och har kört i ${durationText(minutes)}.`,
        evidence: ev(
          `Larm när en import kört längre än ${stuckAfter} minuter.`,
          [stuck.id],
          [{ key: "runningMinutes", label: "Minuter", value: minutes }],
        ),
      });
      continue;
    }
    if (last && last.status === "succeeded" && last.rowsError > 0) {
      out.push({
        ...base,
        severity: "warning",
        title: `${plural(last.rowsError, "rad", "rader")} kunde inte läsas från ${src.name}`,
        detail: `Importen ${whenText(importTime(last), tz)}: ${last.rowsError} av ${last.rowsTotal} rader hade fel. De orderna saknas i siffrorna tills de rättats.`,
        evidence: ev(
          "Larm när senaste import hade rader med fel.",
          [last.id],
          [
            { key: "rowsError", label: "Rader med fel", value: last.rowsError },
            { key: "rowsTotal", label: "Rader totalt", value: last.rowsTotal },
          ],
        ),
      });
      continue;
    }
    const interval = src.expectedIntervalMinutes ?? null;
    if (src.manual && interval !== null && interval > 0) {
      // Manuell uppladdning: datat är gammalt när den senaste importerade försäljningen är
      // äldre än intervallet. En källa som aldrig haft försäljning bedöms inte.
      const dataMs = src.dataUntil ? parseInstant(src.dataUntil) : null;
      const syncedMs = src.lastSyncedAt ? parseInstant(src.lastSyncedAt) : null;
      if (dataMs !== null && nowMs - dataMs > interval * MINUTE_MS) {
        const minutes = Math.floor((nowMs - dataMs) / MINUTE_MS);
        const uploadedAfter = syncedMs !== null && syncedMs > dataMs;
        out.push({
          ...base,
          severity: "warning",
          title: `Försäljningen från ${src.name} är inte importerad sedan ${whenText(dataMs, tz)}`,
          detail: uploadedAfter
            ? `Senaste uppladdningen ${whenText(syncedMs, tz)} innehöll ingen nyare försäljning. Kontrollera att filen är den senaste exporten, eller om alla automater i källan står still.`
            : `Ingen fil är uppladdad sedan dess. Ladda upp den senaste exporten; tills dess bedöms automaterna bara fram till ${whenText(dataMs, tz)}.`,
          evidence: ev(
            `Larm när den senaste importerade försäljningen från en källa som laddas upp för hand är äldre än ${durationText(interval)}.`,
            [],
            [
              {
                key: "minutesSinceData",
                label: "Minuter sedan senaste försäljning",
                value: minutes,
              },
            ],
          ),
        });
      }
    } else if (interval !== null && interval > 0) {
      const limit = Math.max(minStale, interval * staleIntervals);
      const lastOk = src.lastSyncedAt ? parseInstant(src.lastSyncedAt) : null;
      if (lastOk === null || nowMs - lastOk > limit * MINUTE_MS) {
        const minutes = lastOk === null ? null : Math.floor((nowMs - lastOk) / MINUTE_MS);
        out.push({
          ...base,
          severity: "warning",
          title: `Ingen hämtning från ${src.name} på ${minutes === null ? "lång tid" : durationText(minutes)}`,
          detail:
            lastOk === null
              ? `Källan har aldrig hämtats. Den ska hämtas var ${interval}:e minut.`
              : `Senaste lyckade hämtning ${whenText(lastOk, tz)}. Den ska hämtas var ${interval}:e minut.`,
          evidence: ev(
            `Larm när en schemalagd källa inte hämtats på ${limit} minuter.`,
            [],
            minutes === null
              ? []
              : [{ key: "minutesSinceSync", label: "Minuter sedan hämtning", value: minutes }],
          ),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Avvikande dag
// ---------------------------------------------------------------------------

/** Indata till regeln om avvikande dag. */
export interface DayAnomalyInput {
  readonly orders: readonly AnalyticsOrder[];
  readonly machines: readonly MachineRef[];
  /** Dagen som bedöms. Standard: i går (en hel dag). */
  readonly date?: IsoDate;
  /** Prognoser som ersätter historiken, per 'all' eller automat. */
  readonly forecasts?: readonly DayForecast[];
  readonly options?: {
    readonly timeZone?: string;
    /** Veckor med samma veckodag att jämföra med. Standard 8. */
    readonly weeks?: number;
    /** Minsta antal jämförelsedagar. Standard 4. */
    readonly minWeeks?: number;
    /** Minsta förväntade antal pack för att bedöma. Standard 5. */
    readonly minExpected?: number;
    /** Gräns för sannolikheten (en sida), i bp. Standard 100 (= 1 %). */
    readonly probabilityBp?: number;
    /** Minsta avvikelse från förväntat, i bp. Standard 3 000 (= 30 %). */
    readonly minDeviationBp?: number;
    /** Bedöm även varje automat (inte bara hela organisationen). Standard true. */
    readonly perMachine?: boolean;
  };
}

/**
 * Ovanligt låg eller hög försäljning en hel dag, jämfört med prognos eller historik:
 *   förväntat λ = prognosen för dagen, annars snittet av samma veckodag de `weeks` veckorna före
 *                 (bara veckor då automaten var i drift; minst `minWeeks`)
 *   låg   ⇔ P(X ≤ utfall) < gränsen och utfall ≤ λ × (1 − minDeviation)   → warning
 *   hög   ⇔ P(X ≥ utfall) < gränsen och utfall ≥ λ × (1 + minDeviation)   → info
 *   bedöms bara när λ ≥ minExpected
 * Engångslarm med nyckel 'day_anomaly:<all|automat>:<datum>'.
 */
export function dayAnomalyAlerts(
  input: DayAnomalyInput,
  now: Date | string | number,
): AlertCandidate[] {
  const o = input.options ?? {};
  const tz = o.timeZone ?? DEFAULT_TIME_ZONE;
  const weeks = o.weeks ?? 8;
  const minWeeks = o.minWeeks ?? 4;
  const minExpected = o.minExpected ?? 5;
  const probabilityBp = o.probabilityBp ?? 100;
  const minDeviationBp = o.minDeviationBp ?? 3_000;
  const today = businessDateAt(now, tz);
  const date = input.date ?? addDays(today, -1);
  if (date >= today) {
    throw new DomainError(
      "invalid_input",
      `Dagen ${date} är inte avslutad; bara hela dagar bedöms.`,
    );
  }
  const compareDates = Array.from({ length: weeks }, (_, i) => addDays(date, -7 * (i + 1)));

  type Scope = { id: string; name: string | null; machine: MachineRef | null };
  const scopes: Scope[] = [{ id: "all", name: null, machine: null }];
  if (o.perMachine ?? true) {
    for (const m of input.machines) {
      if (isMachineActive(m, date)) scopes.push({ id: m.id, name: m.name, machine: m });
    }
  }
  const countByScopeDate = new Map<string, number>();
  const ordersOnDate = new Map<string, string[]>();
  const relevant = new Set([date, ...compareDates]);
  for (const ord of input.orders) {
    if (!relevant.has(ord.businessDate)) continue;
    for (const scope of ord.machineId === null ? ["all"] : ["all", ord.machineId]) {
      const k = `${scope}\u0000${ord.businessDate}`;
      countByScopeDate.set(k, (countByScopeDate.get(k) ?? 0) + 1);
      if (ord.businessDate === date) {
        const list = ordersOnDate.get(scope);
        if (list) list.push(ord.id);
        else ordersOnDate.set(scope, [ord.id]);
      }
    }
  }
  const forecast = new Map(
    (input.forecasts ?? []).filter((f) => f.date === date).map((f) => [f.scope, f]),
  );

  const out: AlertCandidate[] = [];
  for (const scope of scopes) {
    const actual = countByScopeDate.get(`${scope.id}\u0000${date}`) ?? 0;
    const f = forecast.get(scope.id);
    let expectedTenths: number;
    let lambda: number;
    // Förväntat som bråk sum/n för exakta jämförelser.
    let num: number;
    let den: number;
    let basis: string;
    let usedDates: IsoDate[] = [];
    let range = "";
    if (f) {
      expectedTenths = f.expectedTenths;
      num = f.expectedTenths;
      den = 10;
      lambda = f.expectedTenths / 10;
      basis = "prognosen";
    } else {
      const m = scope.machine;
      usedDates = compareDates.filter(
        (d) =>
          !m ||
          ((m.activeFrom === null || d >= m.activeFrom) &&
            (m.activeTo === null || d <= m.activeTo)),
      );
      if (usedDates.length < minWeeks) continue;
      const counts = usedDates.map((d) => countByScopeDate.get(`${scope.id}\u0000${d}`) ?? 0);
      num = counts.reduce((a, b) => a + b, 0);
      den = usedDates.length;
      lambda = num / den;
      expectedTenths = roundHalfUp(num * 10, den);
      basis = `${weekdayPlural(dayOfWeek(date))} de senaste ${plural(den, "veckan", "veckorna")}`;
      range = `${Math.min(...counts)}–${Math.max(...counts)} pack, `;
    }
    if (lambda < minExpected) continue;
    // Avvikelse i heltal: actual × den × 10 000 jämfört med num × (10 000 ± minDeviation).
    const lowEnough = actual * den * 10_000 <= num * (10_000 - minDeviationBp);
    const highEnough = actual * den * 10_000 >= num * (10_000 + minDeviationBp);
    let direction: "low" | "high" | null = null;
    let pBp = 0;
    if (lowEnough) {
      pBp = probabilityToBp(poissonCdf(actual, lambda));
      if (pBp < probabilityBp) direction = "low";
    } else if (highEnough) {
      pBp = probabilityToBp(poissonSf(actual, lambda));
      if (pBp < probabilityBp) direction = "high";
    }
    if (!direction) continue;
    const where = scope.name ? ` i ${scope.name}` : "";
    const expText = tenths(expectedTenths);
    const devBp = num === 0 ? 0 : roundHalfUp((actual * den - num) * 10_000, num);
    out.push({
      key: `day_anomaly:${scope.id}:${date}`,
      kind: "day_anomaly",
      severity: direction === "low" ? "warning" : "info",
      machineId: scope.machine?.id ?? null,
      titleId: null,
      title:
        direction === "low"
          ? `Ovanligt låg försäljning${where} ${weekdayDay(date)}: ${actual} pack, normalt ${expText}`
          : `Ovanligt hög försäljning${where} ${weekdayDay(date)}: ${actual} pack, normalt ${expText}`,
      detail: `Jämfört med ${basis}${f ? "" : ` (${range}snitt ${expText})`}: ${devBp > 0 ? "+" : "−"}${Math.abs(roundHalfUp(devBp, 100))} %. Sannolikheten för så ${direction === "low" ? "få" : "många"} är ${probabilityText(pBp)}.`,
      evidence: evidence({
        rule: `Larm när dagens antal pack avviker minst ${roundHalfUp(minDeviationBp, 100)} % från ${f ? "prognosen" : "samma veckodag tidigare veckor"} och sannolikheten (Poisson) är under ${probabilityText(probabilityBp)}.`,
        period: { start: date, end: date },
        orderIds: ordersOnDate.get(scope.id) ?? [],
        dates: [date, ...usedDates],
        machineIds: scope.machine ? [scope.machine.id] : [],
        figures: [
          { key: "actual", label: "Sålda pack", value: actual, unit: "packs" },
          { key: "expectedTenths", label: "Förväntat", value: expectedTenths, unit: "tenths" },
          { key: "deviationBp", label: "Avvikelse", value: devBp, unit: "bp" },
          { key: "probabilityBp", label: "Sannolikhet", value: pBp, unit: "bp" },
        ],
      }),
      link: scope.machine
        ? links.machine(scope.machine.id, { start: date, end: date })
        : links.salesDay(date),
      oneShot: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deduplicering och gruppering av kandidater
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ny automat hittad
// ---------------------------------------------------------------------------

/** En automat i Awish som inte är kopplad (samma lista som "Ny automat hittad" på Att göra). */
export interface DiscoveredMachineRef {
  /** source_machines.id */
  readonly id: string;
  readonly name: string;
  /** Köp som väntar på automaten. */
  readonly orders: number;
}

/** Incidentnyckel för en hittad automat. */
export function discoveredMachineKey(sourceMachineId: string): string {
  return `machine_discovered:${sourceMachineId}`;
}

/**
 * Ny automat hittad: en kandidat per automat som Awish har men som inte är kopplad till en
 * butik (och inte markerad "Inte vår"). Varning, så att standardprenumerationen (lägst varning)
 * får den. Incidenten stängs av sig själv när automaten kopplas eller markeras "Inte vår".
 * Nyckel: 'machine_discovered:<källautomat>'.
 */
export function discoveredMachineAlerts(found: readonly DiscoveredMachineRef[]): AlertCandidate[] {
  return found.map((m) => ({
    key: discoveredMachineKey(m.id),
    kind: "machine_discovered" as const,
    severity: "warning" as const,
    machineId: null,
    titleId: null,
    title: `Ny automat hittad: ${m.name.trim() || "utan namn"}`,
    detail: m.orders > 0 ? `${plural(m.orders, "köp", "köp")} väntar. Välj butik.` : "Välj butik.",
    evidence: evidence({
      rule: "Larm när Awish har en automat som inte är kopplad till någon butik.",
      figures: [{ key: "orders", label: "Köp som väntar", value: m.orders, unit: "count" }],
    }),
    link: "/att-gora",
  }));
}

/**
 * Slår ihop kandidater med samma nyckel: den allvarligaste (allvar, sedan typ inom familjen
 * machine) behålls, och underlagets listor slås ihop.
 */
export function dedupeCandidates(candidates: readonly AlertCandidate[]): AlertCandidate[] {
  const byKey = new Map<string, AlertCandidate>();
  for (const c of candidates) {
    const prev = byKey.get(c.key);
    if (!prev) {
      byKey.set(c.key, c);
      continue;
    }
    const keep =
      SEVERITY_RANK[c.severity] > SEVERITY_RANK[prev.severity] ||
      (SEVERITY_RANK[c.severity] === SEVERITY_RANK[prev.severity] &&
        KIND_RANK[c.kind] > KIND_RANK[prev.kind])
        ? c
        : prev;
    const other = keep === c ? prev : c;
    byKey.set(c.key, {
      ...keep,
      evidence: evidence({
        rule: keep.evidence.rule,
        period: keep.evidence.period,
        orderIds: [...keep.evidence.orderIds, ...other.evidence.orderIds],
        dates: [...keep.evidence.dates, ...other.evidence.dates],
        titleIds: [...keep.evidence.titleIds, ...other.evidence.titleIds],
        machineIds: [...keep.evidence.machineIds, ...other.evidence.machineIds],
        storeIds: [...keep.evidence.storeIds, ...other.evidence.storeIds],
        recipientIds: [...keep.evidence.recipientIds, ...other.evidence.recipientIds],
        figures: keep.evidence.figures,
      }),
    });
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Datum för ett larm om avvikande dag (ur nyckeln 'day_anomaly:<scope>:<datum>'). */
export function dayAnomalyDate(c: Pick<AlertCandidate, "key" | "kind">): IsoDate | null {
  if (c.kind !== "day_anomaly") return null;
  const date = c.key.slice(c.key.lastIndexOf(":") + 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? (date as IsoDate) : null;
}

/** Avvikelse från förväntat i tiondels pack (utfall × 10 − förväntat), ur underlaget. */
function deviationTenths(c: AlertCandidate): number | null {
  const fig = (k: string) => c.evidence.figures.find((f) => f.key === k)?.value;
  const actual = fig("actual");
  const expected = fig("expectedTenths");
  return actual === undefined || expected === undefined ? null : actual * 10 - expected;
}

/**
 * Gruppering: samma grundorsak ska inte larma flera gånger.
 * - Låg dag (för en automat eller hela organisationen) stryks när en import har misslyckats
 *   kritiskt: siffrorna är ofullständiga, och importlarmet är orsaken.
 * - Låg dag för en automat som har ett driftlarm stryks (driftlarmet förklarar den).
 * - Låg dag för hela organisationen stryks när någon automat har driftlarm (stopp i en automat
 *   drar ner totalen).
 * - Avvikande dag för hela organisationen stryks när automaternas egna larm samma dag och åt
 *   samma håll tillsammans står för minst hälften av avvikelsen (t.ex. en enda automat: −12
 *   av −12 pack). Automatens larm är mer precist och behålls. Gäller både låga och höga dagar.
 * Höga dagar stryks annars aldrig. Returnerar kvarvarande kandidater och de strukna med nyckeln
 * till larmet som förklarar dem, så att UI kan visa "ingår i …".
 */
export function suppressRelated(candidates: readonly AlertCandidate[]): {
  kept: AlertCandidate[];
  suppressed: { candidate: AlertCandidate; by: string }[];
} {
  const machineDown = new Map<string, string>();
  let importKey: string | null = null;
  for (const c of candidates) {
    if (ALERT_GROUP[c.kind] === "machine" && c.machineId) machineDown.set(c.machineId, c.key);
    if (c.kind === "import_failed" && c.severity === "critical" && importKey === null)
      importKey = c.key;
  }
  const kept: AlertCandidate[] = [];
  const suppressed: { candidate: AlertCandidate; by: string }[] = [];
  const explain = (c: AlertCandidate): string | null => {
    if (c.kind !== "day_anomaly") return null;
    if (c.severity === "warning") {
      if (importKey) return importKey;
      if (c.machineId) return machineDown.get(c.machineId) ?? null;
      if (machineDown.size > 0) return [...machineDown.values()].sort()[0] ?? null;
    }
    if (c.machineId) return null;
    // Hela organisationen: förklaras av automaternas larm samma dag åt samma håll?
    const date = dayAnomalyDate(c);
    const total = deviationTenths(c);
    if (date === null || total === null || total === 0) return null;
    let covered = 0;
    let biggest: { key: string; dev: number } | null = null;
    for (const o of candidates) {
      if (o.kind !== "day_anomaly" || !o.machineId || o.severity !== c.severity) continue;
      if (dayAnomalyDate(o) !== date) continue;
      const dev = deviationTenths(o);
      if (dev === null || Math.sign(dev) !== Math.sign(total)) continue;
      covered += dev;
      if (
        !biggest ||
        Math.abs(dev) > Math.abs(biggest.dev) ||
        (Math.abs(dev) === Math.abs(biggest.dev) && o.key < biggest.key)
      )
        biggest = { key: o.key, dev };
    }
    return biggest && Math.abs(covered) * 2 >= Math.abs(total) ? biggest.key : null;
  };
  for (const c of candidates) {
    const by = explain(c);
    if (by) suppressed.push({ candidate: c, by });
    else kept.push(c);
  }
  return { kept, suppressed };
}
