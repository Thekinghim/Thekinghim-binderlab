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

/**
 * Klientens IP enligt rubriken som den närmaste betrodda proxyn sätter.
 *
 * 1. `x-vercel-forwarded-for` och `x-real-ip`: Vercel skriver över dem med
 *    klientens adress, så klienten kan inte välja dem själv.
 * 2. Annars det SISTA värdet i `x-forwarded-for`, alltså adressen som den
 *    närmaste proxyn lade till. De första värdena skickar klienten själv och
 *    kan vara påhittade; att läsa dem skulle ge en angripare en ny räknare i
 *    inloggningsgränsen för varje påhittad adress.
 */
export function clientIp(headers: HeaderGetter): string {
  const first = (name: string) => headers.get(name)?.split(",")[0]?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const ip = first("x-vercel-forwarded-for") || first("x-real-ip") || forwarded;
  return ip && ip.length <= 64 ? ip : "okänd";
}
