/**
 * Incidenter: samma problem larmar en gång, inte tio.
 *
 * Varje kandidat har en incidentnyckel (t.ex. 'machine:<id>'). reconcileAlerts jämför
 * körningens kandidater med tidigare incidenter:
 *
 *   kandidat + öppen incident med samma nyckel
 *     → incidenten uppdateras (senast sedd, allvar, text, underlag). Avisering bara om
 *       allvaret blir högre än i den senaste aviseringen ('escalated'; fladder warning ↔
 *       critical larmar alltså en gång), eller, om incidenten inte är kvitterad, när
 *       påminnelsetiden för allvaret har gått sedan senaste aviseringen ('reminder').
 *   kandidat + stängd incident med samma nyckel, stängd för högst reopenWithinMinutes sedan
 *     → samma incident öppnas igen (fladder). Avisering ('reopened') bara om allvaret är högre
 *       än senast aviserat, eller om incidenten inte är kvitterad och påminnelsetiden har gått.
 *   kandidat utan incident
 *     → ny incident, avisering ('new').
 *   engångslarm (oneShot) vars nyckel redan finns, öppen eller stängd
 *     → ingenting (har redan larmat eller strukits).
 *   låg dag som förklaras av ett annat larm
 *     → stryks utan avisering och sparas stängd med `suppressedBy`, så att den inte larmar i en
 *       senare körning när orsaken har löst sig. Förklaring är dels samma körnings kandidater
 *       (suppressRelated), dels en tidigare driftincident för automaten (för hela
 *       organisationen: vilken automat som helst) eller en kritisk importincident som var
 *       öppen någon gång under dagen.
 *   öppen incident utan kandidat, i en familj som utvärderades
 *     → stängs när den inte setts på resolveAfterMinutes; dessförinnan lämnas den öppen.
 *       'resolved' aviseras bara om något aviserats sedan förra 'resolved'.
 *
 * Funktionen är ren: anroparen sparar incidenterna och skickar aviseringarna.
 */

import { addDays, DomainError } from "@/domain";
import { DEFAULT_TIME_ZONE, parseInstant } from "@/analytics/todos/time";
import { localDayStartMs } from "@/analytics/health/calendar";
import {
  ALERT_GROUP,
  dayAnomalyDate,
  dedupeCandidates,
  SEVERITY_RANK,
  suppressRelated,
} from "./rules";
import type {
  AlertCandidate,
  AlertGroup,
  AlertIncident,
  AlertNotification,
  AlertSeverity,
  NotificationReason,
  ReconcileOptions,
  ReconcileResult,
} from "./types";

/** Standardvärden för incidenthanteringen. */
export const RECONCILE_DEFAULTS = {
  renotifyAfterHours: { critical: 4, warning: 24, info: null } as Record<
    AlertSeverity,
    number | null
  >,
  resolveAfterMinutes: 30,
  reopenWithinMinutes: 120,
};

const ALL_GROUPS: readonly AlertGroup[] = ["machine", "stock", "import", "sales"];
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function notification(i: AlertIncident, reason: NotificationReason, at: string): AlertNotification {
  return {
    incidentId: i.id,
    key: i.key,
    kind: i.kind,
    severity: i.severity,
    reason,
    machineId: i.machineId,
    titleId: i.titleId,
    title: reason === "resolved" ? `Löst: ${i.title}` : i.title,
    detail: i.detail,
    at,
    evidence: i.evidence,
    link: i.link,
  };
}

function fromCandidate(c: AlertCandidate) {
  return {
    key: c.key,
    group: ALERT_GROUP[c.kind],
    kind: c.kind,
    severity: c.severity,
    machineId: c.machineId,
    titleId: c.titleId,
    title: c.title,
    detail: c.detail,
    evidence: c.evidence,
    link: c.link,
    oneShot: c.oneShot ?? false,
  };
}

/** Rang för senast aviserade allvar; −1 när inget aviserats. */
function notifiedRank(i: AlertIncident): number {
  return i.notifiedSeverity === null ? -1 : SEVERITY_RANK[i.notifiedSeverity];
}

/**
 * Incidenten som förklarar en låg dag, bland tidigare incidenter: en driftincident för samma
 * automat (för hela organisationen: vilken automat som helst) eller en kritisk importincident,
 * som var öppen någon gång under affärsdagen [lokal midnatt, nästa midnatt).
 */
