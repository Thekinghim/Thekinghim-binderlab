/**
 * Driftfel → Sentry-händelse (när SENTRY_DSN finns) OCH larm i public.alerts (syns på Drift
 * och i Att göra). En funktion per sorts fel:
 *
 *   recordImportFailure   misslyckad import (./import-failure.ts)
 *   recordReportSend      rapportutskick: larm 'report:<id>' när en mottagare inte fick
 *                         rapporten eller utskicket avbröts; stängs när utskicket av den
 *                         rapporten eller en nyare version av den (samma typ, månad och
 *                         butik) lyckas
 *   recordDraftsOutcome   månadsutkasten (schemalagt): 'report_drafts:<månad>'; stängs när
 *                         jobbet lyckas eller när de saknade utkasten skapats för hand
 *                         (closeDraftsAlertIfComplete i src/server/reports/draft-coverage.ts)
 *   recordJobOutcome      schemalagt jobb (larmjobbet, månadsutkasten): 'job:<namn>'
 *
 * Ett nytt larm aviseras till prenumeranterna (./notify.ts), med samma regler som
 * larmjobbets egna larm.
 *
 * Inget här kastar: övervakningen får aldrig dölja det ursprungliga felet eller stoppa ett
 * jobb. Fel i själva övervakningen skrivs till serverloggen.
 */

import "server-only";

import type { IsoMonth } from "@/domain";
import { getServiceDb, type Db } from "@/db/client";

import { sql } from "drizzle-orm";

import { notifySystemAlert } from "./notify";
import { captureToSentry, type FailureCapture } from "./sentry";
import {
  errorText,
  raiseSystemAlert,
  resolveSystemAlert,
  type SystemAlertInput,
  type SystemAlertResult,
} from "./system-alerts";

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

/** Skapar (eller räknar upp) larmet och aviserar prenumeranterna när det är nytt. */
export async function raiseAndNotify(db: Db, input: SystemAlertInput): Promise<SystemAlertResult> {
  const alert = await raiseSystemAlert(db, input);
  if (alert.created) {
    await safely("avisering av systemlarm", () => notifySystemAlert(db, alert.id, input), 0);
  }
  return alert;
}

/**
 * Stänger rapportlarmen för rapporten och alla versioner av den (samma organisation, typ,
 * period och butik): ett lyckat utskick av en ny version löser den gamlas larm.
 */
