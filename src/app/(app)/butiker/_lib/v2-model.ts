/**
 * Butiker i V2 (G4): rena funktioner för listan och den valda butiken. Inga belopp räknas
 * här: andelen per månad är avräkningarnas belopp (store_settlements), månaden som pågår
 * den hittills intjänade andelen (storeCompensation), betalningarna store_payments och
 * betalda avräkningar. Här filtreras, grupperas och sorteras bara.
 */

export type ShopFilter = "alla" | "betala" | "natt" | "alltid";

export interface ShopListRow {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly payOre: number;
  readonly power: { readonly on: string; readonly off: string } | null;
  readonly profitOre: number;
}

/** Sök på butikens namn eller stad (skiftlägesokänsligt, svenska tecken som de är). */
export function matchesShop(row: Pick<ShopListRow, "name" | "city">, query: string): boolean {
  const q = query.trim().toLocaleLowerCase("sv-SE");
  if (!q) return true;
  return (
    row.name.toLocaleLowerCase("sv-SE").includes(q) ||
    (row.city ?? "").toLocaleLowerCase("sv-SE").includes(q)
  );
}

export function inFilter(row: Pick<ShopListRow, "payOre" | "power">, filter: ShopFilter): boolean {
  switch (filter) {
    case "betala":
      return row.payOre > 0;
    case "natt":
      return row.power !== null;
    case "alltid":
      return row.power === null;
    default:
      return true;
  }
}

export function filterCounts(rows: readonly ShopListRow[]): Record<ShopFilter, number> {
  return {
    alla: rows.length,
    betala: rows.filter((r) => inFilter(r, "betala")).length,
    natt: rows.filter((r) => inFilter(r, "natt")).length,
    alltid: rows.filter((r) => inFilter(r, "alltid")).length,
  };
}

export const NO_CITY_LABEL = "Utan stad";

export interface ShopGroup<R> {
  readonly city: string;
  readonly rows: readonly R[];
  readonly profitOre: number;
  readonly payStores: number;
}

/**
 * Butikerna per stad: städerna i bokstavsordning (utan stad sist), butikerna med något att
 * betala först och sedan efter vinst.
 */
export function groupByCity<R extends ShopListRow>(rows: readonly R[]): ShopGroup<R>[] {
  const map = new Map<string, R[]>();
  for (const r of rows) {
    const city = r.city?.trim() || NO_CITY_LABEL;
    const list = map.get(city);
    if (list) list.push(r);
    else map.set(city, [r]);
  }
  return [...map.entries()]
    .map(([city, list]) => ({
      city,
      rows: [...list].sort(
        (a, b) =>
          Number(b.payOre > 0) - Number(a.payOre > 0) ||
          b.profitOre - a.profitOre ||
          a.name.localeCompare(b.name, "sv"),
      ),
      profitOre: list.reduce((n, r) => n + r.profitOre, 0),
      payStores: list.filter((r) => r.payOre > 0).length,
    }))
    .sort(
      (a, b) =>
        Number(a.city === NO_CITY_LABEL) - Number(b.city === NO_CITY_LABEL) ||
        a.city.localeCompare(b.city, "sv"),
    );
}

