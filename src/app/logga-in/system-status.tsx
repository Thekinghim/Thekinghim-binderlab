import "server-only";

import { sql } from "drizzle-orm";

import { wallClockIn } from "@/components/shell/period-state";
import { getServiceDb } from "@/db/client";
import type { Locale } from "@/i18n/locale";
import { getServerEnv } from "@/lib/env";
import { formatInt, formatTime } from "@/lib/format";

const TIME_ZONE = "Europe/Stockholm";
const PING_TIMEOUT_MS = 1500;

const ENV_LABEL = {
  sv: { development: "Lokal miljö", preview: "Förhandsversion", production: null },
  en: { development: "Local", preview: "Preview", production: null },
} as const;

/** Raden följer inloggningssidans språk (kakan eller webbläsaren). */
const TEXT = {
  sv: {
    misconfigured: "Miljön är felkonfigurerad",
    devLogin: "Dev-inloggning",
    reply: (ms: string) => `Svar ${ms} ms`,
    up: "Databasen i drift",
    down: "Databasen svarar inte",
  },
  en: {
    misconfigured: "Environment misconfigured",
    devLogin: "Dev sign-in",
    reply: (ms: string) => `Reply ${ms} ms`,
    up: "Database up",
    down: "Database not answering",
  },
} as const;

/** Hur länge ett pingresultat återanvänds, så att anonyma sidvisningar inte belastar databasen. */
const CACHE_MS = 10_000;
const FAIL_CACHE_MS = 2_000;

const globalForPing = globalThis as typeof globalThis & {
  __binderlabLoginPing?: { at: number; ms: number | null };
};

/**
 * Pingar databasen (select 1, ingen data). Systemfråga utan användare, som
 * hälsokontroller: läser inget som hör till någon organisation. Resultatet
 * delas mellan förfrågningar i några sekunder.
 */
async function pingOnce(): Promise<number | null> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getServiceDb().execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), PING_TIMEOUT_MS);
      }),
    ]);
    return Math.max(1, Math.round(performance.now() - started));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ett lyckat svar återanvänds i CACHE_MS, ett uteblivet bara i FAIL_CACHE_MS. */
async function ping(): Promise<number | null> {
  const cached = globalForPing.__binderlabLoginPing;
  const now = Date.now();
  if (cached && now - cached.at < (cached.ms === null ? FAIL_CACHE_MS : CACHE_MS)) {
    return cached.ms;
  }
  const ms = await pingOnce();
  globalForPing.__binderlabLoginPing = { at: Date.now(), ms };
  return ms;
}

/**
 * Statusraden längst ner på inloggningssidorna: om databasen svarar (och hur
 * snabbt), miljö, inloggningssätt och klockan i Stockholm. Raden påstår bara
 * det den har mätt: databasens svar, inte resten av systemet.
 */
export async function SystemStatus({ locale = "sv" }: { locale?: Locale } = {}) {
  const t = TEXT[locale];
  let envLabel: string | null = null;
  let method = "";
  // Svarstiden är driftuppgift: den visas inte för anonyma besökare i produktion.
  let showLatency = true;
  try {
    const env = getServerEnv();
    envLabel = ENV_LABEL[locale][env.APP_ENV];
    showLatency = env.APP_ENV !== "production";
    method = env.AUTH_PROVIDER === "dev" ? t.devLogin : "";
  } catch {
    envLabel = t.misconfigured;
  }
  const ms = await ping();
  const now = wallClockIn(new Date(), TIME_ZONE);
  const parts = [
    ms === null || !showLatency ? null : t.reply(formatInt(ms)),
    envLabel,
    method || null,
    `${formatTime(now)} Stockholm`,
  ].filter((p): p is string => Boolean(p));

  // Varje del bär sin punkt framför sig, och raden är förskjuten 16 px åt vänster bakom en
  // klippt kant: en del som hamnar först på en ny rad tappar punkten (ingen rad börjar med "·").
  return (
    <p className="overflow-hidden text-v2-xs text-v2-faint" role="status">
      <span className="-ml-4 flex flex-wrap items-center gap-y-1">
        <span className="inline-flex items-center gap-1.5 pl-4 font-[550] text-v2-mute">
          <span
            aria-hidden
            className="inline-block size-1.5 rounded-full"
            style={{ background: ms === null ? "var(--v2-crit-icon)" : "var(--v2-profit)" }}
          />
          {ms === null ? t.down : t.up}
        </span>
        {parts.map((p) => (
          <span key={p} className="inline-flex items-center">
            <span aria-hidden className="w-4 text-center">
              ·
            </span>
            <span className="tnum">{p}</span>
          </span>
        ))}
      </span>
    </p>
  );
}
