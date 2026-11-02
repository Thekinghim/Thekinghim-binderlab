/**
 * Driftfel → Sentry-händelse (när SENTRY_DSN finns) OCH larm i public.alerts (syns på Drift
 * och i Att göra). En funktion per sorts fel:
 *
 *   recordImportFailure   misslyckad import (./import-failure.ts)
 *   recordReportSend      rapportutskick: larm 'report:<id>' när en mottagare inte fick
 *                         rapporten eller utskicket avbröts; stängs när utskicket lyckas
 *   recordDraftsOutcome   månadsutkasten (schemalagt): 'report_drafts:<månad>'
 *   recordJobOutcome      schemalagt jobb (larmjobbet): 'job:<namn>'
 *
 * Inget här kastar: övervakningen får aldrig dölja det ursprungliga felet eller stoppa ett
 * jobb. Fel i själva övervakningen skrivs till serverloggen.
 */

import "server-only";

import type { IsoMonth } from "@/domain";
import { getServiceDb, type Db } from "@/db/client";

import { captureToSentry, type FailureCapture } from "./sentry";
import { errorText, raiseSystemAlert, resolveSystemAlert } from "./system-alerts";

export interface MonitoringDeps {
  /** Systemrollens databas. Standard: getServiceDb(). */
  readonly db?: Db;
  /** Sentry. Standard: @sentry/nextjs när SENTRY_DSN finns. */
  readonly capture?: FailureCapture;
  readonly now?: Date;
}

export interface MonitoringOutcome {
  /** Larmets id (public.alerts), eller null om inget larm skrevs. */
  readonly alertId: string | null;
  /** Sentrys händelse-id, eller null (ingen DSN, eller inget fel). */
  readonly sentryId: string | null;
  /** Antal larm som stängdes (när det lyckades). */
  readonly resolved: number;
}

export const NOTHING: MonitoringOutcome = { alertId: null, sentryId: null, resolved: 0 };

export function dbOf(deps: MonitoringDeps): Db {
  return deps.db ?? getServiceDb();
}

export async function safely<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error(`[monitoring] ${what}`, error);
    return fallback;
  }
}

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];

function monthText(month: string): string {
  const [y, m] = month.split("-");
  const name = MONTHS[Number(m) - 1];
  return name ? `${name} ${y}` : month;
}

// ---------------------------------------------------------------------------
// Rapporter
// ---------------------------------------------------------------------------

export interface ReportSendInput {
  readonly organizationId: string;
  readonly reportId: string;
  /** T.ex. "Butiksrapport oktober 2026 · Spelbutiken". */
  readonly label: string;
  readonly month: IsoMonth | string;
  readonly sent: number;
  /** Mottagare som inte fick rapporten (bara antal och felen, inga adresser). */
  readonly failedErrors: readonly string[];
  /** Utskicket avbröts (PDF eller mejl kunde inte skapas). */
  readonly error?: unknown;
}

/** Utfallet av ett rapportutskick: larm vid fel, stäng larmet när allt gick fram. */
export async function recordReportSend(
  deps: MonitoringDeps,
  input: ReportSendInput,
): Promise<MonitoringOutcome> {
  const db = dbOf(deps);
  const key = `report:${input.reportId}`;
  const failed = input.failedErrors.length;
  const aborted = input.error !== undefined && input.error !== null;
  if (!aborted && failed === 0) {
    if (input.sent === 0) return NOTHING;
    const resolved = await safely(
      "stänga rapportlarm",
      () => resolveSystemAlert(db, input.organizationId, key, deps.now),
      0,
    );
    return { ...NOTHING, resolved };
  }
  const reason = aborted ? errorText(input.error) : errorText(input.failedErrors[0] ?? "");
  const detail = aborted
    ? `Utskicket avbröts innan något skickades. Fel: ${reason}. Försök igen under Rapporter.`
    : `${failed} ${failed === 1 ? "mottagare" : "mottagare"} fick inte rapporten${input.sent > 0 ? ` (${input.sent} fick den)` : ""}. Fel: ${reason}. Skicka igen under Rapporter.`;
  const capture = deps.capture ?? captureToSentry;
  const sentryId = await safely(
    "Sentry (rapport)",
    () =>
      capture({
        error: aborted ? input.error : null,
        message: `Rapportutskick misslyckades: ${reason}`,
        tags: {
          area: "report",
          kind: "report_failed",
          organization_id: input.organizationId,
          report_id: input.reportId,
        },
        extra: { sent: input.sent, failed, aborted },
        fingerprint: ["report_failed", aborted ? "aborted" : "recipient", reason],
      }),
    null,
  );
  const alert = await safely(
    "rapportlarm",
    () =>
      raiseSystemAlert(db, {
        organizationId: input.organizationId,
        kind: "report_failed",
        key,
        severity: "critical",
        title: `Utskicket av ${input.label} misslyckades`,
        detail,
        rule: "Larm när ett rapportutskick misslyckas. Stängs när rapporten har skickats.",
        link: `/rapporter?manad=${encodeURIComponent(String(input.month))}`,
        figures: [
          { key: "failed", label: "Mottagare utan rapport", value: failed },
          { key: "sent", label: "Skickade", value: input.sent },
        ],
        now: deps.now,
      }),
    null,
  );
  return { alertId: alert?.id ?? null, sentryId, resolved: 0 };
}

