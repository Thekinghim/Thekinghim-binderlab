/**
 * Uppgifter om förfrågan: appens publika adress (för länkar i mejl) och
 * klientens IP (för begränsning av inloggningsförsök). Rena funktioner;
 * session.ts och actions skickar in rubrikerna.
 */

import type { ServerEnv } from "@/lib/env";

type HeaderGetter = { get(name: string): string | null };

/**
 * Appens adress utan avslutande snedstreck.
 *
 * 1. APP_URL (krävs i production).
 * 2. Vercel: grenens adress i preview (VERCEL_BRANCH_URL, annars VERCEL_URL).
 * 3. Lokalt: adressen förfrågan kom till (Host-rubriken). Bara i development,
 *    eftersom Host kan förfalskas och länken hamnar i ett mejl.
 */
export function resolveAppBaseUrl(
  env: Pick<ServerEnv, "APP_ENV" | "APP_URL" | "VERCEL_BRANCH_URL" | "VERCEL_URL">,
  headers?: HeaderGetter,
): string {
  if (env.APP_URL) {
    return env.APP_URL.replace(/\/+$/, "");
  }
  const vercelHost = env.VERCEL_BRANCH_URL ?? env.VERCEL_URL;
  if (env.APP_ENV !== "development" && vercelHost) {
    return `https://${vercelHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  }
  if (env.APP_ENV === "development") {
    const host = headers?.get("x-forwarded-host") ?? headers?.get("host");
    if (host && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) {
      const proto = headers?.get("x-forwarded-proto") === "https" ? "https" : "http";
      return `${proto}://${host}`;
    }
    return "http://localhost:3000";
  }
  throw new Error("APP_URL saknas: kan inte bygga länkar i mejl.");
}

/** Klientens IP enligt proxyrubrikerna (Vercel sätter x-forwarded-for). */
export function clientIp(headers: HeaderGetter): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip")?.trim();
  return ip && ip.length <= 64 ? ip : "okänd";
}
