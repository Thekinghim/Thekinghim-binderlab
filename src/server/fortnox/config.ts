/**
 * Miljövariabler för Fortnox (docs/miljoer.md, avsnittet Fortnox).
 *
 *   FORTNOX_CLIENT_ID       Integrationens Client-Id (Fortnox utvecklarportal).
 *   FORTNOX_CLIENT_SECRET   Integrationens Client-Secret. HEMLIG, bara på servern.
 *   FORTNOX_REDIRECT_URI    Valfri. Standard: {APP_URL}/datakallor/fortnox/klar. Måste vara
 *                           exakt samma adress som står i utvecklarportalen.
 *   FORTNOX_API_BASE_URL    Bara för test: en falsk Fortnox på 127.0.0.1/localhost.
 *   FORTNOX_AUTH_BASE_URL   Bara för test, som ovan.
 *
 * Läses när de används (inte vid import), så att tester kan sätta dem. En annan adress än
 * Fortnox egen godtas bara om den pekar på den egna datorn: token och verifikat kan aldrig
 * skickas till en främmande värd genom en felskriven variabel.
 */

import "server-only";

export const FORTNOX_API_BASE_URL = "https://api.fortnox.se";
export const FORTNOX_AUTH_BASE_URL = "https://apps.fortnox.se";
export const FORTNOX_CALLBACK_PATH = "/datakallor/fortnox/klar";
/** Det appen behöver: verifikat, konton, serier och räkenskapsår; låst period; företagets namn. */
export const FORTNOX_SCOPES = ["bookkeeping", "settings", "companyinformation"] as const;

export interface FortnoxConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly apiBaseUrl: string;
  readonly authBaseUrl: string;
}

function localOnly(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  if (!value) return fallback;
  try {
    const url = new URL(value);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol === "http:" && local && url.pathname === "/" && !url.search && !url.username) {
      return url.origin;
    }
  } catch {
    // Faller igenom till standardvärdet.
  }
  return fallback;
}

/** Varför Fortnox inte kan kopplas på den här servern, eller null. */
export function fortnoxConfigProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.FORTNOX_CLIENT_ID?.trim() || !env.FORTNOX_CLIENT_SECRET?.trim()) {
    return "Fortnox är inte inställt på servern än (FORTNOX_CLIENT_ID och FORTNOX_CLIENT_SECRET saknas).";
  }
  if (!redirectUri(env)) {
    return "Appens adress saknas på servern (APP_URL), så Fortnox kan inte skicka tillbaka dig.";
  }
  return null;
}

function redirectUri(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.FORTNOX_REDIRECT_URI?.trim();
  const base = env.APP_URL?.trim().replace(/\/+$/, "");
  const raw = explicit || (base ? `${base}${FORTNOX_CALLBACK_PATH}` : "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Inställningarna, eller null när något saknas (se fortnoxConfigProblem). */
export function fortnoxConfig(env: NodeJS.ProcessEnv = process.env): FortnoxConfig | null {
  const clientId = env.FORTNOX_CLIENT_ID?.trim();
  const clientSecret = env.FORTNOX_CLIENT_SECRET?.trim();
  const redirect = redirectUri(env);
  if (!clientId || !clientSecret || !redirect) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: redirect,
    apiBaseUrl: localOnly(env.FORTNOX_API_BASE_URL, FORTNOX_API_BASE_URL),
    authBaseUrl: localOnly(env.FORTNOX_AUTH_BASE_URL, FORTNOX_AUTH_BASE_URL),
  };
}
