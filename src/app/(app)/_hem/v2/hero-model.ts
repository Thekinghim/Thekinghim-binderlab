/**
 * Hems hjältekort (mockarna i "visuellt/02"): rena hjälpare för uppställningen. Inga nya tal:
 * allt räknas i befintliga modeller (KPI-bandet, Lönsamhets dagsserie, månadens mål). Här
 * bara ordningen på de kompakta nyckeltalen, takten för målringen, sparklinjens geometri och
 * nyckeln för det engångsfirande när månadens mål nås.
 */

import { formatKronor } from "@/lib/format";

/**
 * Klassen som stoppar intro-rörelsen när Hem visas igen (HeroIntro). Ett eget namn med
 * hh-prefix: hem.css har redan `.hem2 .calm` (raden "Allt rullar" i Kräver åtgärd, en flexrad
 * med align-items: center och padding). Med samma namn fick hjälten den regeln när man kom
 * tillbaka till Hem, och korten krympte till innehållets bredd mitt på skärmen.
 */
export const HERO_CALM_CLASS = "hh-calm";

/** De kompakta nyckeltalen under hjältekortet, i mockens ordning (vinsten står i kortet). */
export const COMPACT_ORDER = [
  "revenue",
  "orders",
  "margin",
  "profit-today",
  "profit-30d",
  "aov",
  "per-machine",
  "stock-value",
] as const;

/**
 * Fotnoten under nyckeltalen när intäkten inte är alla order: Intäkt och Marginal räknas
 * (som på Pengar och Lönsamhet) bara på order med inköpspris, medan Sålda pack, Snittköp och
 * Mest sålda räknar alla order. null när alla order har inköpspris.
 */
export function revenueBasisNote(unpricedRevenueOre: number): string | null {
  if (unpricedRevenueOre <= 0) return null;
  const kr = formatKronor(unpricedRevenueOre / 100, { decimals: 0 });
  return `Intäkt och marginal räknas på order med inköpspris. ${kr} sålt utan pris räknas inte in.`;
}

/** Antal nyckeltal som syns på telefon innan "Visa alla nyckeltal". */
export const PHONE_KPIS = 4;

/**
 * Delar KPI-bandets rutor i hjälten (första rutan: periodens vinst, eller "Vinst i dag" med
 * perioden I dag) och resten i mockens ordning. Okända id:n hamnar sist i bandets ordning.
 */
export function splitKpis<T extends { readonly id: string }>(
  tiles: readonly T[],
): { hero: T | null; rest: T[] } {
  const [hero, ...rest] = tiles;
  const rank = (id: string) => {
    const i = (COMPACT_ORDER as readonly string[]).indexOf(id);
    return i === -1 ? COMPACT_ORDER.length : i;
  };
  return {
    hero: hero ?? null,
    rest: rest
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i)
      .map((x) => x.t),
  };
}

/** Dag i månaden och antal dagar i månaden ur ett ISO-datum ("2026-11-23" → 23, 30). */
export function monthDay(today: string): { day: number; daysInMonth: number } {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return { day: d, daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

/**
 * Takten för målringen: var man borde vara vid dagens slut om målet fördelas jämnt över
 * månadens dagar (mål × dag ÷ dagar i månaden), och hur långt efter utfallet ligger (0 när
 * man ligger före eller i fas). Målet ≤ 0 ger ingen takt.
 */
export function goalPace(
  actual: number,
  target: number,
  day: number,
  daysInMonth: number,
): { pace: number | null; behind: number } {
  if (target <= 0 || daysInMonth <= 0) return { pace: null, behind: 0 };
  const pace = Math.round((target * Math.min(day, daysInMonth)) / daysInMonth);
  return { pace, behind: Math.max(0, pace - actual) };
}

/**
 * Sparklinjen i hjältekortet: vinst per dag (grön linje och yta) och förra perioden
 * (streckad, samma skala). Rutan är W × H; värden under 0 ritas på nollan (förlustdagar
 * står i Pengar). Förra perioden räknas om till samma antal punkter som nuvarande.
 */
export function sparkGeometry(
  current: readonly number[],
  previous: readonly number[] | null,
  width = 300,
  height = 96,
): { line: string; area: string; previous: string | null } | null {
  if (current.length < 2) return null;
  const prev = previous && previous.length >= 2 ? resample(previous, current.length) : null;
  const max = Math.max(1, ...current, ...(prev ?? [])) * 1.08;
  const n = current.length - 1;
  const x = (i: number) => 1 + (i * (width - 6)) / n;
  const y = (v: number) => height - 4 - (Math.max(0, v) / max) * (height - 10);
  const path = (vs: readonly number[]) =>
    vs.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const line = path(current);
  return {
    line,
    area: `${line}L${x(n).toFixed(1)},${height}L${x(0).toFixed(1)},${height}Z`,
    previous: prev ? path(prev) : null,
  };
}

/** Linjär omsampling till `n` punkter (förra perioden kan ha en dag mer eller mindre). */
export function resample(values: readonly number[], n: number): number[] {
  if (values.length === n || n < 2) return [...values];
  const last = values.length - 1;
  return Array.from({ length: n }, (_, i) => {
    const pos = (i * last) / (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(last, lo + 1);
    const f = pos - lo;
    return (values[lo] ?? 0) * (1 - f) + (values[hi] ?? 0) * f;
  });
}

/** Tre etiketter under sparklinjen: första, mittersta och sista. */
export function axisLabels(labels: readonly string[]): string[] {
  if (labels.length === 0) return [];
  if (labels.length <= 2) return [...labels];
  return [labels[0]!, labels[Math.floor((labels.length - 1) / 2)]!, labels[labels.length - 1]!];
}

/**
 * Nyckeln i webbläsarens lagring för att månadens mål redan är firat: per organisation,
 * person, månad och mål, så att firandet kommer en gång per månad och person.
 */
export function celebrateKey(orgId: string, userId: string, month: string, goalId: string): string {
  return `binderlab:mal-firat:${orgId}:${userId}:${month}:${goalId}`;
}

/** "7 dagar före månadens slut", "1 dag före …", "på månadens sista dag". */
export function aheadText(daysLeft: number): string {
  if (daysLeft <= 0) return "på månadens sista dag";
  return `${daysLeft} ${daysLeft === 1 ? "dag" : "dagar"} före månadens slut`;
}
