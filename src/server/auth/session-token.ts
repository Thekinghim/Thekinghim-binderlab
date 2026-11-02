/**
 * Sessions-JWT för dev-inloggningen: HS256, signerad med DEV_AUTH_SECRET och
 * lagrad i en httpOnly-cookie med SameSite=Lax. Används ALDRIG i preview eller
 * production (där sköter Supabase sessionen).
 */

import { jwtVerify, SignJWT, errors } from "jose";

import type { AuthSession } from "./types";

export const DEV_SESSION_COOKIE = "bl_session";
export const DEV_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const ISSUER = "binderlab-dev";
const AUDIENCE = "binderlab";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TokenCheck =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: "expired" | "invalid" };

function keyFor(secret: string): Uint8Array {
  if (secret.length < 32) {
    throw new RangeError("DEV_AUTH_SECRET måste vara minst 32 tecken.");
  }
  return new TextEncoder().encode(secret);
}

export async function signDevSession(
  session: AuthSession,
  secret: string,
  options: { now?: Date; ttlSeconds?: number } = {},
): Promise<string> {
  if (!UUID.test(session.userId)) {
    throw new TypeError("userId måste vara ett uuid.");
  }
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  return new SignJWT({ email: session.email })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(session.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.ttlSeconds ?? DEV_SESSION_TTL_SECONDS))
    .sign(keyFor(secret));
}

export async function verifyDevSession(
  token: string,
  secret: string,
  options: { now?: Date } = {},
): Promise<TokenCheck> {
  try {
    const { payload } = await jwtVerify(token, keyFor(secret), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["sub", "exp", "iat"],
      currentDate: options.now,
    });
    const sub = payload.sub;
    const email = (payload as { email?: unknown }).email;
    if (typeof sub !== "string" || !UUID.test(sub) || typeof email !== "string" || !email) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, session: { userId: sub.toLowerCase(), email } };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { ok: false, reason: "expired" };
    }
    return { ok: false, reason: "invalid" };
  }
}