export interface DraftsOutcomeInput {
  readonly organizationId: string;
  readonly month: IsoMonth | string;
  readonly created: number;
  readonly errors: readonly string[];
}

/** Månadsutkasten (schemalagt jobb, /api/cron/rapporter) för en organisation. */
export async function recordDraftsOutcome(
  deps: MonitoringDeps,
  input: DraftsOutcomeInput,
): Promise<MonitoringOutcome> {
  const db = dbOf(deps);
  const key = `report_drafts:${input.month}`;
  if (input.errors.length === 0) {
    const resolved = await safely(
      "stänga larm för månadsutkast",
      () => resolveSystemAlert(db, input.organizationId, key, deps.now),
      0,
    );
    return { ...NOTHING, resolved };
  }
  const count = input.errors.length;
  const reason = errorText(input.errors[0] ?? "");
  const capture = deps.capture ?? captureToSentry;
  const sentryId = await safely(
    "Sentry (månadsutkast)",
    () =>
      capture({
        error: null,
        message: `Månadsutkast misslyckades: ${reason}`,
        tags: {
          area: "report",
          kind: "report_failed",
          job: "rapporter",
          organization_id: input.organizationId,
        },
        extra: { month: String(input.month), created: input.created, failed: count },
        fingerprint: ["report_drafts", String(input.month)],
      }),
    null,
  );
  const alert = await safely(
    "larm för månadsutkast",
    () =>
      raiseSystemAlert(db, {
        organizationId: input.organizationId,
        kind: "report_failed",
        key,
        severity: "warning",
        title: `Utkasten för ${monthText(String(input.month))} kunde inte skapas`,
        detail: `${count} av utkasten för ${monthText(String(input.month))} kunde inte skapas av det schemalagda jobbet${input.created > 0 ? ` (${input.created} skapades)` : ""}. Fel: ${reason}. Skapa dem under Rapporter.`,
        rule: "Larm när det schemalagda jobbet för månadsutkast misslyckas. Stängs när jobbet lyckas.",
        link: `/rapporter?manad=${encodeURIComponent(String(input.month))}`,
        figures: [
          { key: "failed", label: "Utkast som saknas", value: count },
          { key: "created", label: "Skapade", value: input.created },
        ],
        now: deps.now,
      }),
    null,
  );
  return { alertId: alert?.id ?? null, sentryId, resolved: 0 };
}

// ---------------------------------------------------------------------------
// Schemalagda jobb
// ---------------------------------------------------------------------------

const JOB_LABEL: Record<string, string> = { larm: "Larmjobbet" };

export interface JobOutcomeInput {
  readonly organizationId: string;
  /** Jobbets namn i nyckeln, t.ex. 'larm'. */
  readonly job: string;
  /** Felet, eller null när jobbet lyckades. */
  readonly error: unknown;
}

/** Ett schemalagt jobb för en organisation: larm vid fel, stäng när det lyckas. */
export async function recordJobOutcome(
  deps: MonitoringDeps,
  input: JobOutcomeInput,
): Promise<MonitoringOutcome> {
  const db = dbOf(deps);
  const key = `job:${input.job}`;
  if (input.error === null || input.error === undefined) {
    const resolved = await safely(
      "stänga jobblarm",
      () => resolveSystemAlert(db, input.organizationId, key, deps.now),
      0,
    );
    return { ...NOTHING, resolved };
  }
  const label = JOB_LABEL[input.job] ?? `Jobbet ${input.job}`;
  const reason = errorText(input.error);
  const capture = deps.capture ?? captureToSentry;
  const sentryId = await safely(
    "Sentry (jobb)",
    () =>
      capture({
        error: input.error,
        message: `${label} misslyckades: ${reason}`,
        tags: {
          area: "job",
          kind: "job_failed",
          job: input.job,
          organization_id: input.organizationId,
        },
        fingerprint: ["job_failed", input.job],
      }),
    null,
  );
  const alert = await safely(
    "jobblarm",
    () =>
      raiseSystemAlert(db, {
        organizationId: input.organizationId,
        kind: "job_failed",
        key,
        severity: "critical",
        title: `${label} misslyckades`,
        detail: `Det schemalagda jobbet kunde inte köras för organisationen. Fel: ${reason}. Larm om automater, lager och importer uppdateras inte förrän jobbet lyckas.`,
        rule: "Larm när ett schemalagt jobb misslyckas. Stängs när jobbet lyckas.",
        link: "/drift",
        now: deps.now,
      }),
    null,
  );
  return { alertId: alert?.id ?? null, sentryId, resolved: 0 };
}
