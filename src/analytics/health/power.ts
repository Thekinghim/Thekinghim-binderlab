/**
 * Butikens strömtider: när strömmen till automaten går på och av varje dag (lokal tid i
 * organisationens tidszon, Europe/Stockholm). Rena funktioner: `now` är den enda tidskällan.
 *
 * Vissa butiker stänger av strömmen till automaten på natten (t.ex. av 21:00, på 10:00).
 * Awish ser då automaten som offline varje natt. Det är inget fel, så:
 *
 *   - En offlineperiod som BÖRJAR i ett strömavbrott enligt tiderna räknas som "strömmen av"
 *     tills strömmen gått på igen plus POWER_ON_GRACE_MINUTES (automaten startar och kopplar
 *     upp sig). Ingen offlinestatus, inget larm, ingen notis.
 *   - "Börjar i strömavbrottet" räknas från OFFLINE_ALERT_MINUTES före av-tiden: en automat
 *     som tappar anslutningen 20:50 (butiken stängde av lite tidigt) hade inte hunnit larma
 *     före 21:00 och räknas också som strömmen av.
 *   - Är automaten fortfarande offline när marginalen efter på-tiden är slut är det ett riktigt
 *     avbrott. Det räknas från på-tiden (då automaten skulle ha kommit tillbaka) och larmar
 *     som vanligt.
 *   - En period som började när strömmen var på (t.ex. 15:00) är ett riktigt avbrott och
 *     larmar hela natten, som förut. Ett riktigt avbrott göms aldrig.
 *
 * Av-tid efter midnatt fungerar (på 07:00, av 01:00). Tiderna är väggtid: på dagar då
 * sommartiden börjar eller slutar gäller samma klockslag (ett avbrott blir då en timme
 * längre eller kortare). Ett klockslag som inte finns den dagen (02:30 när klockan hoppar
 * fram) räknas en timme senare (03:30).
 */

import type { IsoDate } from "@/domain";
import { DEFAULT_TIME_ZONE, localParts } from "@/analytics/todos/time";

/** Minuter efter att strömmen gått på som automaten får på sig att starta och koppla upp sig. */
export const POWER_ON_GRACE_MINUTES = 30;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Butikens strömtider, "TT:MM" (24 h). */
export interface PowerHours {
  /** Strömmen går på (t.ex. "10:00"). */
  readonly on: string;
  /** Strömmen går av (t.ex. "21:00"). Får vara efter midnatt ("01:00"). */
  readonly off: string;
  /** Tidszonen tiderna gäller i (organisationens). Saknas = Europe/Stockholm. */
  readonly timeZone?: string;
}

/** Ett strömavbrott enligt tiderna: [offMs, onMs). */
export interface PowerOffWindow {
  readonly offMs: number;
  readonly onMs: number;
}

