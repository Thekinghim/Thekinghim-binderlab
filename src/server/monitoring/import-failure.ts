/**
 * Misslyckad import → rad i imports (status failed), larm (regeln import_failed i
 * larmjobbet, med ett direkt skrivet larm som reserv) och Sentry-händelse.
 * Se ./failures.ts för principerna (kastar aldrig, systemroll).
 */

import "server-only";

import { sql } from "drizzle-orm";

import { importStoragePath } from "@/import/file-store";
import { evaluateOrganization } from "@/server/alerts/evaluate";

import { dbOf, safely, type MonitoringDeps, type MonitoringOutcome } from "./failures";
import { captureToSentry } from "./sentry";
import { errorText, raiseSystemAlert } from "./system-alerts";

export interface ImportFailureInput {
  readonly organizationId: string;
  readonly dataSourceId: string;
  /** Användaren som importerade (blir created_by på importraden). */
  readonly actorUserId: string | null;
  readonly fileName: string | null;
  /** Filens SHA-256 (krävs: imports.storage_path räknas ur den). */
  readonly sha256: string;
  /** Tolkarens version (imports.parser_version). */
  readonly parserVersion: string;
  readonly error: unknown;
}

export interface ImportFailureOutcome extends MonitoringOutcome {
  /** Raden i imports med status failed. */
  readonly importId: string | null;
}

/**
 * Misslyckad import. Importens egen transaktion har rullats tillbaka, så felet sparas som en
 * egen rad i imports (Datakällor visar "Misslyckades"). storage_path är sökvägen som filen
 * skulle ha sparats under (den kan saknas om det var lagringen som felade). Larmjobbet körs sedan för
 * organisationen, så att regeln import_failed skapar larmet med vanliga aviseringar. Kunde
 * jobbet inte köra (t.ex. en annan körning pågick) skrivs larmet direkt.
 */
export async function recordImportFailure(
  deps: MonitoringDeps,
  input: ImportFailureInput,
): Promise<ImportFailureOutcome> {
  const now = deps.now ?? new Date();
  const db = dbOf(deps);
  const reason = errorText(input.error);
  const capture = deps.capture ?? captureToSentry;

  const sentryId = await safely(
    "Sentry (import)",
    () =>
      capture({
        error: input.error,
        message: `Import misslyckades: ${reason}`,
        tags: {
          area: "import",
          kind: "import_failed",
          organization_id: input.organizationId,
          data_source_id: input.dataSourceId,
        },
        extra: { file_sha256: input.sha256, parser_version: input.parserVersion },
        fingerprint: ["import_failed", input.dataSourceId],
      }),
    null,
  );

  const inserted = await safely(
    "imports-rad för misslyckad import",
    async () => {
      const rows = Array.from(
        await db.execute<{ id: string; created_at: string }>(sql`
          insert into public.imports (
            organization_id, data_source_id, trigger, file_name, file_sha256, storage_path,
            parser_version, status, started_at, finished_at, created_by
          ) values (
            ${input.organizationId}::uuid, ${input.dataSourceId}::uuid, 'upload',
            ${input.fileName ? input.fileName.slice(0, 300) : null}, ${input.sha256},
            ${importStoragePath(input.organizationId, input.dataSourceId, input.sha256)},
            ${input.parserVersion}, 'failed', ${now.toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz, ${input.actorUserId}::uuid
          )
          returning id, created_at::text as created_at`),
      );
      return rows[0] ?? null;
    },
    null,
  );
  const importId = inserted?.id ?? null;

  // Larmjobbet för organisationen: regeln import_failed ser raden ovan (den räknas bara
  // om den skapades före "nu", därför databasens tid om den ligger före appens).
  const createdMs = inserted ? Date.parse(inserted.created_at) : Number.NaN;
  const evaluateAt = new Date(
    Math.max(Number.isFinite(createdMs) ? createdMs : 0, deps.now ? now.getTime() : Date.now()),
  );
  const summary = await safely(
    "larmjobbet efter misslyckad import",
    () => evaluateOrganization(db, input.organizationId, evaluateAt),
    null,
  );
  const key = `import:${input.dataSourceId}`;
  let alertId = await safely(
    "läsa importlarmet",
    async () => {
      const rows = Array.from(
        await db.execute<{ id: string }>(sql`
          select id from public.alerts
          where organization_id = ${input.organizationId}::uuid
            and incident_key = ${key} and status = 'open'
          limit 1`),
      );
      return rows[0]?.id ?? null;
    },
    null,
  );
  if (alertId === null) {
    // Reserv: larmjobbet hoppade över (lås) eller misslyckades.
    alertId = await safely(
      "importlarm (reserv)",
      async () =>
        (
          await raiseSystemAlert(db, {
            organizationId: input.organizationId,
            kind: "import_failed",
            key,
            severity: "critical",
            title: "Import misslyckades",
            detail: `Importen${input.fileName ? ` av ${input.fileName}` : ""} misslyckades. Fel: ${reason}. Inga order sparades; ladda upp filen igen.`,
            rule: "Larm när en import misslyckas.",
            link: importId ? `/datakallor/importer/${encodeURIComponent(importId)}` : "/datakallor",
            now,
          })
        ).id,
      null,
    );
  }
  if (summary && summary.status === "failed") {
    console.error("[monitoring] Larmjobbet misslyckades efter importfel", summary.error);
  }
  return { importId, alertId, sentryId, resolved: 0 };
}
