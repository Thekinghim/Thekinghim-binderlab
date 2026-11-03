"use server";

/**
 * Server actions för inloggning och inbjudningar. Tunna omslag kring
 * src/server/auth/flows.ts; all logik och validering finns där.
 *
 * Alla returnerar { ok, error? } med svenska felmeddelanden. Indata från
 * klienten är okontrollerad och valideras i flödena.
 */

import { headers } from "next/headers";

import { getServerEnv } from "@/lib/env";

import { getAuthProvider } from "../auth";
import {
  acceptInviteFlow,
  changePasswordFlow,
  createInviteFlow,
  loginFlow,
  logoutFlow,
  switchOrganizationFlow,
  type ActionResult,
} from "../auth/flows";
import { nextCookieJar } from "../auth/next-cookies";
import { createRateLimiter } from "../rate-limit";
import { clientIp, resolveAppBaseUrl } from "../request-info";
import { getSessionUser } from "../session";

// Per 15 minuter (per serverinstans): 5 försök per IP och e-post, 20 per konto
// (ACCOUNT_LOGIN_LIMIT) och 5 per IP för ogiltiga adresser. Se loginFlow.
const globalForLimiter = globalThis as typeof globalThis & {
  __binderlabLoginLimiter?: ReturnType<typeof createRateLimiter>;
};
const loginLimiter = (globalForLimiter.__binderlabLoginLimiter ??= createRateLimiter({
  limit: 5,
  windowMs: 15 * 60 * 1000,
}));

// Byte av eget lösenord: 5 försök per användare per 15 minuter (CHANGE_PASSWORD_LIMIT).
const globalForPasswordLimiter = globalThis as typeof globalThis & {
  __binderlabPasswordLimiter?: ReturnType<typeof createRateLimiter>;
};
const passwordLimiter = (globalForPasswordLimiter.__binderlabPasswordLimiter ??= createRateLimiter({
  limit: 5,
  windowMs: 15 * 60 * 1000,
}));

function secureCookies(): boolean {
  return getServerEnv().APP_ENV !== "development";
}

export async function login(input: { email: string; password: string }): Promise<ActionResult> {
  const provider = await getAuthProvider();
  return loginFlow({ provider, limiter: loginLimiter, ip: clientIp(await headers()) }, input);
}

export async function logout(): Promise<ActionResult> {
  return logoutFlow({ provider: await getAuthProvider(), cookies: await nextCookieJar() });
}

export async function createInvite(input: {
  organizationId: string;
  email: string;
  role: "owner" | "admin" | "refiller" | "viewer";
  validDays?: number;
}): Promise<ActionResult> {
  const provider = await getAuthProvider();
  const user = await getSessionUser();
  let baseUrl: string;
  try {
    baseUrl = resolveAppBaseUrl(getServerEnv(), await headers());
  } catch {
    return { ok: false, error: "Appens adress (APP_URL) är inte inställd." };
  }
  return createInviteFlow({ provider, user, baseUrl }, input);
}

export async function acceptInvite(
  token: string,
  options: {
    /** Dev: lösenord för ett nytt konto. Supabase: valfritt lösenord för ny användare. */
    password?: string;
    /** Supabase: token_hash från mejllänken (?token_hash=…&type=…). */
    emailTokenHash?: string;
    emailLinkType?: "invite" | "magiclink";
  } = {},
): Promise<ActionResult<{ organizationId: string }>> {
  const provider = await getAuthProvider();
  const user = await getSessionUser();
  return acceptInviteFlow(
    { provider, user, cookies: await nextCookieJar(), secureCookies: secureCookies() },
    { ...options, token },
  );
}

export async function switchOrganization(organizationId: string): Promise<ActionResult> {
  const user = await getSessionUser();
  return switchOrganizationFlow(
    { user, cookies: await nextCookieJar(), secureCookies: secureCookies() },
    organizationId,
  );
}

export async function changePassword(input: {
  current: string;
  next: string;
  confirm: string;
}): Promise<ActionResult> {
  const provider = await getAuthProvider();
  const user = await getSessionUser();
  return changePasswordFlow({ provider, user, limiter: passwordLimiter }, input);
}