/** "10:00" → 600. Ogiltigt → null. Sekunder ("10:00:00", som Postgres skriver time) tas bort. */
export function parsePowerTime(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 600 → "10:00". */
export function formatPowerTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}`;
}

/**
 * Strömtiderna ur två sparade värden (stores.power_on_time / power_off_time). Båda måste
 * finnas, vara giltiga och olika; annars null = strömmen är alltid på.
 */
export function powerHoursOf(
  on: string | null | undefined,
  off: string | null | undefined,
  timeZone?: string,
): PowerHours | null {
  const a = parsePowerTime(on);
  const b = parsePowerTime(off);
  if (a === null || b === null || a === b) return null;
  return {
    on: formatPowerTime(a),
    off: formatPowerTime(b),
    ...(timeZone ? { timeZone } : {}),
  };
}

function addDaysIso(date: IsoDate, days: number): IsoDate {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
  return d.toISOString().slice(0, 10) as IsoDate;
}

/** Väggtid − UTC vid en tidpunkt (ms, på minuten). */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const wall = Date.parse(`${p.date}T${p.time}:00Z`);
  return wall - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * Tidpunkten för väggtiden `minutes` efter midnatt på `date` i tidszonen. Finns klockslaget
 * två gånger (klockan ställs tillbaka) blir det det första; finns det inte (klockan hoppar
 * fram) blir det en timme senare (02:30 blir 03:30).
 */
export function wallClockMs(date: IsoDate, minutes: number, timeZone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * MINUTE_MS;
  const target = `${date}T${formatPowerTime(minutes)}`;
  const candidates = [
    wall - offsetAt(wall - 12 * HOUR_MS, timeZone),
    wall - offsetAt(wall + 12 * HOUR_MS, timeZone),
  ].sort((a, b) => a - b);
  for (const c of candidates) {
    const p = localParts(c, timeZone);
    if (`${p.date}T${p.time}` === target) return c;
  }
  // Klockslaget finns inte (hoppet fram): en timme senare, efter hoppet.
  return candidates[1]!;
}

/** Strömavbrottet som börjar på den lokala dagen `date`. */
function windowStarting(date: IsoDate, on: number, off: number, timeZone: string): PowerOffWindow {
  const offMs = wallClockMs(date, off, timeZone);
  const onMs = wallClockMs(on > off ? date : addDaysIso(date, 1), on, timeZone);
  return { offMs, onMs };
}

/**
 * Strömavbrotten som kan beröra tidpunkten: de som börjar dagen före, samma dag och dagen
 * efter (lokal tid), äldst först.
 */
export function powerOffWindowsAround(power: PowerHours, ms: number): PowerOffWindow[] {
  const on = parsePowerTime(power.on);
  const off = parsePowerTime(power.off);
  if (on === null || off === null || on === off) return [];
  const timeZone = power.timeZone ?? DEFAULT_TIME_ZONE;
  const today = localParts(ms, timeZone).date;
  return [-1, 0, 1].map((d) => windowStarting(addDaysIso(today, d), on, off, timeZone));
}

/** Strömavbrottet som pågår vid tidpunkten, annars null. */
export function powerOffWindowAt(
  power: PowerHours | null | undefined,
  ms: number,
): PowerOffWindow | null {
  if (!power) return null;
  return powerOffWindowsAround(power, ms).find((w) => ms >= w.offMs && ms < w.onMs) ?? null;
}

/** Sant när strömmen är av enligt butikens tider vid tidpunkten. */
export function isPowerOffAt(power: PowerHours | null | undefined, ms: number): boolean {
  return powerOffWindowAt(power, ms) !== null;
}

/**
 * Strömavbrottet som förklarar en offlineperiod som började vid `fromMs`, eller null.
 * Perioden förklaras när den började från `leadMinutes` före av-tiden till marginalen efter
 * på-tiden (`graceMinutes`).
 */
export function explainingWindow(
  power: PowerHours | null | undefined,
  fromMs: number,
  options: { leadMinutes: number; graceMinutes?: number },
): PowerOffWindow | null {
  if (!power) return null;
  const lead = options.leadMinutes * MINUTE_MS;
  const grace = (options.graceMinutes ?? POWER_ON_GRACE_MINUTES) * MINUTE_MS;
  return (
    powerOffWindowsAround(power, fromMs).find(
      (w) => fromMs >= w.offMs - lead && fromMs < w.onMs + grace,
    ) ?? null
  );
}

/** Hur en offlineperiod ska räknas med butikens strömtider. */
export type PowerVerdict =
  /** Strömmen är av enligt tiderna (eller automaten startar fortfarande): inget avbrott. */
  | { readonly kind: "power_off"; readonly onMs: number; readonly untilMs: number }
  /** Ett riktigt avbrott, räknat från `fromMs`. */
  | { readonly kind: "outage"; readonly fromMs: number };

/**
 * Bedömningen av en offlineperiod som började vid `fromMs`, vid tidpunkten `nowMs`:
 *   - började i ett strömavbrott (se explainingWindow) och marginalen efter på-tiden är inte
 *     slut → power_off (på igen `onMs`, larmar tidigast `untilMs`)
 *   - började i ett strömavbrott men automaten är inte tillbaka när marginalen är slut →
 *     outage från på-tiden (eller från periodens början, om den började efter på-tiden)
 *   - annars → outage från periodens början (som utan strömtider)
 */
export function powerVerdict(
  power: PowerHours | null | undefined,
  fromMs: number,
  nowMs: number,
  options: { leadMinutes: number; graceMinutes?: number },
): PowerVerdict {
  const w = explainingWindow(power, fromMs, options);
  if (!w) return { kind: "outage", fromMs };
  const untilMs = w.onMs + (options.graceMinutes ?? POWER_ON_GRACE_MINUTES) * MINUTE_MS;
  if (nowMs < untilMs) return { kind: "power_off", onMs: w.onMs, untilMs };
  return { kind: "outage", fromMs: Math.max(fromMs, w.onMs) };
}

/** "Strömmen är av 21:00–10:00." för texterna. */
export function powerHoursText(power: PowerHours): string {
  return `Strömmen är av ${power.off}–${power.on}.`;
}
