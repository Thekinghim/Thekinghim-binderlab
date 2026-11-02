import {
  byTitle,
  machineById,
  machines as allMachines,
  ordersIn,
  revenueByDay as dailyRevenue,
  storeById,
  totals as sumTotals,
} from "@/app/design/sample-data";

/**
 * Exempeldata för "Månadsrapport oktober 2026" till Nordstan (BL-001).
 * Siffrorna räknas ur samma Awish-ordrar som /design, så att rapporten,
 * e-posten och panelen visar samma belopp för samma månad och automat.
 */

const MACHINE = machineById.get("m1") ?? allMachines[0]!;
const STORE = storeById.get(MACHINE.storeId)!;
const IDX = [allMachines.indexOf(MACHINE)];

const OCTOBER = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) };
const SEPTEMBER = { start: new Date(2026, 8, 1), end: new Date(2026, 8, 30) };

export const reportMeta = {
  title: "Månadsrapport oktober 2026",
  recipient: `${STORE.name}, Centrumledningen`,
  period: OCTOBER,
  generatedAt: new Date(2026, 10, 2, 9, 14),
};

export const machine = {
  id: MACHINE.code,
  placement: `${MACHINE.name}, ${STORE.name}`,
  installed: MACHINE.installed,
};

/** Provision enligt avtalet (andel av intäkten) och månadshyra i kronor. Moms och kortavgift är 0. */
export const RENT_SHARE = STORE.commissionBp / 10_000;
export const MONTHLY_RENT = STORE.rentOre / 100;
export const VAT = 0;

export type ProductRow = {
  id: string;
  product: string;
  /** Inköpspris per pack i kronor; null = saknas */
  cost: number | null;
  /** Pris i automaten */
  price: number;
  units: number;
  unitsPrev: number;
  revenue: number;
  revenuePrev: number;
};

const octOrders = ordersIn(OCTOBER, IDX);
const sepOrders = ordersIn(SEPTEMBER, IDX);
const prevByTitle = new Map(byTitle(sepOrders).map((r) => [r.title.id, r]));

/** En rad per titel. Black Bolt (släppet 24 okt.) har id "p1". */
export const products: ProductRow[] = byTitle(octOrders).map((r) => {
  const prev = prevByTitle.get(r.title.id);
  return {
    id: r.title.id === "t6" ? "p1" : r.title.id,
    product: r.title.name,
    cost: r.title.costOre === null ? null : r.title.costOre / 100,
    price: r.title.priceOre / 100,
    units: r.orders,
    unitsPrev: prev?.orders ?? 0,
    revenue: r.revenue / 100,
    revenuePrev: (prev?.revenue ?? 0) / 100,
  };
});

const oct = sumTotals(octOrders, OCTOBER, IDX);
const sep = sumTotals(sepOrders, SEPTEMBER, IDX);

export const totals = {
  revenue: oct.revenue / 100,
  revenuePrev: sep.revenue / 100,
  units: oct.orders,
  unitsPrev: sep.orders,
  /** Antal köp: en Awish-order är ett pack. */
  purchases: oct.orders,
  purchasesPrev: sep.orders,
};

export const revenueExVat = totals.revenue;
/** Provisionen räknas på intäkten med inköpspris (docs/berakningar.md): utan Black Bolt. */
export const commissionBase = oct.pricedRevenue / 100;
/** Butiksersättning: provision på intäkten plus månadshyran. */
export const commission = oct.commission / 100;
export const rent = (oct.commission + oct.rent) / 100;

/** Titlar för andelsstapeln: fyra största + Övrigt, störst först. */
export function seriesShare() {
  const top = products.slice(0, 4);
  const rest = products.slice(4);
  const rows = top.map((p) => ({ label: p.product, value: p.revenue, prev: p.revenuePrev }));
  if (rest.length) {
    rows.push({
      label: "Övrigt",
      value: rest.reduce((s, p) => s + p.revenue, 0),
      prev: rest.reduce((s, p) => s + p.revenuePrev, 0),
    });
  }
  return rows;
}

/** Bästa och sämsta månad sedan installationen, för rubriken. */
export function monthRank(): { rank: number; months: number } {
  const months: number[] = [];
  const start = MACHINE.installed;
  for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= OCTOBER.start;) {
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    months.push(sumTotals(ordersIn({ start: d, end }, IDX), { start: d, end }, IDX).revenue);
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  const value = oct.revenue;
  return { rank: months.filter((m) => m > value).length + 1, months: months.length };
}

// ---------------------------------------------------------------------------
// Dagar
// ---------------------------------------------------------------------------

const OCT = Array.from({ length: 31 }, (_, i) => new Date(2026, 9, i + 1));

export const days = OCT.map((date, i) => ({ date, index: i }));

export const revenueByDay: number[] = dailyRevenue(octOrders, OCTOBER).map(Math.round);

export const revenueByDayPrev: number[] = dailyRevenue(sepOrders, SEPTEMBER).map(Math.round);

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

const REFILL_DATES: Array<[Date, number, number, boolean?]> = [
  [new Date(2026, 9, 2, 8, 35), 96, 0.41],
  [new Date(2026, 9, 6, 8, 40), 104, 0.37],
  [new Date(2026, 9, 10, 8, 30), 92, 0.43],
  [new Date(2026, 9, 14, 8, 45), 99, 0.4],
  [new Date(2026, 9, 18, 8, 35), 101, 0.39],
  [new Date(2026, 9, 23, 8, 20), 118, 0.3],
  [new Date(2026, 9, 27, 8, 40), 96, 0.22],
  [new Date(2026, 9, 30, 8, 30), 70, 0.31, true],
];

/** Påfyllningar som tillsammans ersätter de sålda packen (största rest). */
export const refills: Refill[] = (() => {
  const weights = REFILL_DATES.map((r) => r[1]);
  const sumW = weights.reduce((x, y) => x + y, 0);
  const exact = weights.map((w) => (w / sumW) * totals.units);
  const packs = exact.map(Math.floor);
  let rest = totals.units - packs.reduce((x, y) => x + y, 0);
  exact
    .map((v, i) => ({ i, r: v - Math.floor(v) }))
    .sort((x, y) => y.r - x.r)
    .forEach(({ i }) => {
      if (rest-- > 0) packs[i] = (packs[i] ?? 0) + 1;
    });
  return REFILL_DATES.map(([date, , before, extra], i) => ({
    date,
    packs: packs[i] ?? 0,
    before,
    after: 1,
    ...(extra ? { extra } : {}),
  }));
})();
