/**
 * Inloggning med mobilnummer och PIN-kod (butikspåfyllare). Testbar utan Next
 * (src/server/auth/phone-login.test.ts och test/db/butikspafyllare-login.test.ts).
 *
 * - PIN-koden lagras bara som scrypt-hash (private.phone_logins.pin_hash).
 * - Två sätt att peka ut kontot: mobilnumret, eller QR-kodens hemliga nyckel (/m/<nyckel>,
 *   bara sha256 sparas; ägaren byter den med "Ny QR-kod" och den gamla slutar gälla).
 * - Gränser: per IP (10 per 15 min) och per konto (5 per 15 min) i minnet, och i
 *   databasen: var 5:e fel → låst 15 minuter, från 10 fel → låst ett dygn (ägaren låser
 *   upp med "Ny PIN-kod"). Under 10 fel glöms fel som är äldre än ett dygn, så att
 *   felskrivningar under veckor inte låser kontot. Försöket räknas i databasen INNAN koden
 *   kontrolleras (atomiskt), så att parallella försök inte kan passera.
 * - Okänt nummer: scrypt körs ändan (mot en låtsashash), så tiden avslöjar inget.
 * - Ett felmeddelande för allt: "Fel mobilnummer eller PIN-kod."
 * - Lyckad inloggning ger en riktig session (AuthProvider.signInAsUser). Kontot gäller
 *   90 dagar efter senaste användning (staffSessionState), och databasen kräver samma
 *   sak (private.staff_active).
 */

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";

import type { RateLimiter } from "../rate-limit";

import { hashQrToken, isQrToken, normalizeSwedishMobile } from "./phone";
import { hashPassword, verifyPassword } from "./password";
import type { AuthProvider } from "./types";

export const PHONE_LOGIN_ERROR =
  "Fel mobilnummer eller PIN-kod. Glömt koden? Be den som gav dig kontot om en ny.";
export const QR_LOGIN_ERROR = "Fel PIN-kod. Glömt koden? Be den som gav dig kontot om en ny.";
export const PHONE_LOGIN_LIMITED = "För många försök. Vänta en stund och försök igen.";
export const PHONE_LOGIN_UNAVAILABLE = "Inloggningen fungerar inte just nu. Försök igen strax.";

/** Kontot loggas ut när det inte använts på så här många dagar. */
export const STAFF_IDLE_DAYS = 90;

export interface PhoneLoginDeps {
  db: () => Db;
  provider: Pick<AuthProvider, "signInAsUser">;
  ipLimiter: RateLimiter;
  phoneLimiter: RateLimiter;
}

export type PhoneLoginResult =
  { ok: true; userId: string; mustChangePin: boolean } | { ok: false; error: string };

interface ChargedRow {
  user_id: string;
  pin_hash: string;
  must_change_pin: boolean;
  [key: string]: unknown;
}

/** Felräkningen efter det här försöket (fel äldre än ett dygn glöms under 10 fel). */
const NEXT_FAILS = sql`((case when failed_attempts < 10
  and coalesce(last_failed_at, now()) < now() - interval '24 hours'
  then 0 else failed_attempts end) + 1)`;

export async function signInWithPhonePin(
  deps: PhoneLoginDeps,
  input: { phone?: unknown; token?: unknown; pin: unknown; ip: string },
): Promise<PhoneLoginResult> {
  const viaQr = input.token !== undefined && input.token !== null && input.token !== "";
  const failure = viaQr ? QR_LOGIN_ERROR : PHONE_LOGIN_ERROR;
  const ipDecision = deps.ipLimiter.consume([{ key: `ip:${input.ip}` }]);
  if (!ipDecision.allowed) return { ok: false, error: PHONE_LOGIN_LIMITED };

  const phone = viaQr ? null : normalizeSwedishMobile(input.phone);
  const tokenHash = viaQr && isQrToken(input.token) ? hashQrToken(input.token) : null;
  const pin = typeof input.pin === "string" && /^\d{6}$/.test(input.pin) ? input.pin : null;
  if ((!phone && !tokenHash) || !pin) {
    // Samma tid som ett riktigt försök.
    await verifyPassword(String(input.pin ?? "x").slice(0, 20) || "x", null);
    return { ok: false, error: failure };
  }
  const accountKey = phone ? `phone:${phone}` : `qr:${tokenHash}`;
  const accountDecision = deps.phoneLimiter.consume([{ key: accountKey }]);
  if (!accountDecision.allowed) return { ok: false, error: PHONE_LOGIN_LIMITED };

  const charged = Array.from(
    await deps.db().execute(sql`
      update private.phone_logins set
        failed_attempts = ${NEXT_FAILS},
        locked_until = case
          when ${NEXT_FAILS} >= 10 and ${NEXT_FAILS} % 5 = 0 then now() + interval '24 hours'
          when ${NEXT_FAILS} % 5 = 0 then now() + interval '15 minutes'
          else locked_until end,
        last_failed_at = now(),
        updated_at = now()
      where ${phone ? sql`phone_e164 = ${phone}` : sql`qr_token_hash = ${tokenHash}`}
        and disabled_at is null
        and (locked_until is null or locked_until < now())
        and coalesce(last_used_at, created_at) > now() - make_interval(days => ${STAFF_IDLE_DAYS})
      returning user_id, pin_hash, must_change_pin`),
  )[0] as ChargedRow | undefined;

  const valid = await verifyPassword(pin, charged?.pin_hash ?? null);
  if (!charged || !valid) return { ok: false, error: failure };

  await deps.db().execute(sql`
    update private.phone_logins
    set failed_attempts = 0, locked_until = null, last_failed_at = null, last_used_at = now(),
        updated_at = now()
    where user_id = ${charged.user_id}::uuid`);
  deps.phoneLimiter.reset(accountKey);

  const session = deps.provider.signInAsUser
    ? await deps.provider.signInAsUser(charged.user_id)
    : null;
  if (!session) return { ok: false, error: PHONE_LOGIN_UNAVAILABLE };
  return { ok: true, userId: charged.user_id, mustChangePin: charged.must_change_pin };
}

