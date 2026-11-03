/**
 * Kostnad och månadstak för Claude-anropen (rådgivaren och assistentens frågor).
 *
 *   AI_MONTHLY_BUDGET_SEK  tak per kalendermånad för hela installationen (standard 300)
 *   AI_USD_SEK             växelkurs för listpriset (standard 11, hellre för högt)
 *
 * Listpriser i USD per miljon tokens (platform.claude.com, 2026-10). Okänd modell räknas
 * med det dyraste priset, så att taket aldrig underskattas. Ren modul.
 */

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const FALLBACK_PRICE: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export const DEFAULT_MONTHLY_BUDGET_SEK = 300;
export const DEFAULT_USD_SEK = 11;

type Env = Readonly<Record<string, string | undefined>>;

function positive(value: string | undefined, fallback: number): number {
  const n = Number((value ?? "").trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function budgetFrom(env: Env): { budgetOre: number; usdSek: number } {
  return {
    budgetOre: Math.round(positive(env.AI_MONTHLY_BUDGET_SEK, DEFAULT_MONTHLY_BUDGET_SEK) * 100),
    usdSek: positive(env.AI_USD_SEK, DEFAULT_USD_SEK),
  };
}

/** Kostnaden i öre (SEK), avrundad uppåt. */
export function costOre(model: string, usage: TokenUsage, usdSek: number): number {
  const p = PRICES[model] ?? FALLBACK_PRICE;
  const usd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000;
  return Math.ceil(usd * usdSek * 100);
}

/** Första ögonblicket i kalendermånaden (svensk tid) som `now` ligger i, som Date. */
export function monthStart(now: Date, timeZone = "Europe/Stockholm"): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  return zonedMidnight(y, m, 1, timeZone);
}

/** Midnatt i tidszonen för dagen `now` ligger i. */
export function dayStart(now: Date, timeZone = "Europe/Stockholm"): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return zonedMidnight(get("year"), get("month"), get("day"), timeZone);
}

function zonedMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  // Tidszonens förskjutning vid gissningen (två varv räcker även över sommartidsskiften).
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const local = new Date(new Date(t).toLocaleString("en-US", { timeZone }));
    const utc = new Date(new Date(t).toLocaleString("en-US", { timeZone: "UTC" }));
    t = guess - (local.getTime() - utc.getTime());
  }
  return new Date(t);
}
