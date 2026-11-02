import "server-only";

import { getServiceDb } from "@/db/client";
import { getServerEnv, type ServerEnv } from "@/lib/env";

import { DevAuthProvider } from "./dev-provider";
import { nextCookieJar } from "./next-cookies";
import { SupabaseAuthProvider } from "./supabase-provider";
import type { AuthProvider, CookieJar } from "./types";

export type { AuthProvider, AuthSession, CookieJar, SignInResult } from "./types";

/** Väljer provider efter AUTH_PROVIDER. Dev-providern kastar utanför lokal miljö. */
export function createAuthProvider(env: ServerEnv, cookies: CookieJar): AuthProvider {
  if (env.AUTH_PROVIDER === "dev") {
    // Inloggningstjänstens egen tabell (auth.users), se dev-provider.ts.
    return new DevAuthProvider({ env, cookies, db: getServiceDb });
  }
  return new SupabaseAuthProvider({
    env,
    cookies,
    secureCookies: env.APP_ENV !== "development",
  });
}

/** Providern för den aktuella förfrågan (Next:s cookies). */
export async function getAuthProvider(): Promise<AuthProvider> {
  return createAuthProvider(getServerEnv(), await nextCookieJar());
}
