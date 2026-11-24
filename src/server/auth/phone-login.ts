/**
 * Inloggning med mobilnummer och PIN-kod (butikspåfyllare). Testbar utan Next
 * (src/server/auth/phone-login.test.ts och test/db/butikspafyllare-login.test.ts).
 *
 * - PIN-koden lagras bara som scrypt-hash (private.phone_logins.pin_hash).
 * - Gränser: per IP (10 per 15 min) och per nummer (5 per 15 min) i minnet, och i
 *   databasen: 5 fel i rad → låst 15 minuter, 10 fel i rad → låst tills ägaren ger en
 *   ny PIN-kod. Försöket räknas i databasen INNAN koden kontrolleras (atomiskt), så att
 *   parallella försök inte kan passera.
 * - Okänt nummer: scrypt körs ändan (mot en låtsashash), så tiden avslöjar inget.
 * - Ett felmeddelande för allt: "Fel mobilnummer eller PIN-kod."
 * - Lyckad inloggning ger en riktig session (AuthProvider.signInAsUser). Kontot gäller
 *   90 dagar efter senaste användning (staffSessionState), och databasen kräver samma
 *   sak (private.staff_active).
 */

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";

import type { RateLimiter } from "../rate-limit";

import { normalizeSwedishMobile } from "./phone";
import { hashPassword, verifyPassword } from "./password";
import type { AuthProvider } from "./types";

export const PHONE_LOGIN_ERROR = "Fel mobilnummer eller PIN-kod.";
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

export async function signInWithPhonePin(
  deps: PhoneLoginDeps,
  input: { phone: unknown; pin: unknown; ip: string },
): Promise<PhoneLoginResult> {
  const ipDecision = deps.ipLimiter.consume([{ key: `ip:${input.ip}` }]);
  if (!ipDecision.allowed) return { ok: false, error: PHONE_LOGIN_LIMITED };

  const phone = normalizeSwedishMobile(input.phone);
  const pin = typeof input.pin === "string" && /^\d{6}$/.test(input.pin) ? input.pin : null;
  if (!phone || !pin) {
    // Samma tid som ett riktigt försök.
    await verifyPassword(String(input.pin ?? "x").slice(0, 20) || "x", null);
    return { ok: false, error: PHONE_LOGIN_ERROR };
  }
  const phoneDecision = deps.phoneLimiter.consume([{ key: `phone:${phone}` }]);
  if (!phoneDecision.allowed) return { ok: false, error: PHONE_LOGIN_LIMITED };

  const charged = Array.from(
    await deps.db().execute(sql`
      update private.phone_logins set
        failed_attempts = failed_attempts + 1,
        locked_until = case
          when failed_attempts + 1 >= 10 then 'infinity'::timestamptz
          when (failed_attempts + 1) % 5 = 0 then now() + interval '15 minutes'
          else locked_until end,
        updated_at = now()
      where phone_e164 = ${phone}
        and disabled_at is null
        and (locked_until is null or locked_until < now())
        and coalesce(last_used_at, created_at) > now() - make_interval(days => ${STAFF_IDLE_DAYS})
      returning user_id, pin_hash, must_change_pin`),
  )[0] as ChargedRow | undefined;

  const valid = await verifyPassword(pin, charged?.pin_hash ?? null);
  if (!charged || !valid) return { ok: false, error: PHONE_LOGIN_ERROR };

  await deps.db().execute(sql`
    update private.phone_logins
    set failed_attempts = 0, locked_until = null, last_used_at = now(), updated_at = now()
    where user_id = ${charged.user_id}::uuid`);
  deps.phoneLimiter.reset(`phone:${phone}`);

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
