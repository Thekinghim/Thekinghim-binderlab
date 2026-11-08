/**
 * Larm (incidenter) till rader för listan på Drift. Serverkod: formar text, räknar inget.
 */

import type { AlertKind } from "@/analytics/alerts";
import { KIND_LABEL } from "@/server/alerts/subscriptions";

import type { AlertItem } from "../_components/alert-list";
import { figureText, formatWhen } from "./display";
import type { AlertView } from "./load";

export function toAlertItems(
  alerts: readonly AlertView[],
  timeZone: string,
  now: Date,
): AlertItem[] {
  return alerts.map((a) => ({
    id: a.id,
    severity: a.severity,
    kindLabel: KIND_LABEL[a.kind as AlertKind] ?? a.kind,
    title: a.title,
    detail: a.detail,
    rule: a.evidence.rule,
    figures: a.evidence.figures
      .map((f) => ({ label: f.label, value: figureText(f) }))
      .filter((f): f is { label: string; value: string } => f.value !== null),
    link: a.link,
    opened: formatWhen(a.openedAt, timeZone, now),
    lastSeen: formatWhen(a.lastSeenAt, timeZone, now),
    closed: a.closedAt ? formatWhen(a.closedAt, timeZone, now) : null,
    notifyCount: a.notifyCount,
    occurrences: a.occurrences,
    acknowledged: a.acknowledgedAt
      ? `${a.acknowledgedByName ?? "Någon"} tar det, sedan ${formatWhen(a.acknowledgedAt, timeZone, now)}`
      : null,
    open: a.status === "open",
  }));
}
