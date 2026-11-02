/**
 * Import av en uppladdad fil från en datakälla: förhandsvisning (dryRun) eller
 * import. Körs som användaren med RLS (bara ägare och admin får importera).
 *
 * Förhandsvisningen skriver ingenting: den visar tolkade rader med svensk tid,
 * klassningen (new, duplicate, conflict, error, not_paid), okända automater
 * och titlar, och en varning om samma fil redan har importerats.
 *
 * Importen tar ett advisory lock per datakälla (två importer mot samma källa
 * körs efter varandra), sparar filen via FileStore, skapar imports-raden och
 * skriver allt i samma transaktion. Går något fel rullas allt tillbaka.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";

import type { AdapterContext, DataSourceProvider, FetchResult } from "./adapter";
import { awishCsvAdapter } from "./adapters/awish-csv";
import { ImportForbiddenError, ImportNotFoundError, ImportValidationError } from "./errors";
import { importStoragePath, LocalFileStore, type FileStore } from "./file-store";
import { sha256Hex } from "./hash";
import type { MappingOverride } from "./mapping";
import {
  classify,
  commitClassification,
  type ImportRowResult,
  type ImportSummary,
  type NewTitle,
  type UnknownMachine,
} from "./pipeline";
import { businessDateOf, formatInZone } from "./zoned";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunImportOptions {
  organizationId: string;
  dataSourceId: string;
  /** Den inloggade användaren (auth.users.id). Importen körs med hens RLS. */
  actorUserId: string;
  actorEmail?: string;
  file: { name: string; content: string | Uint8Array };
  /** Överstyrning av kolumnmappningen (annars automatisk/sparad). */
  mapping?: MappingOverride;
  /** true = förhandsvisning utan att skriva något. */
  dryRun: boolean;
  /** Var filen sparas. Standard: LocalFileStore (.data/imports). */
  fileStore?: FileStore;
  /** Spara en överstyrd mappning på datakällan för nästa fil (standard: ja). */
  saveMapping?: boolean;
  /** Hur många rader som returneras i `rows` (standard 500). Summeringen gäller alltid alla. */
  rowLimit?: number;
}

export type ImportWarningCode =
  | "duplicate_file"
  | "ambiguous_time"
  | "nonexistent_time"
  | "late_in_closed_period"
  | "conflicts"
  | "errors"
  | "new_titles"
  | "unknown_machines";

export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
  /** Radnummer i filen som varningen gäller (högst 50). */
  rows?: number[];
}

/** Kontroll av källans tidszon: första betalda raden i källans och i svensk tid. */
export interface FirstRowCheck {
  rowNumber: number;
  externalId: string;
  sourceTimezone: string;
  sourceLocal: string;
  utc: string;
  organizationTimezone: string;
  organizationLocal: string;
  businessDate: string;
}

export interface PreviousImport {
  id: string;
  fileName: string | null;
  finishedAt: string | null;
  rowsNew: number;
}

export interface RunImportResult {
  dryRun: boolean;
  /** imports.id (null vid förhandsvisning). */
  importId: string | null;
  dataSource: { id: string; name: string; provider: DataSourceProvider; sourceTimezone: string };
  organizationTimezone: string;
  file: { name: string; sha256: string; bytes: number; storagePath: string | null };
  parserVersion: string;
  mapping: object | null;
  summary: ImportSummary;
  rows: ImportRowResult[];
  rowsTruncated: boolean;
  newTitles: NewTitle[];
  unknownMachines: UnknownMachine[];
  firstRow: FirstRowCheck | null;
  warnings: ImportWarning[];
  previousImports: PreviousImport[];
  startedAt: string | null;
  finishedAt: string | null;
}

/** Version av hela importflödet; sparas med tolkarens version i imports.parser_version. */
export const IMPORT_PIPELINE_VERSION = "pipeline/1";

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

/**
 * Som withRls i src/db/client.ts, men på den anslutning som skickas in:
 * transaktion med `set local role authenticated` och JWT-claims.
 */
