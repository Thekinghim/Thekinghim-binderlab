import "server-only";

import { sql } from "drizzle-orm";

import { wallClockIn } from "@/components/shell/period-state";
import { StatusGlyph } from "@/components/ui/status-tag";
import { getServiceDb } from "@/db/client";
import { getServerEnv } from "@/lib/env";
import { formatInt, formatTime } from "@/lib/format";

const TIME_ZONE = "Europe/Stockholm";
const PING_TIMEOUT_MS = 1500;

const ENV_LABEL = {
  development: "Lokal miljö",
  preview: "Förhandsversion",
  production: null,
} as const;

/**
 * Pingar databasen (select 1, ingen data). Systemfråga utan användare, som
 * hälsokontroller: läser inget som hör till någon organisation.
 */
async function ping(): Promise<number | null> {
  const started = performance.now();
  try {
    await Promise.race([
      getServiceDb().execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PING_TIMEOUT_MS)),
    ]);
    return Math.max(1, Math.round(performance.now() - started));
  } catch {
    return null;
  }
}

/**
 * Mono-raden längst ner på inloggningssidorna: drift, svarstid, miljö och
 * klockan i Stockholm. Ett faktum, ingen dekor.
 */
export async function SystemStatus() {
  let envLabel: string | null = null;
  let method = "";
  try {
    const env = getServerEnv();
    envLabel = ENV_LABEL[env.APP_ENV];
    method = env.AUTH_PROVIDER === "dev" ? "Dev-inloggning" : "";
  } catch {
    envLabel = "Miljön är felkonfigurerad";
  }
  const ms = await ping();
  const now = wallClockIn(new Date(), TIME_ZONE);
  const parts = [
    ms === null ? null : `Svarstid ${formatInt(ms)} ms`,
    envLabel,
    method || null,
    `${formatTime(now)} Stockholm`,
  ].filter((p): p is string => Boolean(p));

  return (
    <p className="label flex flex-wrap items-center gap-x-3 gap-y-1 text-subtle" role="status">
      <span className="inline-flex items-center gap-2 text-muted">
        <StatusGlyph status={ms === null ? "critical" : "ok"} size={ms === null ? 8 : 6} />
        {ms === null ? "Inloggningen svarar inte" : "Alla system i drift"}
      </span>
      {parts.map((p) => (
        <span key={p} className="inline-flex items-center gap-3">
          <span aria-hidden className="h-px w-3 bg-line-strong" />
          <span className="tnum">{p}</span>
        </span>
      ))}
    </p>
  );
}
