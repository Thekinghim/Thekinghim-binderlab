/**
 * Incidenter (@/analytics/alerts) ↔ rader i public.alerts.
 *
 * En rad är en incident: ett problem över tid med nyckel (incident_key). Raden för en ny
 * incident skapas av larmjobbet; analytics-id:t (`${key}@${openedAt}`) byts då mot radens
 * uuid. Rena funktioner: ingen databas här.
 */

import type {
  AlertEvidence,
  AlertGroup,
  AlertIncident,
  AlertKind,
  AlertSeverity,
} from "@/analytics/alerts";

/** Raden som den läses ur public.alerts. */
export interface AlertRow {
  readonly id: string;
  readonly incidentKey: string | null;
  readonly alertGroup: string | null;
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly status: string;
  readonly machineId: string | null;
  readonly titleId: string | null;
  readonly title: string | null;
  readonly message: string | null;
  readonly evidence: unknown;
  readonly link: string | null;
  readonly triggeredAt: Date;
  readonly lastSeenAt: Date | null;
  readonly closedAt: Date | null;
  readonly lastNotifiedAt: Date | null;
  readonly notifiedSeverity: AlertSeverity | null;
  readonly notifyCount: number;
  readonly occurrences: number;
  readonly reopenCount: number;
  readonly oneShot: boolean;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: string | null;
  readonly resolvedNotifiedAt: Date | null;
  readonly suppressedBy: string | null;
}

const KINDS: readonly AlertKind[] = [
  "machine_suspected_fault",
  "machine_fault",
  "machine_offline",
  "low_stock",
  "import_failed",
  "day_anomaly",
];
const GROUPS: readonly AlertGroup[] = ["machine", "stock", "import", "sales"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRowId(id: string): boolean {
  return UUID.test(id);
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function emptyEvidence(): AlertEvidence {
  return {
    rule: "",
    period: null,
    orderIds: [],
    dates: [],
    titleIds: [],
    machineIds: [],
    storeIds: [],
    recipientIds: [],
    figures: [],
  };
}

/** Underlaget ur jsonb, med tomma listor där något saknas. */
export function parseEvidence(value: unknown): AlertEvidence {
  if (typeof value !== "object" || value === null) return emptyEvidence();
  const v = value as Partial<AlertEvidence>;
  const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return {
    rule: typeof v.rule === "string" ? v.rule : "",
    period: v.period && typeof v.period === "object" ? v.period : null,
    orderIds: list(v.orderIds),
    dates: list(v.dates),
    titleIds: list(v.titleIds),
    machineIds: list(v.machineIds),
    storeIds: list(v.storeIds),
    recipientIds: list(v.recipientIds),
    figures: list(v.figures),
    ...(v.importIds ? { importIds: list(v.importIds) } : {}),
    ...(v.dataSourceIds ? { dataSourceIds: list(v.dataSourceIds) } : {}),
  };
}

/** Rad → incident. Rader utan nyckel (skapade före fas 8) hoppas över (null). */
export function rowToIncident(row: AlertRow): AlertIncident | null {
  if (!row.incidentKey) return null;
  const kind = KINDS.includes(row.kind as AlertKind) ? (row.kind as AlertKind) : null;
  const group = GROUPS.includes(row.alertGroup as AlertGroup) ? (row.alertGroup as AlertGroup) : null;
  if (!kind || !group) return null;
  const openedAt = row.triggeredAt.toISOString();
  return {
    id: row.id,
    key: row.incidentKey,
    group,
    kind,
    severity: row.severity,
    status: row.status === "closed" ? "closed" : "open",
    machineId: row.machineId,
    titleId: row.titleId,
    title: row.title ?? "",
    detail: row.message ?? "",
    evidence: parseEvidence(row.evidence),
    link: row.link ?? "/drift",
    openedAt,
    lastSeenAt: iso(row.lastSeenAt) ?? openedAt,
    closedAt: iso(row.closedAt),
    lastNotifiedAt: iso(row.lastNotifiedAt),
    notifiedSeverity: row.notifiedSeverity,
    notifyCount: row.notifyCount,
    occurrences: row.occurrences,
    reopenCount: row.reopenCount,
    oneShot: row.oneShot,
    acknowledgedAt: iso(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy,
    resolvedNotifiedAt: iso(row.resolvedNotifiedAt),
    suppressedBy: row.suppressedBy,
  };
}

/** Kolumnerna som larmjobbet skriver för en incident (insert och update). */
export function incidentToColumns(i: AlertIncident) {
  return {
    incidentKey: i.key,
    alertGroup: i.group,
    kind: i.kind,
    severity: i.severity,
    status: i.status,
    machineId: i.machineId,
    titleId: i.titleId,
    title: i.title.slice(0, 300),
    message: i.detail.slice(0, 2000),
    evidence: i.evidence as unknown as Record<string, unknown>,
    link: i.link.startsWith("/") && !i.link.startsWith("//") ? i.link.slice(0, 500) : "/drift",
    triggeredAt: new Date(i.openedAt),
    lastSeenAt: new Date(i.lastSeenAt),
    closedAt: i.closedAt ? new Date(i.closedAt) : null,
    lastNotifiedAt: i.lastNotifiedAt ? new Date(i.lastNotifiedAt) : null,
    notifiedSeverity: i.notifiedSeverity,
    notifyCount: i.notifyCount,
    occurrences: i.occurrences,
    reopenCount: i.reopenCount,
    oneShot: i.oneShot,
    resolvedNotifiedAt: i.resolvedNotifiedAt ? new Date(i.resolvedNotifiedAt) : null,
    suppressedBy: i.suppressedBy,
  };
}

/** Sant om incidenten ändrats jämfört med raden den lästes från (så att oförändrade inte skrivs). */
export function incidentChanged(before: AlertIncident, after: AlertIncident): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}
