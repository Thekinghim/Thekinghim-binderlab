/**
 * Systemlarm: incidenter i public.alerts för fel som inte har någon regel i larmjobbet
 * (familjen `system`: misslyckade rapportutskick, månadsutkast och schemalagda jobb).
 *
 * - `raiseSystemAlert` skapar incidenten, eller räknar upp den öppna med samma nyckel
 *   (högst en öppen per nyckel: unikt index alerts_open_key_uq).
 * - `resolveSystemAlert` stänger den när samma sak lyckas.
 *
 * Skrivs som systemroll (getServiceDb): användare får bara kvittera larm (RLS), och felet ska
 * loggas även när användarens egen transaktion har rullats tillbaka. Organisationen kommer
 * alltid från en verifierad session eller ett systemjobb, aldrig från indata.
 *
 * Larmjobbet läser incidenterna men stänger dem aldrig (familjen utvärderas inte, se
 * @/analytics/alerts reconcileAlerts `evaluatedGroups`).
 */

import "server-only";

import { sql } from "drizzle-orm";

import {
  ALERT_GROUP,
  type AlertEvidence,
  type AlertKind,
  type AlertSeverity,
} from "@/analytics/alerts";
import type { Db } from "@/db/client";

/**
 * Typerna som skrivs här: systemfamiljen, och import_failed som reserv när larmjobbet inte
 * hann skapa importlarmet (se recordImportFailure).
 */
export type SystemAlertKind = Extract<AlertKind, "report_failed" | "job_failed" | "import_failed">;

export interface SystemAlertInput {
  readonly organizationId: string;
  readonly kind: SystemAlertKind;
  /** Incidentnyckel, t.ex. 'report:<id>', 'report_drafts:2026-10', 'job:larm'. */
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly detail: string;
  /** Regeln i klartext (visas under "Underlag" på Drift). */
  readonly rule: string;
  /** Sidan där felet åtgärdas (relativ sökväg). */
  readonly link: string;
  readonly figures?: readonly { key: string; label: string; value: number }[];
  readonly now?: Date;
}

export interface SystemAlertResult {
  readonly id: string;
  /** true = ny incident, false = samma öppna incident har setts igen. */
  readonly created: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z_]*:[^\s]+$/;

/** Kort, enradig text för en databaskolumn. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Felmeddelandet som text (högst `max` tecken), utan stackspår. */
export function errorText(error: unknown, max = 300): string {
  if (error instanceof Error) {
    // Drizzle lindar databasens fel i "Failed query: <sql> params: …": visa databasens eget
    // meddelande, inte frågan och dess parametrar.
    const cause = (error as { cause?: unknown }).cause;
    if (error.message.startsWith("Failed query:") && cause instanceof Error && cause.message) {
      return clip(`Databasfel: ${cause.message}`, max);
    }
    return clip(error.message || error.name, max);
  }
  if (typeof error === "string") return clip(error, max);
  return "Okänt fel";
}

function safeLink(link: string): string {
  return link.startsWith("/") && !link.startsWith("//") && !link.startsWith("/\\")
    ? link.slice(0, 500)
    : "/drift";
}

function evidenceOf(input: SystemAlertInput): AlertEvidence {
  return {
    rule: input.rule,
    period: null,
    orderIds: [],
    dates: [],
    titleIds: [],
    machineIds: [],
    storeIds: [],
    recipientIds: [],
    figures: (input.figures ?? []).map((f) => ({ ...f, unit: "count" as const })),
  };
}

function validate(organizationId: string, key: string): void {
  if (!UUID.test(organizationId)) throw new Error("organizationId måste vara ett uuid.");
  if (!KEY.test(key) || key.length > 300) throw new Error(`Ogiltig incidentnyckel: ${key}`);
}

/** Skapar eller uppdaterar den öppna incidenten med nyckeln. */
export async function raiseSystemAlert(
  db: Db,
  input: SystemAlertInput,
): Promise<SystemAlertResult> {
  validate(input.organizationId, input.key);
  const at = (input.now ?? new Date()).toISOString();
  const evidence = JSON.stringify(evidenceOf(input));
  const rows = Array.from(
    await db.execute<{ id: string; created: boolean }>(sql`
      insert into public.alerts as a (
        organization_id, incident_key, alert_group, kind, severity, status, title, message,
        evidence, link, triggered_at, last_seen_at, occurrences, notify_count
      ) values (
        ${input.organizationId}::uuid, ${input.key}, ${ALERT_GROUP[input.kind]}, ${input.kind},
        ${input.severity}::public.alert_severity, 'open', ${clip(input.title, 300)},
        ${clip(input.detail, 2000)}, ${evidence}::jsonb, ${safeLink(input.link)},
        ${at}::timestamptz, ${at}::timestamptz, 1, 0
      )
      on conflict (organization_id, incident_key) where status = 'open' and incident_key is not null
      do update set
        severity = excluded.severity,
        title = excluded.title,
        message = excluded.message,
        evidence = excluded.evidence,
        link = excluded.link,
        last_seen_at = excluded.last_seen_at,
        occurrences = a.occurrences + 1
      returning a.id, (xmax = 0) as created`),
  );
  const row = rows[0];
  if (!row) throw new Error("Larmet kunde inte sparas.");
  return { id: row.id, created: Boolean(row.created) };
}

/** Stänger öppna incidenter med nyckeln (när samma sak lyckas). Ger antalet stängda. */
export async function resolveSystemAlert(
  db: Db,
  organizationId: string,
  key: string,
  now: Date = new Date(),
): Promise<number> {
  validate(organizationId, key);
  const rows = Array.from(
    await db.execute<{ id: string }>(sql`
      update public.alerts
      set status = 'closed', closed_at = ${now.toISOString()}::timestamptz
      where organization_id = ${organizationId}::uuid
        and incident_key = ${key}
        and alert_group = 'system'
        and status = 'open'
      returning id`),
  );
  return rows.length;
}
