/**
 * Automat-ranking: automaterna rangordnade efter vinst per dag, med ett omdöme per automat.
 * Ren funktion utan I/O. Talen (vinst och intäkt per dag, aktiva dagar) kommer från
 * Enhetsekonomi (compareUnitEconomics), så samma automat har samma tal på båda sidorna.
 * Vinsten är före butikernas andel om inte vyn drar den (indatans regel, inte den här
 * modulens).
 *
 * Flera automater (minst två har sålt):
 *   jämförbara = automater med minst FLEET_MIN_DAYS aktiva dagar
 *   median     = medianen av de jämförbaras vinst per dag
 *   "Tjänar dåligt: överväg att flytta" = jämförbar och går med förlust per dag, eller tjänar
 *                högst hälften av medianen (FLEET_WEAK_SHARE_BP) när medianen är över 0
 *   "Bäst"     = högst vinst per dag bland de jämförbara (minst två), över 0 och inte svag
 *   "Tjänar bra"  = övriga jämförbara
 *   "För ny"   = färre än FLEET_MIN_DAYS aktiva dagar: inget omdöme
 *   Finns bara en jämförbar automat finns ingen median: den får "Inget att jämföra med än"
 *   (eller "Tjänar dåligt" om den går med förlust).
 *
 * En automat: jämförs med sig själv perioden innan (lika lång). Vinst per dag minst
 * SELF_CHANGE_BP (10 %) upp = "Går bättre", minst lika mycket ner = "Går sämre", annars
 * "Går som förra perioden". Utan en förra period med minst FLEET_MIN_DAYS dagar: ingen
 * jämförelse, och det sägs.
 */

/** Minsta antal aktiva dagar innan en automat får ett omdöme. */
export const FLEET_MIN_DAYS = 14;
/** Högst så här stor del av medianen (bp) och automaten "går dåligt". */
export const FLEET_WEAK_SHARE_BP = 5_000;
/** Minsta ändring mot förra perioden (bp) för "bättre" eller "sämre". */
export const SELF_CHANGE_BP = 1_000;

/** En automat i perioden. */
export interface FleetMachineInput {
  readonly machineId: string;
  readonly activeDays: number;
  /** Sålda pack (order) i perioden. */
  readonly orders: number;
  /** Intäkt exkl. moms per dag, öre. null utan aktiva dagar. */
  readonly revenuePerDayOre: number | null;
  readonly profitPerDayOre: number | null;
  /** Förlorad intäkt när titlar varit slutsålda, öre. null = okänt (ingen lagerdata). */
  readonly lostRevenueOre?: number | null;
  /** Slutsålda dagar, summerat över automatens titlar, i tiondelar. null = okänt. */
  readonly stockoutDayTenths?: number | null;
}

export type FleetVerdict =
  /** Flera automater. */
  | "best"
  | "good"
  | "weak"
  | "new"
  | "alone"
  /** En automat, mot sin förra period. */
  | "better"
  | "same"
  | "worse";

export interface FleetRow {
  readonly machineId: string;
  /** 1 = mest vinst per dag. */
  readonly rank: number;
  readonly activeDays: number;
  readonly revenuePerDayOre: number;
  readonly profitPerDayOre: number;
  /** Sålda pack per dag, i tiondelar. */
  readonly unitsPerDayTenths: number;
  readonly lostRevenueOre: number | null;
  readonly stockoutDayTenths: number | null;
  readonly verdict: FleetVerdict;
  /** Vinst per dag mot medianen, öre. null utan median. */
  readonly vsMedianOre: number | null;
  /** Vinst per dag mot automatens förra period, bp. Bara med en automat. */
  readonly vsPreviousBp: number | null;
  /** Förra periodens vinst per dag, öre. Bara med en automat. */
  readonly previousProfitPerDayOre: number | null;
  /** Stapelns längd 0–1 (andel av den största vinsten per dag, förlust = 0). */
  readonly bar: number;
}

