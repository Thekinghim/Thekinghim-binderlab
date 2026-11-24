"use server";

/**
 * Inloggning med mobilnummer och PIN-kod (påfyllare i butiken). Logiken finns i
 * src/server/auth/phone-login.ts; här bara gränserna (per serverinstans) och vart man
 * skickas efteråt.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getServiceDb } from "@/db/client";
import { getAuthProvider } from "@/server/auth";
import { signInWithPhonePin } from "@/server/auth/phone-login";
import { createRateLimiter } from "@/server/rate-limit";
import { clientIp } from "@/server/request-info";

export interface PhoneLoginState {
  error?: string;
  phone?: string;
}

const g = globalThis as typeof globalThis & {
  __binderlabPhoneIpLimiter?: ReturnType<typeof createRateLimiter>;
  __binderlabPhoneNumberLimiter?: ReturnType<typeof createRateLimiter>;
};
const ipLimiter = (g.__binderlabPhoneIpLimiter ??= createRateLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
}));
const phoneLimiter = (g.__binderlabPhoneNumberLimiter ??= createRateLimiter({
  limit: 5,
  windowMs: 15 * 60 * 1000,
}));

export async function signInWithPhone(
  _prev: PhoneLoginState,
  form: FormData,
): Promise<PhoneLoginState> {
  const phone = String(form.get("phone") ?? "").slice(0, 40);
  const pin = String(form.get("pin") ?? "")
    .replace(/\s/g, "")
    .slice(0, 20);
  const result = await signInWithPhonePin(
    { db: getServiceDb, provider: await getAuthProvider(), ipLimiter, phoneLimiter },
    { phone, pin, ip: clientIp(await headers()) },
  );
  if (!result.ok) return { error: result.error, phone };
  redirect(result.mustChangePin ? "/pafyll/ny-pin" : "/pafyll");
}
