import { seeded } from "@/lib/random";

/**
 * Exempeldata för "Månadsrapport oktober 2026" till Westfield Arninge.
 * Deterministisk. Alla summor härleds ur produktraderna, så att
 * nyckeltal, diagram och tabeller stämmer med varandra.
 */

export const reportMeta = {
  title: "Månadsrapport oktober 2026",
  recipient: "Westfield Arninge, Centrumledningen",
  period: { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) },
  generatedAt: new Date(2026, 10, 2, 9, 14),
};

export const machine = {
  id: "BL-010",
  placement: "Plan 1, vid entré Norr",
  installed: new Date(2026, 2, 14),
};

/** Omsättningshyra enligt avtal: andel av intäkt exkl. moms. */
export const RENT_SHARE = 0.1;
export const VAT = 0.25;

export type ProductRow = {
  id: string;
  product: string;
  series: string;
  /** Pris inkl. moms */
  price: number;
  units: number;
  unitsPrev: number;
  revenue: number;
  revenuePrev: number;
};

const RAW: Array<[string, string, string, number, number, number]> = [
  // id, produkt, serie, pris, oktober, september
  ["p1", "Booster, släpp 24 okt.", "Pokémon", 69, 212, 0],
  ["p2", "Booster, föregående släpp", "Pokémon", 69, 148, 236],
  ["p3", "Mini tin", "Pokémon", 129, 41, 38],
  ["p4", "Blister 3-pack", "Pokémon", 199, 22, 19],
  ["p5", "Booster", "One Piece", 59, 118, 92],
  ["p6", "Booster, japansk", "One Piece", 49, 46, 33],
  ["p7", "Play booster", "Magic: The Gathering", 79, 44, 51],
  ["p8", "Collector booster", "Magic: The Gathering", 299, 6, 4],
  ["p9", "Booster", "Lorcana", 69, 71, 66],
  ["p10", "Booster", "Yu-Gi-Oh!", 49, 28, 31],
  ["p11", "Kortfickor, 50 st", "Tillbehör", 39, 37, 30],
];

export const products: ProductRow[] = RAW.map(([id, product, series, price, units, prev]) => ({
  id,
  product,
  series,
  price,
  units,
  unitsPrev: prev,
  revenue: price * units,
  revenuePrev: price * prev,
}));

const total = (rows: ProductRow[], k: "revenue" | "revenuePrev" | "units" | "unitsPrev") =>
  rows.reduce((s, r) => s + r[k], 0);

export const totals = {
  revenue: total(products, "revenue"),
  revenuePrev: total(products, "revenuePrev"),
  units: total(products, "units"),
  unitsPrev: total(products, "unitsPrev"),
  /** Antal köp (en transaktion kan innehålla flera pack) */
  purchases: 586,
  purchasesPrev: 470,
};

export const revenueExVat = totals.revenue / (1 + VAT);
export const rent = revenueExVat * RENT_SHARE;

/** Serier för andelsstapeln: fyra största + Övrigt, störst först. */
export function seriesShare() {
  const map = new Map<string, { value: number; prev: number }>();
  for (const p of products) {
    const key = ["Pokémon", "One Piece", "Magic: The Gathering", "Lorcana"].includes(p.series)
      ? p.series
      : "Övrigt";
    const cur = map.get(key) ?? { value: 0, prev: 0 };
    map.set(key, { value: cur.value + p.revenue, prev: cur.prev + p.revenuePrev });
  }
  const rows = [...map.entries()].map(([label, v]) => ({ label, ...v }));
  const other = rows.filter((r) => r.label === "Övrigt");
  return [...rows.filter((r) => r.label !== "Övrigt").sort((a, b) => b.value - a.value), ...other];
}

// ---------------------------------------------------------------------------
// Dagar
// ---------------------------------------------------------------------------

function dayWeight(date: Date, rnd: () => number, releaseDay?: number): number {
  const dow = date.getDay();
  const week = dow === 6 ? 1.52 : dow === 0 ? 1.26 : dow === 5 ? 1.16 : 1;
  let event = 1;
  if (releaseDay !== undefined) {
    const d = date.getDate();
    if (d === releaseDay) event = 2.1;
    else if (d === releaseDay + 1) event = 1.45;
    else if (d === releaseDay + 2) event = 1.18;
  }
  return week * event * (0.88 + rnd() * 0.24);
}

