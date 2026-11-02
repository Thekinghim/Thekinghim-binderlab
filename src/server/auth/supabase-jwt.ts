/**
 * Verifiering av Supabase-åtkomsttoken med jose mot projektets JWKS
 * (asymmetriska nycklar: ES256 eller RS256). Kontrollerar signatur, issuer
 * (`{SUPABASE_URL}/auth/v1`), audience `authenticated`, exp, rollen
 * `authenticated` och att användaren inte är anonym.
 */

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { AuthSession } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SupabaseTokenCheck =
  { ok: true; session: AuthSession } | { ok: false; reason: "expired" | "invalid" };

export function supabaseIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

const remoteSets = new Map<string, JWTVerifyGetKey>();

/** JWKS från Supabase, cachad per process (jose cachar nycklarna i 10 min). */
export function remoteJwks(jwksUrl: string): JWTVerifyGetKey {
  let set = remoteSets.get(jwksUrl);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000 });
    remoteSets.set(jwksUrl, set);
  }
  return set;
}

export interface SupabaseJwtVerifierOptions {
  supabaseUrl: string;
  /** Nyckelkälla: `remoteJwks(url)` i drift, `createLocalJWKSet` i tester. */
  jwks: JWTVerifyGetKey;
}

export function createSupabaseJwtVerifier(options: SupabaseJwtVerifierOptions) {
  const issuer = supabaseIssuer(options.supabaseUrl);
  return async function verify(
    token: string,
    verifyOptions: { now?: Date } = {},
  ): Promise<SupabaseTokenCheck> {
    try {
      const { payload } = await jwtVerify(token, options.jwks, {
        algorithms: ["ES256", "RS256"],
        issuer,
        audience: "authenticated",
        requiredClaims: ["sub", "exp"],
        currentDate: verifyOptions.now,
      });
      const claims = payload as {
        sub?: unknown;
        email?: unknown;
        role?: unknown;
        is_anonymous?: unknown;
      };
      if (
        typeof claims.sub !== "string" ||
        !UUID.test(claims.sub) ||
        claims.role !== "authenticated" ||
        claims.is_anonymous === true ||
        typeof claims.email !== "string" ||
        claims.email === ""
      ) {
        return { ok: false, reason: "invalid" };
      }
      return { ok: true, session: { userId: claims.sub.toLowerCase(), email: claims.email } };
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        return { ok: false, reason: "expired" };
      }
      return { ok: false, reason: "invalid" };
    }
  };
}
