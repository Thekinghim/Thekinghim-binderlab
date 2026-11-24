/**
 * Bekräftelsebevis för Starta om och Stäng av. Förhandsvisningen på servern ger ett bevis
 * (HMAC över organisation, användare, automat, kommando, idempotensnyckel och tid) som
 * bekräftelsen måste skicka tillbaka inom 10 minuter. Utan förhandsvisning på servern går
 * det alltså inte att starta om eller stänga av, inte ens med ett eget anrop.
 *
 * Nyckeln: CONTROL_CONFIRM_SECRET, annars CRON_SECRET (finns i produktion). Saknas båda (lokalt
 * och i tester) används en nyckel som slumpas när servern startar: bevis från en annan
 * process godtas då inte, vilket bara betyder en ny förhandsvisning.
 */

import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CONFIRM_TOKEN_TTL_S = 600;

let processKey: Buffer | null = null;

function key(env: Record<string, string | undefined>): Buffer {
  const fromEnv = env.CONTROL_CONFIRM_SECRET?.trim() || env.CRON_SECRET?.trim();
  if (fromEnv) return Buffer.from(`binderlab-control-confirm:${fromEnv}`, "utf8");
  processKey ??= randomBytes(32);
  return processKey;
}

export interface ConfirmSubject {
  orgId: string;
  userId: string;
  machineId: string;
  action: string;
  idempotencyKey: string;
}

function mac(subject: ConfirmSubject, issuedAt: number, env: Record<string, string | undefined>) {
  return createHmac("sha256", key(env))
    .update(
      [
        subject.orgId,
        subject.userId,
        subject.machineId,
        subject.action,
        subject.idempotencyKey,
        String(issuedAt),
      ].join("|"),
    )
    .digest("hex");
}

export function issueConfirmToken(
  subject: ConfirmSubject,
  nowMs: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  return `${issuedAt}.${mac(subject, issuedAt, env)}`;
}

export function verifyConfirmToken(
  token: unknown,
  subject: ConfirmSubject,
  nowMs: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (typeof token !== "string") return false;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  const age = Math.floor(nowMs / 1000) - issuedAt;
  if (age < -30 || age > CONFIRM_TOKEN_TTL_S) return false;
  const expected = Buffer.from(mac(subject, issuedAt, env), "hex");
  const given = Buffer.from(m[2]!, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
