import type { Period } from "@/components/shell/topbar";
import type { Status } from "@/components/ui/status-tag";
import { seeded } from "@/lib/random";

/** Exempeldata för /design. Deterministisk, så server och klient stämmer. */

const END = new Date(2026, 10, 1); // 1 nov 2026, fast för stabil rendering
const DAY = 86_400_000;

export const periodDays: Record<Period, number> = {
  idag: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  atd: 305,
};

export const periodLabel: Record<Period, string> = {
  idag: "idag",
  "7d": "7 dagar",
  "30d": "30 dagar",
  "90d": "90 dagar",
  atd: "året hittills",
};

const RELEASE = new Date(2026, 9, 24).getTime(); // lör 24 okt: nytt släpp

function dailyValue(t: number, rnd: () => number, scale = 1) {
  const d = new Date(t);
  const dow = d.getDay();
  const weekend = dow === 6 ? 1.45 : dow === 0 ? 1.25 : dow === 5 ? 1.18 : 1;
  const season = 1 + 0.18 * Math.sin((t / DAY / 365) * Math.PI * 2 - 1.2);
  const release =
    Math.abs(t - RELEASE) < DAY / 2 ? 1.62 : Math.abs(t - RELEASE) < DAY * 1.5 ? 1.2 : 1;
  return Math.round(4100 * weekend * season * release * scale * (0.86 + rnd() * 0.28));
}

export function revenueSeries(period: Period) {
  const n = Math.max(14, periodDays[period]);
  const rnd = seeded(42);
  const rndPrev = seeded(7);
  const data = Array.from({ length: n }, (_, i) => {
    const t = END.getTime() - (n - 1 - i) * DAY;
    return { date: new Date(t), value: dailyValue(t, rnd) };
  });
  const compare = data.map((d) => dailyValue(d.date.getTime() - n * DAY, rndPrev, 0.88));
  let best = 0;
  data.forEach((d, i) => {
    if (d.value > (data[best]?.value ?? 0)) best = i;
  });
  const bestPoint = data[best];
  const weekBefore = data[best - 7];
  const weekDelta = bestPoint && weekBefore ? bestPoint.value / weekBefore.value - 1 : undefined;
  return { data, compare, best, weekDelta };
}

export function kpis(period: Period) {
  const days = periodDays[period];
  const rnd = seeded(days * 13);
  // Samma siffror som tabellen, så att summorna stämmer överallt.
  const fleet = machines(period);
  const revenue = fleet.reduce((acc, m) => acc + m.revenue, 0);
  const packs = fleet.reduce((acc, m) => acc + m.packs, 0);
  const margin = 0.34 + rnd() * 0.04;
  const trend = revenueSeries(period)
    .data.slice(-14)
    .map((d) => d.value);
  return {
    revenue,
    revenueDelta: 0.06 + rnd() * 0.12,
    packs,
    packsDelta: 0.03 + rnd() * 0.1,
    margin: margin * 100,
    marginDelta: -0.012 - rnd() * 0.02,
    stockouts: Math.max(1, Math.round(days * 0.18)),
    stockoutsDelta: 0.4,
    trend,
    packTrend: trend.map((v) => v / 74),
    marginTrend: trend.map((v, i) => 36 - (i % 5) * 0.4 + v / 4000),
    stockTrend: [1, 0, 2, 1, 1, 3, 2, 2, 4, 3, 3, 5, 4, 6],
  };
}

export type Machine = {
  id: string;
  site: string;
  city: string;
  status: Status;
  revenue: number;
  packs: number;
  margin: number;
  fill: number;
  refill: string;
};

const SITES: Array<[string, string]> = [
  ["Mall of Scandinavia", "Solna"],
  ["Nordstan", "Göteborg"],
  ["Täby Centrum", "Täby"],
  ["Emporia", "Malmö"],
  ["Gallerian", "Stockholm"],
  ["Väla Centrum", "Helsingborg"],
  ["Mobilia", "Malmö"],
  ["Kungens Kurva", "Huddinge"],
  ["Allum", "Partille"],
  ["Westfield Arninge", "Täby"],
  ["Gränby Centrum", "Uppsala"],
  ["Tornby", "Linköping"],
  ["Erikslund", "Västerås"],
  ["Kista Galleria", "Stockholm"],
];

export function machines(period: Period): Machine[] {
  const days = periodDays[period];
  const rnd = seeded(99);
  return SITES.map(([site, city], i) => {
    const weight = 0.55 + rnd() * 0.9;
    const status: Status =
      i === 9 ? "critical" : i === 13 ? "offline" : i === 4 || i === 11 ? "warning" : "ok";
    const revenue = status === "offline" ? Math.round(days * 90) : Math.round(days * 310 * weight);
    return {
      id: `BL-${String(i + 1).padStart(3, "0")}`,
      site,
      city,
      status,
      revenue,
      packs: Math.round(revenue / (68 + rnd() * 14)),
      margin: 0.28 + rnd() * 0.14,
      fill: status === "critical" ? 0.06 : status === "warning" ? 0.18 : 0.32 + rnd() * 0.6,
      refill: `${Math.ceil(rnd() * 9)} d sedan`,
    };
  });
}

export const waterfallSteps = [
  { label: "Brutto", value: 131_400, name: "Bruttoförsäljning" },
  { label: "Moms", value: -26_280, name: "Utgående moms 25 %" },
  { label: "Kort", value: -2_890, name: "Kortavgifter" },
  { label: "Inköp", value: -58_200, name: "Inköp av pack" },
  { label: "Hyra", value: -9_800, name: "Platshyra" },
  { label: "Svinn", value: -3_150, name: "Svinn och skador", flag: true },
  { label: "Netto", value: 0, total: true, name: "Nettoresultat" },
] as const;

export const heatHours = Array.from({ length: 14 }, (_, i) => `${String(i + 8).padStart(2, "0")}`);
export const heatDays = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];

export function heatValues(): number[][] {
  const rnd = seeded(5);
  return heatDays.map((_, d) =>
    heatHours.map((_, h) => {
      const hour = h + 8;
      const lunch = Math.exp(-((hour - 12.5) ** 2) / 3) * 0.6;
      const after = Math.exp(-((hour - (d >= 5 ? 14 : 17)) ** 2) / 5) * 1.1;
      const weekend = d === 5 ? 1.55 : d === 6 ? 1.3 : d === 4 ? 1.15 : 1;
      return Math.round((4 + 22 * (lunch + after)) * weekend * (0.85 + rnd() * 0.3));
    }),
  );
}

export const franchiseShare = [
  { label: "Pokémon", value: 71_820 },
  { label: "One Piece", value: 24_110 },
  { label: "Lorcana", value: 15_640 },
  { label: "Magic: The Gathering", value: 11_930 },
  { label: "Övrigt", value: 7_900 },
];
