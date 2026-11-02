/**
 * Sessionskontroll i proxyn (src/proxy.ts). Bara en bekvämlighet för att
 * skicka oinloggade till inloggningssidan och för att förnya Supabase-
 * sessionen (serverkomponenter kan inte skriva cookies). Behörigheten
 * kontrolleras alltid i serverkoden och i RLS.
 */

import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

import type { ServerEnv } from "@/lib/env";

import { DEV_SESSION_COOKIE, verifyDevSession } from "./session-token";
import { supabaseCookieOptions } from "./supabase-cookies";
import { createSupabaseJwtVerifier, remoteJwks } from "./supabase-jwt";

export interface ProxySessionResult {
  authenticated: boolean;
  /** Svaret att skicka vidare (kan bära förnyade Supabase-cookies). */
  response: NextResponse;
}

export async function checkProxySession(
  request: NextRequest,
  env: ServerEnv,
  next: (request: NextRequest) => NextResponse,
): Promise<ProxySessionResult> {
  if (env.AUTH_PROVIDER === "dev") {
    const token = request.cookies.get(DEV_SESSION_COOKIE)?.value;
    const secret = env.DEV_AUTH_SECRET;
    const authenticated =
      Boolean(token && secret) && (await verifyDevSession(token ?? "", secret ?? "")).ok;
    return { authenticated, response: next(request) };
  }

  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  const jwksUrl = env.SUPABASE_JWKS_URL;
  if (!url || !key || !jwksUrl) {
    return { authenticated: false, response: next(request) };
  }

  let response = next(request);
  const flags = supabaseCookieOptions(env.APP_ENV !== "development");
  const supabase = createServerClient(url, key, {
    cookieOptions: flags,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = next(request);
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, {
            ...options,
            httpOnly: flags.httpOnly,
            secure: flags.secure,
            sameSite: flags.sameSite,
          });
        }
      },
    },
  });

  // getSession() förnyar en utgången token (och skriver cookies via setAll).
  // Token verifieras sedan lokalt mot JWKS.
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    return { authenticated: false, response };
  }
  const verify = createSupabaseJwtVerifier({ supabaseUrl: url, jwks: remoteJwks(jwksUrl) });
  const check = await verify(token);
  return { authenticated: check.ok, response };
}
