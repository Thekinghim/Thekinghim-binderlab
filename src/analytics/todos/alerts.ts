/**
 * Larm som kräver åtgärd: öppna, okvitterade larm (tabellen alerts, @/analytics/alerts) om
 * automater och importer. Ett kvitterat larm har någon som tar hand om det och står bara
 * på Drift.
 *
 * Tas inte med (de finns redan i Att göra eller kräver inget):
 *   - titel nära slut (low_stock): samma sak som påfyllningspunkten
 *   - avvikande dag (day_anomaly): engångsavisering, ingen åtgärd
 *   - allvar 'info'
 *   - larm om en automat som redan står som tyst automat (stale-machine)
 *
 *   nivå        = 'now' för kritiska, 'soon' för varningar
 *   nyckel      = 'alert:<incidentnyckel>'
 *   fingerprint = när incidenten öppnades och allvaret: ett larm som öppnas igen eller
 *                 skärps tar upp en avbockad punkt igen
 */

import { evidence } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import { tryParseInstant } from "./time";
import type { AlertRef, TodoItem, TodoLevel } from "./types";

/** Larmtyper som blir punkter i Att göra. */
export const ACTION_ALERT_KINDS: ReadonlySet<string> = new Set([
  "machine_fault",
  "machine_suspected_fault",
  "machine_offline",
  "import_failed",
  // Systemlarm (src/server/monitoring): misslyckat rapportutskick, månadsutkast eller jobb.
  "report_failed",
  "job_failed",
  // Daglig kontroll (src/server/self-check): en kontroll gick inte igenom.
  "self_check",
]);

const KIND_RULE: Record<string, string> = {
  machine_fault: "Automaten rapporterar fel.",
  machine_suspected_fault:
    "Automaten säljer mycket mindre än vanligt för tiden på dygnet (maskinhälsan på Drift).",
  machine_offline:
    "Awish säger att automaten är offline sedan minst 20 minuter, eller (utan Awish-data) har den inte sålt på länge (maskinhälsan på Drift).",
  import_failed: "Senaste importen från datakällan misslyckades.",
  report_failed: "Ett rapportutskick eller månadens utkast misslyckades.",
  job_failed: "Ett schemalagt jobb misslyckades.",
  self_check: "Daglig kontroll: en av kontrollerna gick inte igenom.",
};

/** Länk till underlaget: automatens tidslinje på Drift, Datakällor för importer. */
export function alertLink(a: Pick<AlertRef, "kind" | "machineId"> & { key?: string }): string {
  // Fortnox (src/server/fortnox/sync.ts): kopplingen eller ett stoppat verifikat.
  if (a.key?.startsWith("fortnox:")) return "/datakallor/fortnox";
  if (a.kind === "import_failed") return "/datakallor";
  if (a.kind === "report_failed") return "/rapporter";
  if (a.kind === "self_check") return "/installningar/kontroll";
  if (a.machineId) return `/drift/automat/${encodeURIComponent(a.machineId)}`;
  return "/drift#larm";
}

/** Punkter för larm som kräver åtgärd. `staleMachineIds`: automater som redan har en punkt. */
export function alertTodos(
  ctx: TodoContext,
  staleMachineIds: ReadonlySet<string> = new Set(),
): TodoItem[] {
  const alerts = ctx.input.alerts ?? [];
  const out: TodoItem[] = [];
  const seen = new Set<string>();
  const sorted = [...alerts].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const a of sorted) {
    if (a.acknowledged) continue;
    if (a.severity === "info") continue;
    if (!ACTION_ALERT_KINDS.has(a.kind)) continue;
    if (a.machineId && staleMachineIds.has(a.machineId)) continue;
    const key = `alert:${a.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const level: TodoLevel = a.severity === "critical" ? "now" : "soon";
    const opened = tryParseInstant(a.openedAt);
    const hours =
      opened === null ? null : Math.max(0, Math.floor((ctx.nowMs - opened) / 3_600_000));
    out.push({
      key,
      fingerprint: `${opened === null ? a.openedAt : new Date(opened).toISOString()}|${a.severity}`,
      kind: "alert",
      level,
      urgency: urgencyOf(level, null),
      atStakeOre: null,
      daysLeft: null,
      title: a.title.trim() || "Larm utan rubrik",
      detail: a.detail.trim() || "Öppna larmet för underlaget.",
      evidence: evidence({
        rule: KIND_RULE[a.kind] ?? "Ett öppet larm som ingen kvitterat.",
        machineIds: a.machineId ? [a.machineId] : [],
        titleIds: a.titleId ? [a.titleId] : [],
        figures:
          hours === null ? [] : [{ key: "openHours", label: "Öppet", value: hours, unit: "hours" }],
      }),
      link: alertLink(a),
      action: {
        kind: "open-alert",
        label: a.key.startsWith("fortnox:")
          ? "Öppna Fortnox"
          : a.kind === "import_failed"
            ? "Visa importerna"
            : "Öppna automaten",
        params: { alertId: a.id },
      },
    });
  }
  return out;
}
