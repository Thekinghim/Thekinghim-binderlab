/**
 * Kontroll 4, "Synk färsk": Awish-synken går var femte minut (pg_cron). För varje aktiv
 * Awish-källa med kopplade automater:
 *
 *   senaste lyckade orderhämtning   > 30 min varning, > 2 h fel
 *   senaste läsning av facken       > 30 min varning, > 2 h fel
 *   Awish-kontot                    går ut inom 30 dagar: varning; inom 7 dagar eller
 *                                   redan utgånget: fel
 *
 *   påfyllningar till Awish        väntar mer än 60 min: fel
 *   Awish-kontots slutdag           inte kontrollerad på 48 h: varning
 *   reservvägen (webbpanelen)       mer än ett dygn: varning ("kontakta Awish")
 *
 * Lagret räknas som läst oavsett väg (Open API eller webbpanelen). En pausad källa
 * kontrolleras inte (ägaren har stängt av den).
 */

import { AWISH_PATH_LABEL, type AwishPathName } from "@/analytics/watch/awish";

import { resultOf, skipped } from "./common";
import type { CheckFinding, CheckResult } from "./types";

export const SYNC_WARN_MINUTES = 30;
export const SYNC_FAIL_MINUTES = 120;
/** Påfyllningar som väntar på Awish längre än så (efter de automatiska försöken): fel. */
export const PUSH_PENDING_FAIL_MINUTES = 60;
/** Kontots slutdag ska kontrolleras varje dygn; efter så länge: varning. */
export const MERCHANT_WARN_HOURS = 48;
/** Reservvägen längre än så: varning. */
export const FALLBACK_WARN_HOURS = 24;

/** Hälsan per Awish-väg för källan (public.awish_path_health), när den finns. */
export interface SyncSourceHealth {
  /** Automater som väntar på Awish, och sedan när den äldsta väntar (ISO). */
  readonly pushPending: number;
  readonly pushPendingSince: string | null;
  /** När kontots slutdag senast lästes (Open API eller webbpanelen), null = aldrig. */
  readonly merchantCheckedAt: string | null;
  /** Vägar som går via webbpanelen, och sedan när (ISO). */
  readonly fallbacks: readonly { readonly path: AwishPathName; readonly since: string }[];
}

export interface SyncSourceState {
  readonly name: string;
  readonly paused: boolean;
  readonly linkedMachines: number;
  /** Senaste lyckade orderhämtning (ISO) eller null. */
  readonly lastSuccessAt: string | null;
  /** Senaste läsning av alla automaters fack (ISO) eller null. */
  readonly stockReadAt: string | null;
  /** Påminnelsen om kontot (src/server/awish/expiry.ts awishExpiryNotice), eller null. */
  readonly expiry: { readonly level: "now" | "soon"; readonly text: string } | null;
  /** När källan kopplades (en ny källa har inte hunnit kontrollera kontot). */
  readonly createdAt?: string | null;
  readonly health?: SyncSourceHealth | null;
}

function minutesAgo(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 60_000)) : null;
}

/** Påfyllningskön, kontots slutdag och reservvägen för källan. */
function judgeHealth(s: SyncSourceState, nowMs: number, out: CheckFinding[]): void {
  const h = s.health;
  if (!h) return;
  const pending = minutesAgo(h.pushPendingSince, nowMs);
  if (h.pushPending > 0 && pending !== null && pending > PUSH_PENDING_FAIL_MINUTES) {
    out.push({
      level: "fail",
      text: `${s.name}: ${h.pushPending === 1 ? "en automat" : `${h.pushPending} automater`} har väntat på Awish i ${ageText(pending)}. Påfyllningarna är sparade i Binderlab.`,
    });
  }
  const merchant = minutesAgo(h.merchantCheckedAt, nowMs);
  const created = minutesAgo(s.createdAt ?? null, nowMs);
  const limit = MERCHANT_WARN_HOURS * 60;
  if (merchant === null ? created === null || created > limit : merchant > limit) {
    out.push({
      level: "warn",
      text:
        merchant === null
          ? `${s.name}: Awish-kontots slutdag har aldrig kunnat läsas.`
          : `${s.name}: Awish-kontots slutdag lästes senast för ${ageText(merchant)} sedan.`,
    });
  }
  for (const f of h.fallbacks) {
    const m = minutesAgo(f.since, nowMs);
    if (m === null || m <= FALLBACK_WARN_HOURS * 60) continue;
    out.push({
      level: "warn",
      text: `${s.name}: Open API har inte fungerat på ett dygn – kontakta Awish. ${AWISH_PATH_LABEL[f.path]} har gått via webbpanelen i ${ageText(m)}.`,
    });
  }
}

function ageText(minutes: number): string {
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} dygn`;
}

function judge(
  what: string,
  source: string,
  iso: string | null,
  nowMs: number,
  out: CheckFinding[],
): number | null {
  if (iso === null || !Number.isFinite(Date.parse(iso))) {
    out.push({ level: "fail", text: `${source}: ${what} har aldrig lyckats.` });
    return null;
  }
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
  if (minutes > SYNC_FAIL_MINUTES) {
    out.push({
      level: "fail",
      text: `${source}: ${what} lyckades senast för ${ageText(minutes)} sedan.`,
    });
  } else if (minutes > SYNC_WARN_MINUTES) {
    out.push({
      level: "warn",
      text: `${source}: ${what} lyckades senast för ${ageText(minutes)} sedan.`,
    });
  }
  return minutes;
}

export function syncFreshnessCheck(input: {
  readonly sources: readonly SyncSourceState[];
  readonly now: Date;
}): CheckResult {
  const active = input.sources.filter((s) => !s.paused && s.linkedMachines > 0);
  if (active.length === 0) {
    return skipped(
      "synk",
      input.sources.some((s) => s.paused)
        ? "Awish-synken är pausad."
        : "Ingen Awish-källa med kopplade automater.",
    );
  }
  const nowMs = input.now.getTime();
  const findings: CheckFinding[] = [];
  let oldest = 0;
  for (const s of active) {
    const orders = judge("orderhämtningen", s.name, s.lastSuccessAt, nowMs, findings);
    const stock = judge("läsningen av facken", s.name, s.stockReadAt, nowMs, findings);
    oldest = Math.max(oldest, orders ?? 0, stock ?? 0);
    if (s.expiry) {
      findings.push({ level: s.expiry.level === "now" ? "fail" : "warn", text: s.expiry.text });
    }
    judgeHealth(s, nowMs, findings);
  }
  return resultOf("synk", {
    findings,
    figures: [{ label: "Äldsta synk", value: oldest, unit: "minutes" }],
    summary: {
      pass: `Orderna och facken hämtades från Awish för ${ageText(oldest)} sedan.`,
      warn: "Synken går, men inte som vanligt (takten, reservvägen eller kontots slutdag).",
      fail: "Synken från Awish har stannat, påfyllningar når inte Awish eller kontot går ut.",
    },
  });
}
