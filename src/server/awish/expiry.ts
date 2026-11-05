/**
 * Awish-kontots slutdag (Merchant.expired_at). Rena funktioner: tolkningen av Awish tid och
 * påminnelsen som Att göra, Drift och Datakällor visar.
 *
 *   mer än 30 dagar kvar   → ingen påminnelse
 *   30–8 dagar kvar        → 'soon':  "Awish-kontot går ut 18 apr. 2027 – förläng hos Awish"
 *   7 dagar kvar eller färre → 'now' (brådskande), samma text
 *   redan utgånget         → 'now':  "Awish-kontot gick ut 18 apr. 2027 – förläng hos Awish"
 *
 * Dagarna räknas i organisationens tidszon (kalenderdagar), slutdagen är dagen i den zonen.
 */

import { businessDateAt } from "@/analytics/todos/time";
import { day } from "@/analytics/todos/text";
import { daysBetween, type IsoDate } from "@/domain";
import { parseSourceDateTime, zonedToUtc } from "@/import/zoned";

/** Dagar före slutdagen som påminnelsen kommer. */
export const EXPIRY_SOON_DAYS = 30;
/** Dagar före slutdagen som påminnelsen blir brådskande. */
export const EXPIRY_URGENT_DAYS = 7;
/** Merchant läses högst så här ofta (ms). */
export const MERCHANT_CHECK_INTERVAL_MS = 24 * 3_600_000;

/**
 * Merchant.expired_at som tidpunkt. Awish skickar "2027-04-18 23:48:54" i kontots tidszon
 * (källans tidszon, som pay_time); ett datum utan tid är slutet av dagen, ett heltal är
 * Unix-sekunder (eller millisekunder). null = saknas eller går inte att tolka.
 */
export function parseMerchantExpiry(
  text: string | null | undefined,
  timeZone: string,
): Date | null {
  const t = (text ?? "").trim();
  if (t === "") return null;
  if (/^\d{9,13}$/.test(t)) {
    const n = Number(t);
    const ms = t.length >= 12 ? n : n * 1000;
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
  }
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t} 23:59:59` : t;
  const parsed = parseSourceDateTime(withTime);
  if (!parsed.ok) return null;
  return parsed.kind === "absolute" ? parsed.utc : zonedToUtc(parsed.local, timeZone).utc;
}

/** Är det dags att läsa Merchant igen (högst en gång per dygn)? */
export function merchantCheckDue(checkedAt: Date | null, now: Date): boolean {
  return checkedAt === null || now.getTime() - checkedAt.getTime() >= MERCHANT_CHECK_INTERVAL_MS;
}

/** Påminnelsen om Awish-kontot. */
export interface AwishExpiryNotice {
  /** 'now' = brådskande (högst 7 dagar kvar eller utgånget), 'soon' = inom 30 dagar. */
  readonly level: "now" | "soon";
  /** Slutdagen i organisationens tidszon. */
  readonly date: IsoDate;
  /** Hela dagar kvar (negativt = utgånget). */
  readonly daysLeft: number;
  /** "Awish-kontot går ut 18 apr. 2027 – förläng hos Awish" */
  readonly text: string;
}

/** "18 apr. 2027" */
export function expiryDateText(date: IsoDate): string {
  return `${day(date)} ${date.slice(0, 4)}`;
}

/** Påminnelsen, eller null när slutdagen är okänd eller mer än 30 dagar bort. */
export function awishExpiryNotice(
  expiresAt: Date | string | null,
  now: Date,
  timeZone: string,
): AwishExpiryNotice | null {
  if (expiresAt === null) return null;
  const at = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  if (!Number.isFinite(at.getTime())) return null;
  const date = businessDateAt(at, timeZone);
  const daysLeft = daysBetween(businessDateAt(now, timeZone), date);
  if (daysLeft > EXPIRY_SOON_DAYS) return null;
  const expired = at.getTime() <= now.getTime();
  return {
    level: daysLeft <= EXPIRY_URGENT_DAYS || expired ? "now" : "soon",
    date,
    daysLeft,
    text: `Awish-kontot ${expired ? "gick" : "går"} ut ${expiryDateText(date)} – förläng hos Awish`,
  };
}