export type StaffSessionState =
  { state: "none" } | { state: "expired" } | { state: "ok"; mustChangePin: boolean };

/**
 * Mobilinloggningen för användaren: "none" (inget sådant konto), "expired" (avstängt
 * eller oanvänt i 90 dagar: logga ut) eller "ok". Förnyar senast använd högst en gång
 * per dygn.
 */
export async function staffSessionState(db: () => Db, userId: string): Promise<StaffSessionState> {
  const row = Array.from(
    await db().execute(sql`
      select disabled_at is not null as disabled,
             coalesce(last_used_at, created_at) <= now() - make_interval(days => ${STAFF_IDLE_DAYS}) as idle,
             coalesce(last_used_at, created_at) < now() - interval '1 day' as stale,
             must_change_pin
      from private.phone_logins where user_id = ${userId}::uuid`),
  )[0] as
    { disabled: boolean; idle: boolean; stale: boolean; must_change_pin: boolean } | undefined;
  if (!row) return { state: "none" };
  if (row.disabled || row.idle) return { state: "expired" };
  if (row.stale) {
    await db().execute(
      sql`update private.phone_logins set last_used_at = now() where user_id = ${userId}::uuid`,
    );
  }
  return { state: "ok", mustChangePin: row.must_change_pin };
}

/**
 * Förnamnet på kontot som QR-nyckeln hör till (för "Hej Anna, skriv din PIN-kod"), eller
 * null om nyckeln inte gäller (bytt, avstängt eller oanvänt i 90 dagar).
 */
export async function qrAccountName(db: () => Db, token: unknown): Promise<string | null> {
  if (!isQrToken(token)) return null;
  const row = Array.from(
    await db().execute(sql`
      select coalesce(min(pr.display_name), 'Påfyllare') as name
      from private.phone_logins p
      left join public.profiles pr on pr.user_id = p.user_id
      where p.qr_token_hash = ${hashQrToken(token)}
        and p.disabled_at is null
        and coalesce(p.last_used_at, p.created_at) > now() - make_interval(days => ${STAFF_IDLE_DAYS})
      group by p.user_id`),
  )[0] as { name: string } | undefined;
  return row ? (row.name.split(/\s+/)[0] ?? row.name) : null;
}

/** Stämmer PIN-koden för användaren? (byte av egen PIN-kod kräver den nuvarande). */
export async function checkOwnPin(db: () => Db, userId: string, pin: string): Promise<boolean> {
  const row = Array.from(
    await db().execute(
      sql`select pin_hash from private.phone_logins where user_id = ${userId}::uuid and disabled_at is null`,
    ),
  )[0] as { pin_hash: string } | undefined;
  return verifyPassword(pin, row?.pin_hash ?? null);
}

/** Sätter en ny egen PIN-kod för användaren (redan validerad med validateNewPin). */
export async function setOwnPin(db: () => Db, userId: string, pin: string): Promise<boolean> {
  const hash = await hashPassword(pin);
  const result = (await db().execute(sql`
    update private.phone_logins
    set pin_hash = ${hash}, must_change_pin = false, updated_at = now()
    where user_id = ${userId}::uuid and disabled_at is null`)) as unknown as { count?: number };
  return (result.count ?? 0) > 0;
}

/** Hoppa över: behåll start-PIN:en utan att fråga igen. */
export async function skipPinChange(db: () => Db, userId: string): Promise<void> {
  await db().execute(sql`
    update private.phone_logins set must_change_pin = false, updated_at = now()
    where user_id = ${userId}::uuid`);
}
