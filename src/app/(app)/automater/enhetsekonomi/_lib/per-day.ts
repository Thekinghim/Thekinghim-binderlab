/**
 * Listan "Vinst per dag" i Enhetsekonomi: en stapel per automat, längd mot den bästa, med
 * medianen för automaterna som ett streck. Bara presentation: beloppen kommer färdiga från
 * jämförelsen (compareUnitEconomics) och räknas inte om.
 */
export interface PerDayInput {
  readonly machineId: string;
  readonly name: string;
  readonly profitPerDayOre: number | null;
  readonly profitPerMonthOre: number | null;
  readonly paybackTenths: number | null;
}

export interface PerDayRow {
  readonly machineId: string;
  readonly name: string;
  readonly code: string | null;
  readonly storeName: string | null;
  readonly profitPerDayOre: number;
  readonly profitPerMonthOre: number | null;
  readonly paybackTenths: number | null;
  /** Stapelns längd, 0–1 av den bästa automaten. 0 för förlust. */
  readonly fraction: number;
  /** Återbetalningstiden mot den längsta i listan, 0–1. null utan återbetalning. */
  readonly paybackFraction: number | null;
}

export interface PerDayList {
  readonly rows: PerDayRow[];
  /** Medianen av vinst per dag (öre, avrundad). null utan automater. */
  readonly medianOre: number | null;
  /** Var strecket står, 0–1 av skalan. null utan median eller när den är ≤ 0. */
  readonly medianFraction: number | null;
}

/** Medianen; jämnt antal = snittet av de två mittersta, avrundat till hela öre. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

const collator = new Intl.Collator("sv-SE", { numeric: true, sensitivity: "base" });

/** Automaterna med vinst per dag, mest först, med stapellängd och median. Ren funktion. */
export function perDayList(
  rows: readonly PerDayInput[],
  codes: Readonly<Record<string, string | undefined>>,
  storeNames: Readonly<Record<string, string | undefined>>,
): PerDayList {
  const placed = rows.filter((r) => r.profitPerDayOre !== null);
  const values = placed.map((r) => r.profitPerDayOre!);
  const med = median(values);
  const scale = Math.max(0, ...values, med ?? 0);
  const paybacks = placed.map((r) => r.paybackTenths).filter((t): t is number => t !== null);
  const maxPayback = Math.max(0, ...paybacks);
  const list = placed
    .map((r): PerDayRow => {
      const v = r.profitPerDayOre!;
      return {
        machineId: r.machineId,
        name: r.name,
        code: codes[r.machineId] ?? null,
        storeName: storeNames[r.machineId] ?? null,
        profitPerDayOre: v,
        profitPerMonthOre: r.profitPerMonthOre,
        paybackTenths: r.paybackTenths,
        fraction: scale > 0 ? Math.max(0, v) / scale : 0,
        paybackFraction:
          r.paybackTenths === null || maxPayback <= 0 ? null : r.paybackTenths / maxPayback,
      };
    })
    .sort(
      (a, b) =>
        b.profitPerDayOre - a.profitPerDayOre ||
        collator.compare(a.code ?? a.name, b.code ?? b.name),
    );
  return {
    rows: list,
    medianOre: med,
    medianFraction: med === null || med <= 0 || scale <= 0 ? null : med / scale,
  };
}
