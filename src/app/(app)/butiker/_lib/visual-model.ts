/**
 * Butikernas bilder (visuellt/06): mest sålda pack per butik, sålda pack och en liten kurva
 * över perioden. Bara antal pack (en order = ett pack), inga belopp: kurvan och listan säger
 * hur det går, beloppen står i kolumnerna bredvid och räknas som förut.
 *
 * Ordern hör till butiken där automaten stod orderns dag (samma regel som i beräkningarna).
 */

export interface SaleLike {
  readonly titleId: string;
  readonly machineId: string | null;
  /** 'ÅÅÅÅ-MM-DD'. */
  readonly businessDate: string;
}

export interface PlacementLike {
  readonly machineId: string;
  readonly storeId: string;
  readonly from: string;
  readonly to: string | null;
}

export interface TopPack {
  readonly title: string;
  readonly count: number;
}

export interface StoreSales {
  /** Sålda pack i perioden. */
  readonly sold: number;
  /** De mest sålda titlarna (flest först, högst `top` stycken). */
  readonly top: readonly TopPack[];
  /** Sålda pack per del av perioden (lika långa delar, äldst först). */
  readonly spark: readonly number[];
}

/** Dagar från `a` till `b` ('ÅÅÅÅ-MM-DD'), utan Date i lokal tid. */
function dayIndex(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function storeOfSale(
  sale: SaleLike,
  byMachine: ReadonlyMap<string, readonly PlacementLike[]>,
): string | null {
  if (!sale.machineId) return null;
  const list = byMachine.get(sale.machineId);
  if (!list) return null;
  for (const p of list) {
    if (p.from <= sale.businessDate && (p.to === null || sale.businessDate <= p.to)) {
      return p.storeId;
    }
  }
  return null;
}

/**
 * Sålda pack per butik i perioden: antal, de `top` mest sålda titlarna (namn ur `titleName`;
 * okända titlar hoppas över i listan men räknas i antalet) och `buckets` staplar för kurvan.
 */
export function storeSales(args: {
  readonly sales: readonly SaleLike[];
  readonly placements: readonly PlacementLike[];
  readonly titleName: (titleId: string) => string | null;
  readonly period: { readonly start: string; readonly end: string };
  readonly top?: number;
  readonly buckets?: number;
}): Map<string, StoreSales> {
  const topN = args.top ?? 4;
  const days = Math.max(1, dayIndex(args.period.start, args.period.end) + 1);
  const buckets = Math.max(1, Math.min(args.buckets ?? 10, days));
  const byMachine = new Map<string, PlacementLike[]>();
  for (const p of args.placements) {
    const list = byMachine.get(p.machineId);
    if (list) list.push(p);
    else byMachine.set(p.machineId, [p]);
  }
  const acc = new Map<string, { sold: number; titles: Map<string, number>; spark: number[] }>();
  for (const s of args.sales) {
    if (s.businessDate < args.period.start || s.businessDate > args.period.end) continue;
    const storeId = storeOfSale(s, byMachine);
    if (!storeId) continue;
    let a = acc.get(storeId);
    if (!a) {
      a = { sold: 0, titles: new Map(), spark: Array.from({ length: buckets }, () => 0) };
      acc.set(storeId, a);
    }
    a.sold += 1;
    const name = args.titleName(s.titleId);
    if (name) a.titles.set(name, (a.titles.get(name) ?? 0) + 1);
    const i = Math.min(
      buckets - 1,
      Math.floor((dayIndex(args.period.start, s.businessDate) / days) * buckets),
    );
    a.spark[i]! += 1;
  }
  const out = new Map<string, StoreSales>();
  for (const [id, a] of acc) {
    out.set(id, {
      sold: a.sold,
      top: [...a.titles]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], "sv"))
        .slice(0, topN)
        .map(([title, count]) => ({ title, count })),
      spark: a.spark,
    });
  }
  return out;
}

/** Punkterna i en liten linje (w×h), 1 px marginal. Tom sträng utan minst två punkter. */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const max = Math.max(...values);
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = max > 0 ? h - 1 - (v / max) * (h - 3) : h - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
