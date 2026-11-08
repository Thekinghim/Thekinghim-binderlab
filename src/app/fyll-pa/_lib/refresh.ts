/**
 * Uppdatera i Fyll på: rena funktioner (testas i refresh.test.ts).
 *
 * - `clockLabel`: en tidpunkt som klockslag i organisationens tidszon ("14:52"), "igår 14:52"
 *   eller "6 nov 14:52" när den är äldre.
 * - `lastAwishRead`: senaste Awish-läsningen bland automaterna.
 * - `autoRefreshDue`: ska sidan hämta om datan när appen öppnas igen? Högst en gång per
 *   AUTO_REFRESH_MS (dyker också upp när en sparad sida från service workern visas).
 * - `refreshNotice`: raden efter Uppdatera ("Uppdaterat 14:52" eller ett lugnt fel).
 */

import { wallClockIn } from "@/components/shell/period-state";
import { formatters } from "@/i18n/format";
import { sv, type Messages } from "@/i18n/sv";

/** Sidan hämtar om datan högst så här ofta av sig själv (fokus, synlig igen). */
export const AUTO_REFRESH_MS = 30_000;

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "14:52" i dag, "igår 14:52", annars "6 nov 14:52" (organisationens tidszon). */
export function clockLabel(
  at: string | Date,
  now: string | Date,
  timeZone: string,
  t: Messages = sv,
): string {
  const f = formatters(t.locale);
  const a = wallClockIn(new Date(at), timeZone);
  const n = wallClockIn(new Date(now), timeZone);
  if (dayKey(a) === dayKey(n)) return f.time(a);
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (dayKey(a) === dayKey(yesterday)) return t.fill.yesterdayAt(f.time(a));
  return f.dateTime(a, { now: n });
}

/** Senaste Awish-läsningen (ISO) bland automaterna, null om ingen har lästs. */
export function lastAwishRead(machines: readonly { syncedAt: string | null }[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const m of machines) {
    if (!m.syncedAt) continue;
    const ms = Date.parse(m.syncedAt);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = m.syncedAt;
    }
  }
  return best;
}

/**
 * Ska datan hämtas om nu? Sant när senaste hämtningen är minst `minMs` gammal. En tidpunkt
 * i framtiden (klockan ändrad) räknas som gammal, så att sidan aldrig fastnar.
 */
export function autoRefreshDue(lastMs: number, nowMs: number, minMs = AUTO_REFRESH_MS): boolean {
  const age = nowMs - lastMs;
  return age >= minMs || age < 0;
}

/** Svaret från refreshFill (eller att anropet inte nådde servern). */
export type RefreshOutcome =
  | {
      readonly ok: true;
      readonly status:
        | "read"
        | "partial"
        | "failed"
        | "throttled"
        | "busy"
        | "paused"
        | "no_credentials"
        | "archived"
        | "none"
        | "demo";
      readonly lastReadAt: string | null;
    }
  | { readonly ok: false; readonly offline: boolean };

export interface RefreshNotice {
  readonly text: string;
  readonly tone: "ok" | "warn";
}

/**
 * Raden efter Uppdatera. Lyckad läsning, spärr (någon läste nyss) eller ingen Awish-källa:
 * "Uppdaterat 14:52" (sidan har hämtat om datan). Gick Awish inte att nå: "Kunde inte nå
 * Awish – visar senaste läsningen 14:47".
 */
export function refreshNotice(
  outcome: RefreshOutcome,
  ctx: { now: string | Date; lastReadAt: string | null; timeZone: string; t?: Messages },
): RefreshNotice {
  const t = ctx.t ?? sv;
  const at = (v: string | Date) => clockLabel(v, ctx.now, ctx.timeZone, t);
  const last = (outcome.ok ? outcome.lastReadAt : null) ?? ctx.lastReadAt;
  const latest = last ? at(last) : null;
  if (!outcome.ok) {
    return {
      text: outcome.offline ? t.fill.refreshOffline(latest) : t.fill.refreshFailed(latest),
      tone: "warn",
    };
  }
  switch (outcome.status) {
    case "failed":
    case "no_credentials":
      return { text: t.fill.refreshFailed(latest), tone: "warn" };
    case "partial":
      return { text: t.fill.refreshPartial(at(ctx.now)), tone: "warn" };
    default:
      return { text: t.fill.refreshUpdated(at(ctx.now)), tone: "ok" };
  }
}