function explainedByHistory(
  c: AlertCandidate,
  incidents: Iterable<AlertIncident>,
  nowMs: number,
  timeZone: string,
): string | null {
  if (c.kind !== "day_anomaly" || c.severity !== "warning") return null;
  const date = dayAnomalyDate(c);
  if (date === null) return null;
  const dayStart = localDayStartMs(date, timeZone);
  const dayEnd = localDayStartMs(addDays(date, 1), timeZone);
  const keys: string[] = [];
  for (const i of incidents) {
    if (i.suppressedBy !== null) continue;
    const relevant =
      (i.group === "machine" && (c.machineId === null || i.machineId === c.machineId)) ||
      (i.group === "import" && i.severity === "critical");
    if (!relevant) continue;
    const from = parseInstant(i.openedAt);
    const to = i.closedAt === null ? nowMs : parseInstant(i.closedAt);
    if (from < dayEnd && to >= dayStart) keys.push(i.key);
  }
  return keys.sort()[0] ?? null;
}

/** Kvitterar en incident: inga fler påminnelser (skärpning aviseras fortfarande). */
export function acknowledgeIncident(
  incident: AlertIncident,
  userId: string,
  at: Date | string | number,
): AlertIncident {
  return { ...incident, acknowledgedAt: iso(parseInstant(at)), acknowledgedBy: userId };
}

/**
 * Jämför körningens kandidater med tidigare incidenter och ger uppdaterade incidenter och de
 * aviseringar som ska skickas (se filens beskrivning för reglerna). Kandidaterna dedupliceras
 * på nyckel och grupperas (suppressRelated) först.
 */