/** Fördelar ett heltal på vikter så att summan blir exakt (största rest). */
function allocate(totalValue: number, weights: number[]): number[] {
  const sumW = weights.reduce((s, w) => s + w, 0) || 1;
  const exact = weights.map((w) => (w / sumW) * totalValue);
  const floors = exact.map(Math.floor);
  let rest = totalValue - floors.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (const o of order) {
    if (rest <= 0) break;
    floors[o.i] = (floors[o.i] ?? 0) + 1;
    rest--;
  }
  return floors;
}

const OCT = Array.from({ length: 31 }, (_, i) => new Date(2026, 9, i + 1));
const SEP = Array.from({ length: 30 }, (_, i) => new Date(2026, 8, i + 1));

const octRnd = seeded(2610);
const sepRnd = seeded(926);

/** Avvikelser sänker dagens försäljning något. */
const DIP: Record<number, number> = { 12: 0.9, 21: 0.92, 29: 0.86, 30: 0.8 };

export const days = OCT.map((date, i) => ({ date, index: i }));

export const revenueByDay: number[] = allocate(
  totals.revenue,
  OCT.map((d) => dayWeight(d, octRnd, 24) * (DIP[d.getDate()] ?? 1)),
);

export const revenueByDayPrev: number[] = allocate(
  totals.revenuePrev,
  SEP.map((d) => dayWeight(d, sepRnd)),
);

export const bestDay = revenueByDay.reduce(
  (best, v, i) => (v > (revenueByDay[best] ?? 0) ? i : best),
  0,
);

/** Snittintäkt per veckodag, måndag först. */
export function weekdayAverages() {
  const names = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];
  const sums = new Array<number>(7).fill(0);
  const counts = new Array<number>(7).fill(0);
  OCT.forEach((d, i) => {
    const k = (d.getDay() + 6) % 7;
    sums[k] = (sums[k] ?? 0) + (revenueByDay[i] ?? 0);
    counts[k] = (counts[k] ?? 0) + 1;
  });
  return names.map((label, k) => ({
    label,
    value: Math.round((sums[k] ?? 0) / (counts[k] || 1)),
    total: sums[k] ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/** Centrumets öppettider, som tillgängligheten räknas mot. */
export const OPEN_HOURS = { from: 10, to: 20 };
export const openMinutes = OCT.length * (OPEN_HOURS.to - OPEN_HOURS.from) * 60;

export type Incident = {
  id: string;
  start: Date;
  end: Date;
  event: string;
  action: string;
  /** Räknas som driftstopp (automaten kunde inte sälja alls) */
  outage: boolean;
};

export const incidents: Incident[] = [
  {
    id: "1",
    start: new Date(2026, 9, 12, 14, 5),
    end: new Date(2026, 9, 12, 15, 17),
    event: "Kortterminalen svarade inte",
    action: "Terminalen startades om på distans",
    outage: true,
  },
  {
    id: "2",
    start: new Date(2026, 9, 21, 18, 22),
    end: new Date(2026, 9, 21, 19, 0),
    event: "Strömavbrott i centrumet",
    action: "Automaten startade själv när strömmen kom tillbaka",
    outage: true,
  },
  {
    id: "3",
    start: new Date(2026, 9, 29, 16, 40),
    end: new Date(2026, 9, 30, 8, 30),
    event: "Fack 3 tomt (släpp 24 okt.), övriga fack sålde",
    action: "Extra påfyllning. Intervallet kortas till var tredje dag",
    outage: false,
  },
];

export const outageMinutes = incidents
  .filter((i) => i.outage)
  .reduce((s, i) => s + (i.end.getTime() - i.start.getTime()) / 60_000, 0);

export const availability = 1 - outageMinutes / openMinutes;

export type Refill = {
  date: Date;
  packs: number;
  before: number;
  after: number;
  extra?: boolean;
};

export const refills: Refill[] = [
  { date: new Date(2026, 9, 2, 8, 35), packs: 96, before: 0.41, after: 1 },
  { date: new Date(2026, 9, 6, 8, 40), packs: 104, before: 0.37, after: 1 },
  { date: new Date(2026, 9, 10, 8, 30), packs: 92, before: 0.43, after: 1 },
  { date: new Date(2026, 9, 14, 8, 45), packs: 99, before: 0.4, after: 1 },
  { date: new Date(2026, 9, 18, 8, 35), packs: 101, before: 0.39, after: 1 },
  { date: new Date(2026, 9, 23, 8, 20), packs: 118, before: 0.3, after: 1 },
  { date: new Date(2026, 9, 27, 8, 40), packs: 96, before: 0.22, after: 1 },
  { date: new Date(2026, 9, 30, 8, 30), packs: 70, before: 0.31, after: 1, extra: true },
];
