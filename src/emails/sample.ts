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
import { seeded } from "@/lib/random";
import type { DailyPoint, RecipientKind, ReportEmailProps } from "./report-content";

/**
 * Exempelmejl för oktober 2026, ett per mottagartyp. Siffrorna hänger
 * ihop: delägarens resultat, bokhållarens verifikationer och butikens
 * automater bygger på samma månad. Deterministiska, så server och klient
 * ger samma HTML.
 */

const OCTOBER = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) };
const GENERATED = new Date(2026, 10, 2, 7, 0);
const BASE_URL = "https://app.binderlab.se";

/** "9 nov." med hårt mellanslag (månad 0–11). */
const day = (y: number, m: number, d: number) => formatDate(new Date(y, m, d), { year: "never" });

/** Dagsförsäljning för oktober som summerar exakt till `total`. Toppen lör 24 okt. (släpp). */
function october(total: number, seed: number): DailyPoint[] {
  const rnd = seeded(seed);
  const weights = Array.from({ length: 31 }, (_, i) => {
    const date = new Date(2026, 9, i + 1);
    const dow = date.getDay();
    const weekend = dow === 6 ? 1.45 : dow === 0 ? 1.22 : dow === 5 ? 1.16 : 1;
    const release = i + 1 === 24 ? 1.7 : i + 1 === 25 ? 1.25 : 1;
    const payday = i + 1 === 23 || i + 1 === 26 ? 1.12 : 1;
    return weekend * release * payday * (0.86 + rnd() * 0.26);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const values = weights.map((w) => Math.round((w / sum) * total));
  // Avrundningsresten läggs på sista dagen så att summan stämmer.
  values[30] = (values[30] ?? 0) + total - values.reduce((a, b) => a + b, 0);
  return values.map((value, i) => ({
    date: new Date(2026, 9, i + 1),
    value,
    note: i + 1 === 24 ? "släppdag för ny serie" : undefined,
  }));
}

const butik: ReportEmailProps = {
  recipientKind: "butik",
  recipientName: "Maria",
  period: OCTOBER,
  summary: `Automaterna var i drift ${formatPercent(0.992)} av öppettiden.`,
  kpis: [
    { label: "Försäljning", value: 18_420, unit: "kr", change: { value: 0.062 } },
    { label: "Sålda pack", value: 256, unit: "count", change: { value: 0.08 } },
    { label: "I drift", value: 0.992, unit: "share", change: { value: 0.004, kind: "points" } },
    {
      label: "Avbrott",
      value: 2,
      unit: "count",
      note: `Totalt ${formatDuration(164 * 60_000).replace(/ /g, NBSP)}`,
      lowerIsBetter: true,
    },
  ],
  rows: [
    {
      id: "BL-001",
      name: "Entré Syd, plan 2",
      revenue: 13_870,
      packs: 190,
      availability: 0.996,
    },
    {
      id: "BL-015",
      name: "Foodcourten, plan 1",
      revenue: 4_550,
      packs: 66,
      availability: 0.981,
    },
  ],
  daily: october(18_420, 11),
  details: {
    siteName: "Mall of Scandinavia",
    availability: 0.992,
    incidents: [
      {
        start: new Date(2026, 9, 14, 11, 20),
        durationMs: (2 * 60 + 5) * 60_000,
        cause: "kortterminalen tappade anslutningen",
      },
      {
        start: new Date(2026, 9, 27, 16, 2),
        durationMs: 39 * 60_000,
        cause: `fack${NBSP}4 fastnade, löst på plats`,
      },
    ],
    busiest: "Lördagar 13–16",
    refills: { count: 9, last: new Date(2026, 9, 30) },
    nextVisit: new Date(2026, 10, 3, 7, 30),
    contact: { name: "Erik Sand", phone: "070-174 06 42" },
  },
  reportUrl: `${BASE_URL}/r/2026-10/mall-of-scandinavia`,
  attachments: [
    {
      name: "omsattning-mos-2026-10.pdf",
      size: 96_000,
      description: "Försäljning per dag inkl. moms, underlag för omsättningshyran",
    },
  ],
  reportId: "R-2026-10-03",
  generatedAt: GENERATED,
};

const bokforing: ReportEmailProps = {
  recipientKind: "bokforing",
  recipientName: "Karin",
  period: OCTOBER,
  summary: `Försäljningen var ${formatKronor(131_400)} inklusive moms.`,
  kpis: [
    {
      label: "Försäljning",
      value: 131_400,
      unit: "kr",
      note: `Inkl. moms · exkl. ${formatSek(105_120)}`,
    },
    {
      label: "Utgående moms",
      value: 26_280,
      unit: "kr",
      note: `${formatPercent(0.25, 0)} på all försäljning`,
    },
    {
      label: "Avgifter",
      value: 12_689.63,
      unit: "kr",
      note: `Kort ${formatSek(2_889.63)} · platshyra ${formatSek(9_800)}`,
    },
    {
      label: "Försäljningar",
      value: 1_812,
      unit: "count",
      note: `Varav ${formatInt(3)} återbetalda`,
    },
  ],
  rows: [
    { id: "BL-002", name: "Nordstan", location: "Göteborg", revenue: 14_980, revenueExVat: 11_984 },
    {
      id: "BL-001",
      name: "Mall of Scandinavia",
      location: "Solna",
      revenue: 13_870,
      revenueExVat: 11_096,
    },
    { id: "BL-004", name: "Emporia", location: "Malmö", revenue: 12_410, revenueExVat: 9_928 },
    {
      id: "BL-008",
      name: "Kungens Kurva",
      location: "Huddinge",
      revenue: 11_260,
      revenueExVat: 9_008,
    },
    { id: "BL-003", name: "Täby Centrum", location: "Täby", revenue: 10_940, revenueExVat: 8_752 },
  ],
  rowsTotal: 15,
  details: {
    company: "Binderlab AB",
    transactions: 1_812,
    entries: [
      {
        account: "3001",
        text: `Försäljning varor, ${formatPercent(0.25, 0)} moms`,
        amount: 105_120,
        verification: "V1041",
      },
      {
        account: "2611",
        text: `Utgående moms, ${formatPercent(0.25, 0)}`,
        amount: 26_280,
        verification: "V1041",
      },
      { account: "6570", text: "Kortavgifter", amount: -2_889.63, verification: "V1042" },
      {
        account: "5010",
        text: `Platshyra, ${formatInt(15)} platser`,
        amount: -9_800,
        verification: "V1043",
      },
      {
        account: "4010",
        text: `Inköp av pack, leverans ${day(2026, 9, 6)}`,
        amount: -31_400,
        verification: "V1044",
      },
      {
        account: "4010",
        text: `Inköp av pack, leverans ${day(2026, 9, 20)}`,
        amount: -26_800,
        verification: "V1045",
      },
    ],
  },
  reportUrl: `${BASE_URL}/r/2026-10/bokforing`,
  attachments: [
    {
      name: "forsaljning-2026-10.csv",
      size: 214_000,
      description: `Alla ${formatInt(1_812)} försäljningar med tid, automat och belopp`,
    },
    {
      name: "kortinlosen-2026-10.pdf",
      size: 88_000,
      description: "Avräkning från kortinlösaren",
    },
    {
      name: "verifikationer-V1041-V1045.pdf",
      size: 1_240_000,
      description: "Fakturor och kvitton för V1041–V1045",
    },
  ],
  reportId: "R-2026-10-01",
  generatedAt: GENERATED,
};

const delagare: ReportEmailProps = {
  recipientKind: "delagare",
  recipientName: "Johan",
  period: OCTOBER,
  summary: `Intäkten ökade ${formatPercent(0.124)} mot september.`,
  kpis: [
    { label: "Intäkt", value: 131_400, unit: "kr", change: { value: 0.124 } },
    { label: "Resultat", value: 31_080, unit: "kr", change: { value: 0.091 } },
    {
      label: "Marginal",
      value: 0.2957,
      unit: "share",
      change: { value: -0.009, kind: "points" },
      alert: `Under målet ${formatPercent(0.3, 0)}`,
    },
    { label: `Kassa ${day(2026, 9, 31)}`, value: 151_529, unit: "kr", change: { value: 0.28 } },
  ],
  rows: [
    {
      id: "BL-002",
      name: "Nordstan",
      location: "Göteborg",
      revenue: 14_980,
      change: 0.182,
      margin: 0.331,
    },
    {
      id: "BL-001",
      name: "Mall of Scandinavia",
      location: "Solna",
      revenue: 13_870,
      change: 0.064,
      margin: 0.318,
    },
    {
      id: "BL-004",
      name: "Emporia",
      location: "Malmö",
      revenue: 12_410,
      change: 0.149,
      margin: 0.302,
    },
    {
      id: "BL-008",
      name: "Kungens Kurva",
      location: "Huddinge",
      revenue: 11_260,
      change: -0.031,
      margin: 0.294,
    },
    {
      id: "BL-003",
      name: "Täby Centrum",
      location: "Täby",
      revenue: 10_940,
      change: 0.097,
      margin: 0.326,
    },
  ],
  rowsTotal: 15,
  daily: october(131_400, 42),
  details: {
    result: [
      { label: "Intäkt exkl. moms", amount: 105_120 },
      { label: "Varukostnad", amount: -58_200 },
      { label: "Kortavgifter", amount: -2_889.63 },
      { label: "Platshyra", amount: -9_800 },
      { label: "Svinn", amount: -3_150 },
      { label: "Resultat", amount: 31_080.37, total: true },
    ],
    margin: 0.2957,
    cash: { opening: 118_400, inflow: 128_510, outflow: 95_381, closing: 151_529 },
    plan: [
      {
        title: `Julinköp: ${formatInt(1_400)}${NBSP}pack`,
        detail: `Leverans ${day(2026, 10, 9)} Räcker till ${day(2026, 11, 13)} i oktobers försäljningstakt.`,
        amount: 72_000,
      },
      {
        title: "Flytta BL-014 från Kista Galleria till Täby Centrum",
        detail: `Kista Galleria sålde ${formatPercent(0.41, 0)} under snittet i oktober. Flytt ${day(2026, 10, 16)}`,
        amount: 4_500,
      },
      {
        title: `Höj priset på One Piece-pack från ${formatSek(79)} till ${formatSek(85)}`,
        detail: `Gäller från ${day(2026, 10, 1)} Väntad effekt ${formatSignedKronor(2_100, { decimals: 0 })} i månaden.`,
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