async function asUser<T>(
  db: Db,
  claims: { sub: string; email?: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const jwt = JSON.stringify({
    sub: claims.sub,
    email: claims.email,
    role: "authenticated",
    aud: "authenticated",
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${jwt}, true)`);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/** Adaptern för filuppladdning per typ av datakälla. */
async function fetchFromFile(
  provider: DataSourceProvider,
  context: AdapterContext,
  options: RunImportOptions,
): Promise<FetchResult> {
  switch (provider) {
    case "awish_csv":
      return awishCsvAdapter.fetch({ context, file: options.file, mapping: options.mapping });
    default:
      throw new ImportValidationError(
        `Datakällan (${provider}) tar inte emot filer. Välj en CSV-datakälla.`,
      );
  }
}

function buildWarnings(
  rows: ImportRowResult[],
  summary: ImportSummary,
  previous: PreviousImport[],
  newTitles: NewTitle[],
  unknownMachines: UnknownMachine[],
): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  const rowsWhere = (pred: (r: ImportRowResult) => boolean): number[] =>
    rows
      .filter(pred)
      .slice(0, 50)
      .map((r) => r.rowNumber);

  if (previous.length > 0) {
    const first = previous[0];
    warnings.push({
      code: "duplicate_file",
      message:
        `Samma fil har redan importerats${first?.finishedAt ? ` (${first.finishedAt.slice(0, 10)})` : ""}. ` +
        "Order som redan finns räknas som dubbletter och ändras inte.",
    });
  }
  const ambiguous = rowsWhere((r) => r.notes.some((n) => n.includes("två gånger")));
  if (ambiguous.length > 0) {
    warnings.push({
      code: "ambiguous_time",
      message:
        "Några tider finns två gånger när sommartiden slutar. Den tidigaste tidpunkten valdes.",
      rows: ambiguous,
    });
  }
  const gap = rowsWhere((r) => r.notes.some((n) => n.includes("finns inte")));
  if (gap.length > 0) {
    warnings.push({
      code: "nonexistent_time",
      message: "Några tider finns inte när sommartiden börjar. De flyttades fram en timme.",
      rows: gap,
    });
  }
  if (summary.lateInClosedPeriod > 0) {
    warnings.push({
      code: "late_in_closed_period",
      message: `${summary.lateInClosedPeriod} nya order hör till en stängd månad. De sparas och syns i nästa rapport.`,
      rows: rowsWhere((r) => r.status === "new" && r.lateInClosedPeriod),
    });
  }
  if (summary.conflict > 0) {
    warnings.push({
      code: "conflicts",
      message: `${summary.conflict} rader avviker från order som redan finns. Orderna ändras inte; se importloggen.`,
      rows: rowsWhere((r) => r.status === "conflict"),
    });
  }
  if (summary.error > 0) {
    warnings.push({
      code: "errors",
      message: `${summary.error} rader kunde inte tolkas och hoppas över.`,
      rows: rowsWhere((r) => r.status === "error"),
    });
  }
  if (newTitles.length > 0) {
    warnings.push({
      code: "new_titles",
      message: `${newTitles.length} nya titlar: ${newTitles
        .slice(0, 5)
        .map((t) => `"${t.name}"`)
        .join(", ")}${newTitles.length > 5 ? " …" : ""}. Kontrollera dem och lägg in inköpspris.`,
    });
  }
  if (unknownMachines.length > 0) {
    warnings.push({
      code: "unknown_machines",
      message: `${unknownMachines.length} automater är inte kopplade: ${unknownMachines
        .slice(0, 5)
        .map((m) => `"${m.name ?? m.externalId}"`)
        .join(
          ", ",
        )}${unknownMachines.length > 5 ? " …" : ""}. Orderna sparas och får automat när den kopplas.`,
    });
  }
  return warnings;
}

/**
 * Förhandsvisning (dryRun: true) eller import (dryRun: false) av en fil.
 *
 * Kastar ImportForbiddenError (inte ägare/admin), ImportNotFoundError
 * (datakällan finns inte för användaren), ImportValidationError (tom fil,
 * fel typ av datakälla, arkiverad källa) och MappingError (kolumner saknas).
 * Rader som inte går att tolka kastar inte: de blir `error` i resultatet och
 * i importloggen.
 */
export async function runImport(db: Db, options: RunImportOptions): Promise<RunImportResult> {
  for (const [label, value] of [
    ["organizationId", options.organizationId],
    ["dataSourceId", options.dataSourceId],
    ["actorUserId", options.actorUserId],
  ] as const) {
    if (!UUID.test(value)) {
      throw new ImportValidationError(`${label} måste vara ett uuid.`);
    }
  }
  const bytes = toBytes(options.file.content);
  if (bytes.byteLength === 0) {
    throw new ImportValidationError("Filen är tom.");
  }
  const sha256 = sha256Hex(bytes);
  const rowLimit = options.rowLimit ?? 500;

  return asUser(db, { sub: options.actorUserId, email: options.actorEmail }, async (tx) => {
    // 1. Behörighet (samma regel som RLS-policyerna för order och importer).
    const [access] = await query<{ ok: boolean }>(
      tx,
      sql`select private.has_role(${options.organizationId}::uuid,
                 'owner'::public.member_role, 'admin'::public.member_role) as ok`,
    );
    if (!access?.ok) {
      throw new ImportForbiddenError();
    }

    // 2. Datakällan och organisationens tidszon.
    const [source] = await query<{
      id: string;
      name: string;
      provider: DataSourceProvider;
      source_timezone: string;
      config: Record<string, unknown> | null;
      secret_ref: string | null;
      archived_at: unknown;
      org_timezone: string;
    }>(
      tx,
      sql`select ds.id, ds.name, ds.provider, ds.source_timezone, ds.config, ds.secret_ref,
                 ds.archived_at, o.timezone as org_timezone
          from public.data_sources ds
          join public.organizations o on o.id = ds.organization_id
          where ds.organization_id = ${options.organizationId}::uuid
            and ds.id = ${options.dataSourceId}::uuid`,
    );
    if (!source) {
      throw new ImportNotFoundError();
    }
    if (source.archived_at !== null && source.archived_at !== undefined) {
      throw new ImportValidationError("Datakällan är arkiverad.");
    }
    const context: AdapterContext = {
      organizationId: options.organizationId,
      dataSourceId: options.dataSourceId,
      sourceTimezone: source.source_timezone,
      config: source.config ?? {},
      secretRef: source.secret_ref,
    };

    // 3. Tolkning (adaptern). Ren beräkning, inget lås behövs.
    const fetched = await fetchFromFile(source.provider, context, options);

    // 4. Lås per datakälla innan något läses som avgör klassningen.
    if (!options.dryRun) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`binderlab:import:${options.dataSourceId}`}, 0))`,
      );
    }
    const startedAtRow = options.dryRun
      ? null
      : (await query<{ t: unknown }>(tx, sql`select clock_timestamp() as t`))[0]?.t;

    const previous = (
      await query<{ id: string; file_name: string | null; finished_at: unknown; rows_new: number }>(
        tx,
        sql`select i.id, i.file_name, i.finished_at, i.rows_new
            from public.imports i
            where i.organization_id = ${options.organizationId}::uuid
              and i.data_source_id = ${options.dataSourceId}::uuid
              and i.file_sha256 = ${sha256}
              and i.status = 'succeeded'
            order by i.finished_at desc nulls last`,
      )
    ).map((r) => ({
      id: r.id,
      fileName: r.file_name,
      finishedAt: isoOrNull(r.finished_at),
      rowsNew: Number(r.rows_new),
    }));

    const ctx = {
      organizationId: options.organizationId,
      dataSourceId: options.dataSourceId,
      organizationTimezone: source.org_timezone,
    };
    const classification = await classify(tx, ctx, fetched);

    const firstPaid = fetched.rows.find((r) => r.isPaid);
    const firstRow: FirstRowCheck | null = firstPaid
      ? {
          rowNumber: firstPaid.sourceRowNumber,
          externalId: firstPaid.externalId,
          sourceTimezone: source.source_timezone,
          sourceLocal: formatInZone(firstPaid.paidAtUtc, source.source_timezone),
          utc: firstPaid.paidAtUtc.toISOString(),
          organizationTimezone: source.org_timezone,
          organizationLocal: formatInZone(firstPaid.paidAtUtc, source.org_timezone),
          businessDate: businessDateOf(firstPaid.paidAtUtc, source.org_timezone),
        }
      : null;

    const base = {
      dataSource: {
        id: source.id,
        name: source.name,
        provider: source.provider,
        sourceTimezone: source.source_timezone,
      },
      organizationTimezone: source.org_timezone,
      parserVersion: fetched.parserVersion,
      mapping: fetched.mapping ?? null,
      firstRow,
      previousImports: previous,
    };

    if (options.dryRun) {
      return {
        ...base,
        dryRun: true,
        importId: null,
        file: { name: options.file.name, sha256, bytes: bytes.byteLength, storagePath: null },
        summary: classification.summary,
        rows: classification.rows.slice(0, rowLimit),
        rowsTruncated: classification.rows.length > rowLimit,
        newTitles: classification.newTitles,
        unknownMachines: classification.unknownMachines,
        warnings: buildWarnings(
          classification.rows,
          classification.summary,
          previous,
          classification.newTitles,
          classification.unknownMachines,
        ),
        startedAt: null,
        finishedAt: null,
      };
    }

    // 5. Filen sparas (underlag). Samma innehåll → samma sökväg, skrivs inte över.
    const store = options.fileStore ?? new LocalFileStore();
    const storagePath = importStoragePath(options.organizationId, options.dataSourceId, sha256);
    await store.put(storagePath, bytes, "text/csv");

    const [created] = await query<{ id: string }>(
      tx,
      sql`insert into public.imports (
            organization_id, data_source_id, trigger, file_name, file_sha256, storage_path,
            parser_version, mapping, status, started_at
          ) values (
            ${options.organizationId}::uuid, ${options.dataSourceId}::uuid, 'upload',
            ${options.file.name.slice(0, 500)}, ${sha256}, ${storagePath},
            ${`${fetched.parserVersion}+${IMPORT_PIPELINE_VERSION}`},
            ${fetched.mapping ? JSON.stringify(fetched.mapping) : null}::jsonb,
            'running', ${isoOrNull(startedAtRow)}::timestamptz
          )
          returning id`,
    );
    if (!created) {
      throw new Error("Importen kunde inte skapas.");
    }

    const outcome = await commitClassification(tx, ctx, created.id, classification);
    const s = outcome.summary;

    const [finished] = await query<{ started_at: unknown; finished_at: unknown }>(
      tx,
      sql`update public.imports
          set rows_total = ${s.total}, rows_new = ${s.new}, rows_duplicate = ${s.duplicate},
              rows_conflict = ${s.conflict}, rows_error = ${s.error},
              status = 'succeeded', finished_at = clock_timestamp()
          where organization_id = ${options.organizationId}::uuid and id = ${created.id}::uuid
          returning started_at, finished_at`,
    );

    // Överstyrd mappning sparas på datakällan och används för nästa fil.
    if (options.mapping?.columns && options.saveMapping !== false) {
      await tx.execute(
        sql`update public.data_sources
            set config = config || jsonb_build_object('csvMapping', ${JSON.stringify(options.mapping)}::jsonb)
            where organization_id = ${options.organizationId}::uuid
              and id = ${options.dataSourceId}::uuid`,
      );
    }
    await tx.execute(
      sql`update public.data_sources set last_synced_at = now()
          where organization_id = ${options.organizationId}::uuid
            and id = ${options.dataSourceId}::uuid`,
    );

    return {
      ...base,
      dryRun: false,
      importId: created.id,
      file: { name: options.file.name, sha256, bytes: bytes.byteLength, storagePath },
      summary: s,
      rows: outcome.rows.slice(0, rowLimit),
      rowsTruncated: outcome.rows.length > rowLimit,
      newTitles: outcome.newTitles,
      unknownMachines: outcome.unknownMachines,
      warnings: buildWarnings(
        outcome.rows,
        s,
        previous,
        outcome.newTitles,
        outcome.unknownMachines,
      ),
      startedAt: isoOrNull(finished?.started_at),
      finishedAt: isoOrNull(finished?.finished_at),
    };
  });
}

/** Antal ej betalda rader för en sparad import (räknas inte rad för rad). */
export function notPaidOf(row: {
  rowsTotal: number;
  rowsNew: number;
  rowsDuplicate: number;
  rowsConflict: number;
  rowsError: number;
}): number {
  return row.rowsTotal - row.rowsNew - row.rowsDuplicate - row.rowsConflict - row.rowsError;
}