/** Butiken som visas först: den första med något att betala, annars den första i listan. */
export function defaultShopId(rows: readonly Pick<ShopListRow, "id" | "payOre">[]): string | null {
  return (rows.find((r) => r.payOre > 0) ?? rows[0])?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Andel per månad och betalningar                                      */
/* ------------------------------------------------------------------ */

export interface SettlementLike {
  readonly id: string;
  readonly storeId: string;
  /** 'ÅÅÅÅ-MM'. */
  readonly month: string;
  readonly amountOre: number;
  readonly state: string;
  readonly paidOn: string | null;
  readonly paidOre: number;
  readonly statement: {
    readonly modelText: string;
    readonly steps: readonly {
      readonly label: string;
      readonly calculation: string;
      readonly amountOre: number;
    }[];
    readonly totalOre: number;
  } | null;
}

export interface ShareBar {
  readonly month: string;
  readonly amountOre: number;
  /** Månaden pågår (hittills intjänat). */
  readonly running: boolean;
  /** Dagar hittills i den pågående månaden, annars null. */
  readonly days: number | null;
  /**
   * Takten för hela den pågående månaden (hittills ÷ dagar × månadens dagar), för den
   * streckade stapeln. null för hela månader.
   */
  readonly paceOre: number | null;
}

/** 'ÅÅÅÅ-MM' n månader före (negativt n) eller efter. */
function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

/** Dagarna i månaden 'ÅÅÅÅ-MM'. */
function daysOfMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

/**
 * Butikens andel per kalendermånad, de senaste `months` månaderna med den pågående sist:
 * avräkningarnas belopp (oförändrade, flera i samma månad läggs ihop); utan avräkning den
 * räknade andelen för månaden (`computed`, storeCompensation: samma motor som avräkningen),
 * annars 0. Den pågående månaden är den intjänade andelen med takten för hela månaden.
 * Månader före butikens första andel visas inte (butiken hade ingen automat).
 */
export function shareHistory(
  settlements: readonly SettlementLike[],
  storeId: string,
  current: { readonly month: string; readonly earnedOre: number; readonly days: number },
  months = 6,
  computed: readonly { readonly month: string; readonly ore: number }[] = [],
): ShareBar[] {
  const byMonth = new Map<string, number>();
  let first: string | null = null;
  for (const s of settlements) {
    if (s.storeId !== storeId || s.month >= current.month) continue;
    byMonth.set(s.month, (byMonth.get(s.month) ?? 0) + s.amountOre);
    if (first === null || s.month < first) first = s.month;
  }
  for (const c of computed) {
    if (c.month >= current.month || byMonth.has(c.month) || c.ore === 0) continue;
    byMonth.set(c.month, c.ore);
    if (first === null || c.month < first) first = c.month;
  }
  const past: ShareBar[] = [];
  for (let k = months - 1; k >= 1; k--) {
    const month = addMonths(current.month, -k);
    if (first === null || month < first) continue;
    past.push({
      month,
      amountOre: byMonth.get(month) ?? 0,
      running: false,
      days: null,
      paceOre: null,
    });
  }
  const total = daysOfMonth(current.month);
  const days = Math.max(0, Math.min(current.days, total));
  return [
    ...past,
    {
      month: current.month,
      amountOre: current.earnedOre,
      running: true,
      days,
      paceOre: days > 0 ? Math.round((current.earnedOre * total) / days) : null,
    },
  ];
}

/**
 * Vinst per automat i perioden, med automatdagar: butikens vinst (summan av automaternas egen
 * vinst i butiken) delad med hur många automater som i snitt stod där, dvs. automatdagarna i
 * butiken ÷ periodens dagar. En automat som flyttade in mitt i perioden räknas som en halv,
 * en som flyttade ut räknas för dagarna den stod där. null utan automatdagar i perioden.
 */
export function perMachineProfit(
  profitOre: number,
  storeId: string,
  placements: readonly {
    readonly machineId: string;
    readonly storeId: string;
    readonly from: string;
    readonly to: string | null;
  }[],
  period: { readonly start: string; readonly end: string } | null,
): number | null {
  if (period === null || period.end < period.start) return null;
  const day = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  const periodDays = day(period.end) - day(period.start) + 1;
  let machineDays = 0;
  for (const p of placements) {
    if (p.storeId !== storeId) continue;
    const start = p.from > period.start ? p.from : period.start;
    const end = p.to !== null && p.to < period.end ? p.to : period.end;
    if (end >= start) machineDays += day(end) - day(start) + 1;
  }
  if (machineDays <= 0) return null;
  return Math.round((profitOre * periodDays) / machineDays);
}

/** Uträkningen att visa: den obetalda avräkningen, annars den senaste. */
export function latestStatement<S extends SettlementLike>(
  settlements: readonly S[],
  storeId: string,
): S | null {
  const own = settlements
    .filter((s) => s.storeId === storeId && s.statement !== null)
    .sort((a, b) => b.month.localeCompare(a.month));
  return own.find((s) => s.state === "unpaid") ?? own[0] ?? null;
}

export interface PaymentLike {
  readonly id: string;
  readonly storeId: string;
  readonly paidOn: string;
  readonly amountOre: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly parts: readonly { readonly month: string; readonly amountOre: number }[];
}

export interface PaymentHistoryRow {
  readonly key: string;
  readonly paidOn: string;
  readonly amountOre: number;
  /** Perioden betalningen gällde. */
  readonly start: string;
  readonly end: string;
  /** Månaderna den delades på ('ÅÅÅÅ-MM' med belopp). */
  readonly parts: readonly { readonly month: string; readonly amountOre: number }[];
  readonly kind: "payment" | "settlement";
}

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

/**
 * Butikens betalningar, senaste först: registrerade betalningar (förskott, egen period) och
 * avräkningar som markerats som betalda. En avräkning som betalats av betalningarna (beloppet
 * 0 kvar) står inte två gånger: bara avräkningar med betalt belopp utöver förskotten tas med.
 */
export function paymentHistory(
  payments: readonly PaymentLike[],
  settlements: readonly SettlementLike[],
  storeId: string,
): PaymentHistoryRow[] {
  const advances = new Map<string, number>();
  const rows: PaymentHistoryRow[] = [];
  for (const p of payments) {
    if (p.storeId !== storeId) continue;
    for (const part of p.parts) {
      advances.set(part.month, (advances.get(part.month) ?? 0) + part.amountOre);
    }
    rows.push({
      key: `p-${p.id}`,
      paidOn: p.paidOn,
      amountOre: p.amountOre,
      start: p.periodStart,
      end: p.periodEnd,
      parts: p.parts.map((x) => ({ month: x.month, amountOre: x.amountOre })),
      kind: "payment",
    });
  }
  for (const s of settlements) {
    if (s.storeId !== storeId || s.paidOn === null) continue;
    const paid = s.paidOre - (advances.get(s.month) ?? 0);
    if (paid <= 0) continue;
    const b = monthBounds(s.month);
    rows.push({
      key: `s-${s.id}`,
      paidOn: s.paidOn,
      amountOre: paid,
      start: b.start,
      end: b.end,
      parts: [{ month: s.month, amountOre: paid }],
      kind: "settlement",
    });
  }
  return rows.sort((a, b) => b.paidOn.localeCompare(a.paidOn) || a.key.localeCompare(b.key));
}
