import {
  NBSP,
  formatDate,
  formatDuration,
  formatInt,
  formatKronor,
  formatPercent,
  formatSek,
  formatSignedKronor,
} from "@/lib/format";
import {
  machines,
  ordersIn,
  outageEvents,
  revenueByDay,
  storeById,
  stores,
  totals,
} from "@/app/design/sample-data";
import type { DailyPoint, RecipientKind, ReportEmailProps } from "./report-content";

/**
 * Exempelmejl för oktober 2026, ett per mottagartyp. Siffrorna räknas ur
 * samma Awish-ordrar som /design och månadsrapporten (tre automater i tre
 * butiker, moms och kortavgift 0), så att alla visar samma belopp.
 * Deterministiska, så server och klient ger samma HTML.
 */

const OCTOBER = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) };
const GENERATED = new Date(2026, 10, 2, 7, 0);
const BASE_URL = "https://app.binderlab.se";

/** "9 nov." med hårt mellanslag (månad 0–11). */
const day = (y: number, m: number, d: number) => formatDate(new Date(y, m, d), { year: "never" });

const OCT_RANGE = { start: OCTOBER.start, end: OCTOBER.end };
const SEP_RANGE = { start: new Date(2026, 8, 1), end: new Date(2026, 8, 30) };
const ALL = machines.map((_, i) => i);
const kr = (ore: number) => ore / 100;

/** Dagsförsäljning i oktober ur samma Awish-ordrar som /design. Toppen lör 24 okt. (släpp). */
function october(idx: ReadonlyArray<number>): DailyPoint[] {
  return revenueByDay(ordersIn(OCT_RANGE, idx), OCT_RANGE).map((value, i) => ({
    date: new Date(2026, 9, i + 1),
    value: Math.round(value),
    note: i + 1 === 24 ? "släppdag för Black Bolt" : undefined,
  }));
}

const oct = totals(ordersIn(OCT_RANGE, ALL), OCT_RANGE, ALL);
const sep = totals(ordersIn(SEP_RANGE, ALL), SEP_RANGE, ALL);
const perMachine = machines.map((m, i) => {
  const o = totals(ordersIn(OCT_RANGE, [i]), OCT_RANGE, [i]);
  const p = totals(ordersIn(SEP_RANGE, [i]), SEP_RANGE, [i]);
  return { m, store: storeById.get(m.storeId), o, p };
});

/* Nordstan (BL-001): öppettid 10–20 alla dagar, två driftstopp i oktober. */
const nordstan = perMachine[0]!;
const OPEN_MIN = 31 * 10 * 60;
const outages = outageEvents.filter((e) => e.machineId === nordstan.m.id && e.from >= OCTOBER.start);
const outageMin = outages.reduce((n, e) => n + (e.to.getTime() - e.from.getTime()) / 60_000, 0);
const availability = 1 - outageMin / OPEN_MIN;

const butik: ReportEmailProps = {
  recipientKind: "butik",
  recipientName: "Maria",
  period: OCTOBER,
  summary: `Automaten var i drift ${formatPercent(availability)} av öppettiden.`,
  kpis: [
    {
      label: "Försäljning",
      value: kr(nordstan.o.revenue),
      unit: "kr",
      change: { value: nordstan.o.revenue / nordstan.p.revenue - 1 },
    },
    {
      label: "Sålda pack",
      value: nordstan.o.orders,
      unit: "count",
      change: { value: nordstan.o.orders / nordstan.p.orders - 1 },
    },
    { label: "I drift", value: availability, unit: "share" },
    {
      label: "Avbrott",
      value: outages.length,
      unit: "count",
      note: `Totalt ${formatDuration(outageMin * 60_000).replace(/ /g, NBSP)}`,
      lowerIsBetter: true,
    },
  ],
  rows: [
    {
      id: nordstan.m.code,
      name: nordstan.m.name,
      revenue: kr(nordstan.o.revenue),
      packs: nordstan.o.orders,
      availability,
    },
  ],
  daily: october([0]),
  details: {
    siteName: nordstan.store?.name ?? "",
    availability,
    incidents: [
      {
        start: outages[0]?.from ?? OCTOBER.start,
        durationMs: outages[0] ? outages[0].to.getTime() - outages[0].from.getTime() : 0,
        cause: "kortterminalen svarade inte, omstart på distans",
      },
      {
        start: outages[1]?.from ?? OCTOBER.start,
        durationMs: outages[1] ? outages[1].to.getTime() - outages[1].from.getTime() : 0,
        cause: "strömavbrott i centrumet",
      },
    ],
    busiest: "Lördagar 12–15",
    refills: { count: 8, last: new Date(2026, 9, 30) },
    nextVisit: new Date(2026, 10, 3, 7, 30),
    contact: { name: "Erik Sand", phone: "070-174 06 42" },
  },
  reportUrl: `${BASE_URL}/r/2026-10/nordstan`,
  attachments: [
    {
      name: "forsaljning-nordstan-2026-10.pdf",
      size: 96_000,
      description: "Försäljning per dag, underlag för provisionen",
    },
  ],
  reportId: "R-2026-10-03",
  generatedAt: GENERATED,
};

const purchasesKr = kr(oct.purchases);
const firstDelivery = Math.round(purchasesKr * 0.55 * 100) / 100;