export function reconcileAlerts(
  candidates: readonly AlertCandidate[],
  previous: readonly AlertIncident[],
  now: Date | string | number,
  options: ReconcileOptions = {},
): ReconcileResult {
  const nowMs = parseInstant(now);
  const at = iso(nowMs);
  const renotify = { ...RECONCILE_DEFAULTS.renotifyAfterHours, ...options.renotifyAfterHours };
  const resolveAfter = options.resolveAfterMinutes ?? RECONCILE_DEFAULTS.resolveAfterMinutes;
  const reopenWithin = options.reopenWithinMinutes ?? RECONCILE_DEFAULTS.reopenWithinMinutes;
  const groups = new Set(options.evaluatedGroups ?? ALL_GROUPS);
  const tz = options.timeZone ?? DEFAULT_TIME_ZONE;
  for (const [label, v] of [
    ["Tid till stängning", resolveAfter],
    ["Fönster för fladder", reopenWithin],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new DomainError("invalid_input", `${label} måste vara ett heltal ≥ 0, fick ${v}.`);
    }
  }

  const grouped = suppressRelated(dedupeCandidates(candidates));
  const kept: AlertCandidate[] = [];
  const suppressed = [...grouped.suppressed];
  for (const c of grouped.kept) {
    const by = explainedByHistory(c, previous, nowMs, tz);
    if (by !== null) suppressed.push({ candidate: c, by });
    else kept.push(c);
  }
  for (const c of kept) {
    if (!groups.has(ALERT_GROUP[c.kind])) {
      throw new DomainError(
        "invalid_input",
        `Kandidaten ${c.key} hör till familjen ${ALERT_GROUP[c.kind]}, som inte utvärderas.`,
      );
    }
  }

  // Senaste incidenten per nyckel (öppen före stängd, sedan senast öppnad).
  const latestByKey = new Map<string, AlertIncident>();
  const others: AlertIncident[] = [];
  const sortedPrev = [...previous].sort(
    (a, b) =>
      (a.status === "open" ? 1 : 0) - (b.status === "open" ? 1 : 0) ||
      parseInstant(a.openedAt) - parseInstant(b.openedAt) ||
      (a.id < b.id ? -1 : 1),
  );
  for (const inc of sortedPrev) {
    const prev = latestByKey.get(inc.key);
    if (prev) others.push(prev);
    latestByKey.set(inc.key, inc);
  }
  // Bara en öppen incident per nyckel: äldre öppna dubbletter stängs.
  const result: AlertIncident[] = others.map((o) =>
    o.status === "open" ? { ...o, status: "closed", closedAt: at } : o,
  );
  const notifications: AlertNotification[] = [];
  const seen = new Set<string>();

  /** Påminnelsetiden för allvaret har gått sedan senaste aviseringen (eller ingen avisering finns). */
  const due = (inc: AlertIncident, severity: AlertSeverity): boolean => {
    const hours = renotify[severity];
    if (hours === null || hours === undefined) return false;
    if (inc.lastNotifiedAt === null) return true;
    return nowMs - parseInstant(inc.lastNotifiedAt) >= hours * HOUR_MS;
  };

  for (const c of kept) {
    seen.add(c.key);
    const prev = latestByKey.get(c.key);
    const data = fromCandidate(c);
    if (c.oneShot && prev) continue;

    if (prev && prev.status === "open") {
      const escalated = SEVERITY_RANK[c.severity] > notifiedRank(prev);
      const reminder = !escalated && prev.acknowledgedAt === null && due(prev, c.severity);
      let next: AlertIncident = {
        ...prev,
        ...data,
        lastSeenAt: at,
        occurrences: prev.occurrences + 1,
      };
      if (escalated || reminder) {
        next = {
          ...next,
          lastNotifiedAt: at,
          notifiedSeverity: c.severity,
          notifyCount: prev.notifyCount + 1,
        };
        notifications.push(notification(next, escalated ? "escalated" : "reminder", at));
      }
      latestByKey.set(c.key, next);
      continue;
    }

    if (
      prev &&
      prev.closedAt !== null &&
      nowMs - parseInstant(prev.closedAt) <= reopenWithin * MINUTE_MS
    ) {
      const escalated = SEVERITY_RANK[c.severity] > notifiedRank(prev);
      let next: AlertIncident = {
        ...prev,
        ...data,
        status: "open",
        closedAt: null,
        lastSeenAt: at,
        occurrences: prev.occurrences + 1,
        reopenCount: prev.reopenCount + 1,
      };
      if (escalated || (prev.acknowledgedAt === null && due(prev, c.severity))) {
        next = {
          ...next,
          lastNotifiedAt: at,
          notifiedSeverity: c.severity,
          notifyCount: prev.notifyCount + 1,
        };
        notifications.push(notification(next, "reopened", at));
      }
      latestByKey.set(c.key, next);
      continue;
    }

    if (prev) result.push(prev);
    const created: AlertIncident = {
      id: `${c.key}@${at}`,
      ...data,
      status: c.oneShot ? "closed" : "open",
      openedAt: at,
      lastSeenAt: at,
      closedAt: c.oneShot ? at : null,
      lastNotifiedAt: at,
      notifiedSeverity: c.severity,
      notifyCount: 1,
      occurrences: 1,
      reopenCount: 0,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedNotifiedAt: null,
      suppressedBy: null,
    };
    notifications.push(notification(created, "new", at));
    latestByKey.set(c.key, created);
  }

  // Strukna engångslarm sparas stängda utan avisering: samma nyckel larmar inte senare.
  for (const { candidate: c, by } of suppressed) {
    if (!c.oneShot || latestByKey.has(c.key)) continue;
    latestByKey.set(c.key, {
      id: `${c.key}@${at}`,
      ...fromCandidate(c),
      status: "closed",
      openedAt: at,
      lastSeenAt: at,
      closedAt: at,
      lastNotifiedAt: null,
      notifiedSeverity: null,
      notifyCount: 0,
      occurrences: 1,
      reopenCount: 0,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedNotifiedAt: null,
      suppressedBy: by,
    });
  }

  for (const [key, inc] of latestByKey) {
    if (seen.has(key) || inc.status !== "open" || !groups.has(inc.group)) continue;
    if (nowMs - parseInstant(inc.lastSeenAt) < resolveAfter * MINUTE_MS) continue;
    // "Löst" aviseras bara om något aviserats sedan förra "löst" (en tyst återöppning vid
    // fladder ger alltså ingen ny "löst").
    const announce =
      inc.lastNotifiedAt !== null &&
      (inc.resolvedNotifiedAt === null ||
        parseInstant(inc.lastNotifiedAt) > parseInstant(inc.resolvedNotifiedAt));
    const closed: AlertIncident = {
      ...inc,
      status: "closed",
      closedAt: at,
      resolvedNotifiedAt: announce ? at : inc.resolvedNotifiedAt,
    };
    latestByKey.set(key, closed);
    if (announce) notifications.push(notification(closed, "resolved", at));
  }

  result.push(...latestByKey.values());
  const severityOrder = (i: { severity: AlertSeverity }) => -SEVERITY_RANK[i.severity];
  result.sort(
    (a, b) =>
      (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) ||
      severityOrder(a) - severityOrder(b) ||
      parseInstant(b.openedAt) - parseInstant(a.openedAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  notifications.sort(
    (a, b) => severityOrder(a) - severityOrder(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { incidents: result, notifications };
}
