/**
 * Incidenter: samma problem larmar en gång, inte tio.
 *
 * Varje kandidat har en incidentnyckel (t.ex. 'machine:<id>'). reconcileAlerts jämför
 * körningens kandidater med tidigare incidenter:
 *
 *   kandidat + öppen incident med samma nyckel
 *     → incidenten uppdateras (senast sedd, text, underlag). Avisering bara om
 *       allvaret skärps ('escalated') eller, om incidenten inte är kvitterad, när
 *       påminnelsetiden för allvaret har gått sedan senaste aviseringen ('reminder').
 *   kandidat + stängd incident med samma nyckel, stängd för högst reopenWithinMinutes sedan
 *     → samma incident öppnas igen (fladder). Avisering ('reopened') bara om allvaret är högre
 *       än senast aviserat eller påminnelsetiden har gått.
 *   kandidat utan incident
 *     → ny incident, avisering ('new').
 *   engångslarm (oneShot) vars nyckel redan finns, öppen eller stängd
 *     → ingenting (har redan larmat).
 *   öppen incident utan kandidat, i en familj som utvärderades
 *     → stängs när den inte setts på resolveAfterMinutes; dessförinnan lämnas den öppen.
 *       'resolved' aviseras bara om något aviserats sedan förra 'resolved'.
 *
 * Funktionen är ren: anroparen sparar incidenterna och skickar aviseringarna.
 */

import { DomainError } from "@/domain";
import { parseInstant } from "@/analytics/todos/time";
import { ALERT_GROUP, dedupeCandidates, SEVERITY_RANK, suppressRelated } from "./rules";
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
  for (const [label, v] of [
    ["Tid till stängning", resolveAfter],
    ["Fönster för fladder", reopenWithin],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new DomainError("invalid_input", `${label} måste vara ett heltal ≥ 0, fick ${v}.`);
    }
  }

  const { kept } = suppressRelated(dedupeCandidates(candidates));
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
      const escalated = SEVERITY_RANK[c.severity] > SEVERITY_RANK[prev.severity];
      const reminder = !escalated && prev.acknowledgedAt === null && due(prev, c.severity);
      let next: AlertIncident = {
        ...prev,
        ...data,
        lastSeenAt: at,
        occurrences: prev.occurrences + 1,
      };
      if (escalated || reminder) {
        next = { ...next, lastNotifiedAt: at, notifyCount: prev.notifyCount + 1 };
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
      const lastSeverity = prev.severity;
      const escalated = SEVERITY_RANK[c.severity] > SEVERITY_RANK[lastSeverity];
      let next: AlertIncident = {
        ...prev,
        ...data,
        status: "open",
        closedAt: null,
        lastSeenAt: at,
        occurrences: prev.occurrences + 1,
        reopenCount: prev.reopenCount + 1,
      };
      if (escalated || due(prev, c.severity)) {
        next = { ...next, lastNotifiedAt: at, notifyCount: prev.notifyCount + 1 };
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
      notifyCount: 1,
      occurrences: 1,
      reopenCount: 0,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedNotifiedAt: null,
    };
    notifications.push(notification(created, "new", at));
    latestByKey.set(c.key, created);
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