export interface FleetRanking {
  /** "fleet": minst två automater har sålt. "single": en. "empty": ingen. */
  readonly mode: "fleet" | "single" | "empty";
  /** Bäst först. */
  readonly rows: FleetRow[];
  /** Medianen av de jämförbaras vinst per dag, öre. null med färre än två jämförbara. */
  readonly medianProfitPerDayOre: number | null;
  /** Automater med minst FLEET_MIN_DAYS aktiva dagar. */
  readonly comparable: number;
  readonly best: FleetRow | null;
  /** Svagast först. */
  readonly weak: FleetRow[];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function selfVerdict(
  now: number,
  activeDays: number,
  previous: FleetMachineInput | null,
): { verdict: FleetVerdict; bp: number | null; before: number | null } {
  if (activeDays < FLEET_MIN_DAYS) return { verdict: "new", bp: null, before: null };
  const before = previous?.profitPerDayOre ?? null;
  if (previous === null || before === null || previous.activeDays < FLEET_MIN_DAYS) {
    return { verdict: "alone", bp: null, before: null };
  }
  if (before === 0) {
    return { verdict: now > 0 ? "better" : now < 0 ? "worse" : "same", bp: null, before };
  }
  const bp = Math.round(((now - before) * 10_000) / Math.abs(before));
  return {
    verdict: bp >= SELF_CHANGE_BP ? "better" : bp <= -SELF_CHANGE_BP ? "worse" : "same",
    bp,
    before,
  };
}

/**
 * Rangordningen. `previous` är samma automater perioden innan och används bara när en
 * enda automat har sålt.
 */
export function fleetRanking(
  machines: readonly FleetMachineInput[],
  previous: readonly FleetMachineInput[] = [],
): FleetRanking {
  const active = machines
    .filter((m) => m.activeDays > 0 && m.profitPerDayOre !== null)
    .sort((a, b) =>
      a.profitPerDayOre !== b.profitPerDayOre
        ? b.profitPerDayOre! - a.profitPerDayOre!
        : a.machineId < b.machineId
          ? -1
          : 1,
    );
  const mode = active.length === 0 ? "empty" : active.length === 1 ? "single" : "fleet";
  const comparable = active.filter((m) => m.activeDays >= FLEET_MIN_DAYS);
  const med =
    mode === "fleet" && comparable.length >= 2
      ? median(comparable.map((m) => m.profitPerDayOre!))
      : null;
  const top = Math.max(0, ...active.map((m) => m.profitPerDayOre!));
  const before = new Map(previous.map((m) => [m.machineId, m]));

  const isWeak = (m: FleetMachineInput): boolean => {
    if (m.activeDays < FLEET_MIN_DAYS) return false;
    const p = m.profitPerDayOre!;
    if (p < 0) return true;
    return med !== null && med > 0 && p * 10_000 <= med * FLEET_WEAK_SHARE_BP;
  };
  const bestId =
    med !== null && comparable[0] && comparable[0].profitPerDayOre! > 0 && !isWeak(comparable[0])
      ? comparable[0].machineId
      : null;

  const rows: FleetRow[] = active.map((m, i) => {
    const profit = m.profitPerDayOre!;
    let verdict: FleetVerdict;
    let vsPreviousBp: number | null = null;
    let previousProfit: number | null = null;
    if (mode === "single") {
      const self = selfVerdict(profit, m.activeDays, before.get(m.machineId) ?? null);
      verdict = self.verdict;
      vsPreviousBp = self.bp;
      previousProfit = self.before;
    } else if (m.activeDays < FLEET_MIN_DAYS) verdict = "new";
    else if (isWeak(m)) verdict = "weak";
    else if (m.machineId === bestId) verdict = "best";
    else verdict = med === null ? "alone" : "good";
    return {
      machineId: m.machineId,
      rank: i + 1,
      activeDays: m.activeDays,
      revenuePerDayOre: m.revenuePerDayOre ?? 0,
      profitPerDayOre: profit,
      unitsPerDayTenths: Math.round((m.orders * 10) / m.activeDays),
      lostRevenueOre: m.lostRevenueOre ?? null,
      stockoutDayTenths: m.stockoutDayTenths ?? null,
      verdict,
      vsMedianOre: med === null || m.activeDays < FLEET_MIN_DAYS ? null : profit - med,
      vsPreviousBp,
      previousProfitPerDayOre: previousProfit,
      bar: top > 0 ? Math.max(0, profit) / top : 0,
    };
  });

  return {
    mode,
    rows,
    medianProfitPerDayOre: med,
    comparable: comparable.length,
    best: rows.find((r) => r.verdict === "best") ?? null,
    weak: rows.filter((r) => r.verdict === "weak").reverse(),
  };
}