async function resolveReportAlerts(
  db: Db,
  organizationId: string,
  reportId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = Array.from(
    await db.execute<{ id: string }>(sql`
      update public.alerts a
      set status = 'closed', closed_at = ${now.toISOString()}::timestamptz
      where a.organization_id = ${organizationId}::uuid
        and a.alert_group = 'system'
        and a.status = 'open'
        and a.incident_key in (
          select 'report:' || v.id::text
          from public.reports r
          join public.reports v
            on v.organization_id = r.organization_id
           and v.kind = r.kind
           and v.period_start = r.period_start
           and v.period_end = r.period_end
           and v.store_id is not distinct from r.store_id
          where r.organization_id = ${organizationId}::uuid and r.id = ${reportId}::uuid
        )
      returning a.id`),
  );
  return rows.length;
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
      () => resolveReportAlerts(db, input.organizationId, input.reportId, deps.now),
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
        // Utan feltexten: samma sorts fel blir ett ärende (texten kan också innehålla adresser).
        fingerprint: ["report_failed", aborted ? "aborted" : "recipient"],
      }),
    null,
  );
  const alert = await safely(
    "rapportlarm",
    () =>
      raiseAndNotify(db, {
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
      raiseAndNotify(db, {
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

/** Utfallet för en organisation i jobbet som skapar och räknar om butikernas avräkningar. */
export interface SettlementRunOutcome {
  readonly organizationId: string;
  readonly errors: readonly { readonly storeId: string; readonly message: string }[];
}

/**
 * Avräkningsjobbet (i /api/cron/rapporter den 1:a och /api/cron/larm varje dygn): en
 * organisation där någon butik inte gick att räkna, eller där hela körningen föll, får
 * larmet 'job:avrakningar'. En körning utan fel stänger det. Förr skrevs felen bara i
 * serverloggen, och ägaren fick veta först när butiken saknade sin avräkning. Kastar inte.
 */
export async function recordSettlementRuns(
  deps: MonitoringDeps,
  runs: readonly SettlementRunOutcome[],
): Promise<{ failed: number }> {
  let failed = 0;
  for (const run of runs) {
    const n = run.errors.length;
    if (n > 0) failed += 1;
    const first = run.errors[0]?.message ?? "";
    // Hela körningen föll (ingen butik angiven) är kritiskt; enskilda butiker en varning.
    const whole = run.errors.some((e) => e.storeId === "");
    await recordJobOutcome(deps, {
      organizationId: run.organizationId,
      job: "avrakningar",
      error:
        n === 0
          ? null
          : new Error(
              whole
                ? first
                : `${n} ${n === 1 ? "butik" : "butiker"} kunde inte räknas. ${errorText(first)}`,
            ),
      severity: whole ? "critical" : "warning",
    });
  }
  return { failed };
}

/** Vad jobbet heter, vad som inte händer när det misslyckas och var det åtgärdas. */
const JOB_INFO: Record<string, { label: string; consequence: string; link: string }> = {
  larm: {
    label: "Larmjobbet",
    consequence: "Larm om automater, lager och importer uppdateras inte förrän jobbet lyckas.",
    link: "/drift",
  },
  rapporter: {
    label: "Jobbet för månadsutkast",
    consequence: "Månadens rapportutkast skapas inte förrän jobbet lyckas.",
    link: "/rapporter",
  },
  kontroll: {
    label: "Den dagliga kontrollen",
    consequence:
      "Siffrorna har inte kontrollerats i dag. Kör kontrollen själv under Inställningar → Kontroll.",
    link: "/installningar/kontroll",
  },
  avrakningar: {
    label: "Jobbet för butikernas avräkningar",
    consequence:
      "Månadens avräkningar har inte skapats eller räknats om. Öppna Butiker → Utbetalning och skapa dem där.",
    link: "/butiker?vy=utbetalning",
  },
  kampanjer: {
    label: "Jobbet som startar kampanjer",
    consequence:
      "En kampanj som skulle ha startat har inte skickats till Awish. Öppna Kampanjer och starta den där.",
    link: "/kampanjer",
  },
};

export interface JobOutcomeInput {
  readonly organizationId: string;
  /** Jobbets namn i nyckeln, t.ex. 'larm'. */
  readonly job: string;
  /** Felet, eller null när jobbet lyckades. */
  readonly error: unknown;
  /** Larmets allvar. Standard: kritiskt (jobbet gick inte alls). */
  readonly severity?: "critical" | "warning";
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
  const info = JOB_INFO[input.job];
  const label = info?.label ?? `Jobbet ${input.job}`;
  // Felet kan sluta med punkt: ingen dubbel punkt i larmets text.
  const reason = errorText(input.error).replace(/[.!\s]+$/, "");
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
      raiseAndNotify(db, {
        organizationId: input.organizationId,
        kind: "job_failed",
        key,
        severity: input.severity ?? "critical",
        title: `${label} misslyckades`,
        detail: `Det schemalagda jobbet kunde inte köras för organisationen. Fel: ${reason}. ${info?.consequence ?? "Det körs igen vid nästa tillfälle."}`,
        rule: "Larm när ett schemalagt jobb misslyckas. Stängs när jobbet lyckas.",
        link: info?.link ?? "/drift",
        now: deps.now,
      }),
    null,
  );
  return { alertId: alert?.id ?? null, sentryId, resolved: 0 };
}
