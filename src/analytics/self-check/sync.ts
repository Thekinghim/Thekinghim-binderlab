/**
 * Kontroll 4, "Synk färsk": Awish-synken går var femte minut (pg_cron). För varje aktiv
 * Awish-källa med kopplade automater:
 *
 *   senaste lyckade orderhämtning   > 30 min varning, > 2 h fel
 *   senaste läsning av facken       > 30 min varning, > 2 h fel
 *   Awish-kontot                    går ut inom 30 dagar: varning; inom 7 dagar eller
 *                                   redan utgånget: fel
 *
 * En pausad källa kontrolleras inte (ägaren har stängt av den).
 */

import { resultOf, skipped } from "./common";
import type { CheckFinding, CheckResult } from "./types";

export const SYNC_WARN_MINUTES = 30;
export const SYNC_FAIL_MINUTES = 120;

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
  }
  return resultOf("synk", {
    findings,
    figures: [{ label: "Äldsta synk", value: oldest, unit: "minutes" }],
    summary: {
      pass: `Orderna och facken hämtades från Awish för ${ageText(oldest)} sedan.`,
      warn: "Synken går, men inte i den vanliga takten (var femte minut).",
      fail: "Synken från Awish har stannat eller kontot går ut.",
    },
  });
}