const bokforing: ReportEmailProps = {
  recipientKind: "bokforing",
  recipientName: "Karin",
  period: OCTOBER,
  summary: `Försäljningen var ${formatKronor(kr(oct.revenue))} från ${formatInt(oct.orders)} ordrar.`,
  kpis: [
    {
      label: "Försäljning",
      value: kr(oct.revenue),
      unit: "kr",
      note: `Moms 0 % · ${formatInt(oct.orders)} ordrar`,
    },
    {
      label: "Butiksersättning",
      value: kr(oct.storeCompensation),
      unit: "kr",
      note: `Provision ${formatSek(kr(oct.commission))} · hyra ${formatSek(kr(oct.rent))}`,
    },
    { label: "Inköp", value: purchasesKr, unit: "kr", note: "Två leveranser" },
    {
      label: "Ordrar",
      value: oct.orders,
      unit: "count",
      note: `Varav ${formatInt(oct.unpricedOrders)} utan inköpspris`,
    },
  ],
  rows: perMachine.map(({ m, store, o }) => ({
    id: m.code,
    name: store?.name ?? "",
    location: store?.city,
    revenue: kr(o.revenue),
    revenueExVat: kr(o.revenue),
  })),
  details: {
    company: "Binderlab AB",
    transactions: oct.orders,
    entries: [
      {
        account: "3001",
        text: "Försäljning varor, 0 % moms",
        amount: kr(oct.revenue),
        verification: "V1041",
      },
      {
        account: "6590",
        text: `Provision butiker, ${formatInt(stores.length)} avtal`,
        amount: -kr(oct.commission),
        verification: "V1042",
      },
      {
        account: "5010",
        text: "Lokalhyra, Nordstan och Väla Centrum",
        amount: -kr(oct.rent),
        verification: "V1043",
      },
      {
        account: "4010",
        text: `Inköp av pack, leverans ${day(2026, 9, 6)}`,
        amount: -firstDelivery,
        verification: "V1044",
      },
      {
        account: "4010",
        text: `Inköp av pack, leverans ${day(2026, 9, 20)}`,
        amount: -(Math.round((purchasesKr - firstDelivery) * 100) / 100),
        verification: "V1045",
      },
    ],
  },
  reportUrl: `${BASE_URL}/r/2026-10/bokforing`,
  attachments: [
    {
      name: "forsaljning-2026-10.csv",
      size: 96_000,
      description: `Alla ${formatInt(oct.orders)} Awish-ordrar med tid, automat och belopp`,
    },
    {
      name: "verifikationer-V1041-V1045.pdf",
      size: 1_240_000,
      description: "Fakturor och avtal för V1041–V1045",
    },
  ],
  reportId: "R-2026-10-01",
  generatedAt: GENERATED,
};

const MARGIN_GOAL = 0.35;
const opening = 118_400;
const outflow = Math.round(kr(oct.purchases + oct.storeCompensation));
const inflow = Math.round(kr(oct.revenue));

const delagare: ReportEmailProps = {
  recipientKind: "delagare",
  recipientName: "Johan",
  period: OCTOBER,
  summary: `Intäkten ökade ${formatPercent(oct.revenue / sep.revenue - 1)} mot september.`,
  kpis: [
    {
      label: "Intäkt",
      value: kr(oct.revenue),
      unit: "kr",
      change: { value: oct.revenue / sep.revenue - 1 },
    },
    {
      label: "Resultat",
      value: kr(oct.profit),
      unit: "kr",
      change: { value: oct.profit / sep.profit - 1 },
    },
    {
      label: "Marginal",
      value: oct.margin ?? 0,
      unit: "share",
      change: { value: (oct.margin ?? 0) - (sep.margin ?? 0), kind: "points" },
      ...((oct.margin ?? 0) < MARGIN_GOAL
        ? { alert: `Under målet ${formatPercent(MARGIN_GOAL, 0)}` }
        : {}),
    },
    {
      label: `Kassa ${day(2026, 9, 31)}`,
      value: opening + inflow - outflow,
      unit: "kr",
      change: { value: (inflow - outflow) / opening },
    },
  ],
  rows: perMachine
    .slice()
    .sort((a, b) => b.o.revenue - a.o.revenue)
    .map(({ m, store, o, p }) => ({
      id: m.code,
      name: store?.name ?? "",
      location: store?.city,
      revenue: kr(o.revenue),
      change: p.revenue ? o.revenue / p.revenue - 1 : undefined,
      margin: o.margin ?? undefined,
    })),
  daily: october(ALL),
  details: {
    result: [
      { label: "Intäkt med inköpspris", amount: kr(oct.pricedRevenue) },
      { label: "Varukostnad", amount: -kr(oct.purchases) },
      { label: "Butiksersättning", amount: -kr(oct.storeCompensation) },
      { label: "Resultat", amount: kr(oct.profit), total: true },
    ],
    margin: oct.margin ?? 0,
    cash: { opening, inflow, outflow, closing: opening + inflow - outflow },
    plan: [
      {
        title: "Lägg in inköpspris för Black Bolt",
        detail: `${formatInt(oct.unpricedOrders)} ordrar (${formatSek(kr(oct.unpricedRevenue))}) ingår inte i resultatet förrän priset finns.`,
      },
      {
        title: `Julinköp: ${formatInt(1_400)}${NBSP}pack`,
        detail: `Leverans ${day(2026, 10, 9)} Räcker till ${day(2026, 11, 13)} i oktobers försäljningstakt.`,
        amount: 42_000,
      },
      {
        title: "Fyll på BL-002 Mobilia oftare",
        detail: `Fack 3 tömdes ${day(2026, 9, 31)} Påfyllning varannan dag i december.`,
      },
    ],
  },
  reportUrl: `${BASE_URL}/r/2026-10`,
  attachments: [
    {
      name: "rapport-2026-10.pdf",
      size: 412_000,
      description: `Hela månadsrapporten, ${formatInt(8)}${NBSP}sidor`,
    },
  ],
  reportId: "R-2026-10-02",
  generatedAt: GENERATED,
};

export const sampleReportEmails: Record<RecipientKind, ReportEmailProps> = {
  butik,
  bokforing,
  delagare,
};
