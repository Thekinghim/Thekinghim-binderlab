/**
 * Perioder och kalenderdagar.
 *
 * En period är ett intervall av hela kalenderdagar i lokal tid, där både
 * start och slut ingår: { start: 1 nov, end: 30 nov } är 30 dagar.
 * Klockslaget i start och end ignoreras; funktionerna här returnerar alltid
 * datum vid midnatt lokal tid.
 *
 * All aritmetik går via kalenderfält (år, månad, dag), aldrig via
 * millisekunder, så att resultatet stämmer även över sommartidsskiften
 * (då ett dygn är 23 eller 25 timmar).
 */

export type Period = {
  /** Första dagen, inklusive. */
  start: Date;
  /** Sista dagen, inklusive. */
  end: Date;
};

export type PeriodPreset = "idag" | "7d" | "30d" | "90d" | "atd" | "manad" | "forra-manaden";

/** Förval i den ordning de visas i periodväljaren. */
export const periodPresets: ReadonlyArray<{ id: PeriodPreset; label: string; short: string }> = [
  { id: "idag", label: "Idag", short: "Idag" },
  { id: "7d", label: "Senaste 7 dagarna", short: "7 d" },
  { id: "30d", label: "Senaste 30 dagarna", short: "30 d" },
  { id: "90d", label: "Senaste 90 dagarna", short: "90 d" },
  { id: "manad", label: "Denna månad", short: "Mån" },
  { id: "forra-manaden", label: "Förra månaden", short: "Förra mån" },
  { id: "atd", label: "Året hittills", short: "ÅTD" },
];

const DAY_MS = 86_400_000;

/** Midnatt lokal tid samma kalenderdag. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Lägger till hela kalenderdagar (negativt värde går bakåt). Säkert över sommartidsskiften. */
export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** Första dagen i månaden. */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Sista dagen i månaden (hanterar skottår). */
export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Antal kalenderdagar från a till b (b − a). Oberoende av klockslag och sommartid. */
export function calendarDaysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / DAY_MS);
}

/** Antal dagar i perioden, båda ändar inräknade. 1 nov – 30 nov → 30. */
export function daysInPeriod(p: Period): number {
  return calendarDaysBetween(p.start, p.end) + 1;
}

/** Normaliserar till midnatt och byter plats på start/slut om de är omvända. */
export function normalizePeriod(p: Period): Period {
  const a = startOfDay(p.start);
  const b = startOfDay(p.end);
  return a.getTime() <= b.getTime() ? { start: a, end: b } : { start: b, end: a };
}

/** Perioden täcker exakt en hel kalendermånad. */
export function isFullMonth(p: Period): boolean {
  return (
    p.start.getDate() === 1 &&
    p.start.getFullYear() === p.end.getFullYear() &&
    p.start.getMonth() === p.end.getMonth() &&
    isSameDay(p.end, endOfMonth(p.start))
  );
}

/** Perioden börjar den 1:a i en månad och slutar sista dagen i en (annan eller samma) månad. */
export function isWholeMonths(p: Period): boolean {
  return p.start.getDate() === 1 && isSameDay(p.end, endOfMonth(p.end));
}

/** Perioden täcker ett eller flera hela kalenderår. */
export function isWholeYears(p: Period): boolean {
  return (
    p.start.getMonth() === 0 &&
    p.start.getDate() === 1 &&
    p.end.getMonth() === 11 &&
    p.end.getDate() === 31
  );
}

/**
 * Perioden för ett förval, räknat från `now` (dagens datum ingår alltid).
 *
 * - idag: bara dagens datum
 * - 7d / 30d / 90d: de senaste N dagarna inklusive idag
 * - manad: från den 1:a i innevarande månad till idag
 * - forra-manaden: hela föregående kalendermånad
 * - atd: från 1 januari till idag
 */
export function periodFromPreset(preset: PeriodPreset, now: Date = new Date()): Period {
  const today = startOfDay(now);
  switch (preset) {
    case "idag":
      return { start: today, end: today };
    case "7d":
      return { start: addDays(today, -6), end: today };
    case "30d":
      return { start: addDays(today, -29), end: today };
    case "90d":
      return { start: addDays(today, -89), end: today };
    case "manad":
      return { start: startOfMonth(today), end: today };
    case "forra-manaden": {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return { start, end: endOfMonth(start) };
    }
    case "atd":
      return { start: new Date(today.getFullYear(), 0, 1), end: today };
  }
}

/**
 * Lika lång period som slutar dagen före `p` börjar. Används för jämförelser
 * ("mot föregående period"). 1–30 nov → 2–31 okt.
 */
export function previousPeriod(p: Period): Period {
  const n = normalizePeriod(p);
  const days = daysInPeriod(n);
  const end = addDays(n.start, -1);
  return { start: addDays(end, -(days - 1)), end };
}
