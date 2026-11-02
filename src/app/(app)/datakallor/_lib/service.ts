/**
 * Datakällor på servern: laddare och ändringar, bundna till en verifierad
 * användare och organisation (Viewer). Server actions och sidorna anropar dem
 * med sessionens användare; testerna (test/db/datakallor-*.test.ts) direkt.
 *
 * Varje funktion kontrollerar rollen mot databasen först (bara ägare och admin)
 * och läser och skriver sedan som användaren med RLS (withUserDbFor). Importen
 * går genom runImport, som själv kör som användaren med RLS och kontrollerar
 * rollen en gång till.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db, type Tx } from "@/db/client";
import { parseCsvTable } from "@/import/csv-table";
import { ImportValidationError, MappingError } from "@/import/errors";
import type { FileStore } from "@/import/file-store";
import { sha256Hex } from "@/import/hash";
import {
  autoMap,
  countKnownHeaders,
  IMPORT_FIELDS,
  type ImportField,
  type MappingOverride,
} from "@/import/mapping";
import { notPaidOf, runImport } from "@/import/run-import";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { loadMasterDataFor, type Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";

import type { ImportRowFilter } from "./constants";
import { toPreviewResult } from "./preview";
import type { UploadStaging } from "./staging";
import { suggestMachine } from "./suggest";
import type {
  DatakallorData,
  ImportDetail,
  ImportDetailRow,
  ImportLogEntry,
  ImportStatus,
  ImportTrigger,
  MachineOption,
  MappingNeeded,
  PreviewOutcome,
  PreviewResult,
  ProviderKey,
  QueueEntry,
  SourceStatus,
  SourceView,
} from "./types";

export type { Viewer };

/** Så många importer visas i loggen. */
export const IMPORT_LOG_LIMIT = 200;
/** Så många rader visas per import och filter i radloggen. */
export const IMPORT_ROWS_LIMIT = 1000;

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Kräver ägare eller admin (läst ur databasen) och kör fn som användaren med RLS. */
async function asOperator<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  return withUserDbFor(viewer.user, fn);
}

// ---------------------------------------------------------------------------
// Läsning
// ---------------------------------------------------------------------------

const IMPORT_COLUMNS = sql`
  i.id, i.data_source_id, ds.name as data_source_name, i.trigger::text as trigger, i.file_name,
  i.status::text as status, i.started_at, i.finished_at, i.created_at,
  p.display_name as created_by, i.rows_total, i.rows_new, i.rows_duplicate, i.rows_conflict,
  i.rows_error`;

function importEntry(r: Row): ImportLogEntry {
  const counts = {
    rowsTotal: int(r.rows_total),
    rowsNew: int(r.rows_new),
    rowsDuplicate: int(r.rows_duplicate),
    rowsConflict: int(r.rows_conflict),
    rowsError: int(r.rows_error),
  };
  return {
    id: String(r.id),
    dataSourceId: String(r.data_source_id),
    dataSourceName: String(r.data_source_name ?? ""),
    trigger: String(r.trigger) as ImportTrigger,
    fileName: r.file_name === null || r.file_name === undefined ? null : String(r.file_name),
    status: String(r.status) as ImportStatus,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    createdBy: typeof r.created_by === "string" ? r.created_by : null,
    ...counts,
    rowsNotPaid: Math.max(0, notPaidOf(counts)),
  };
}

function savedMappingOf(config: unknown): SourceView["savedMapping"] {
  if (!isRecord(config) || !isRecord(config.csvMapping)) return null;
  const columns = config.csvMapping.columns;
  if (!isRecord(columns)) return null;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(columns)) {
    if (typeof v === "string" || v === null) out[k] = v;
  }
  return out as SourceView["savedMapping"];
}

/** Allt som sidan Datakällor visar. Bara ägare och admin. */
export async function loadDatakallorFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<DatakallorData> {
  const orgId = viewer.organization.id;
  const master = await loadMasterDataFor(viewer, now);
  return asOperator(viewer, async (tx) => {
    const [sources, imports, queue] = await Promise.all([
      query(
        tx,
        sql`select ds.id, ds.name, ds.provider::text as provider, ds.source_timezone,
                   ds.status::text as status, ds.last_synced_at, ds.archived_at, ds.config,
                   (select count(*) from public.orders o
                     where o.organization_id = ds.organization_id and o.data_source_id = ds.id)::int as orders,
                   (select count(*) from public.source_machines sm
                     where sm.organization_id = ds.organization_id and sm.data_source_id = ds.id
                       and sm.machine_id is null)::int as unmapped
            from public.data_sources ds
            where ds.organization_id = ${orgId}::uuid
            order by ds.archived_at nulls first, ds.created_at`,
      ),
      query(
        tx,
        sql`select ${IMPORT_COLUMNS}
            from public.imports i
            join public.data_sources ds on ds.organization_id = i.organization_id and ds.id = i.data_source_id
            left join public.profiles p on p.organization_id = i.organization_id and p.user_id = i.created_by
            where i.organization_id = ${orgId}::uuid
            order by i.created_at desc
            limit ${IMPORT_LOG_LIMIT}`,
      ),
      query(
        tx,
        sql`select sm.id, sm.data_source_id, ds.name as data_source_name, sm.external_id,
                   sm.external_name, count(o.id)::int as pending_orders,
                   min(o.ordered_at) as first_order_at, max(o.ordered_at) as last_order_at
            from public.source_machines sm
            join public.data_sources ds on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
            left join public.orders o
              on o.organization_id = sm.organization_id and o.source_machine_id = sm.id
             and o.machine_id is null
            where sm.organization_id = ${orgId}::uuid and sm.machine_id is null
            group by sm.id, ds.name
            order by count(o.id) desc, sm.external_name`,
      ),
    ]);

    const entries = imports.map(importEntry);
    const lastBySource = new Map<string, ImportLogEntry>();
    for (const e of entries) {
      if (!lastBySource.has(e.dataSourceId)) lastBySource.set(e.dataSourceId, e);
    }

    const storeName = new Map(master.stores.map((s) => [s.id, s.name]));
    const machines: MachineOption[] = master.machines
      .filter((m) => !m.archived)
      .map((m) => ({
        id: m.id,
        code: m.code,
        name: m.name,
        storeName: m.storeId ? (storeName.get(m.storeId) ?? null) : null,
      }))
      .sort((a, b) => a.code.localeCompare(b.code, "sv-SE", { numeric: true }));

    return {
      timeZone: viewer.organization.timezone,
      now: now.toISOString(),
      sources: sources.map(
        (r): SourceView => ({
          id: String(r.id),
          name: String(r.name),
          provider: String(r.provider) as ProviderKey,
          sourceTimezone: String(r.source_timezone),
          status: String(r.status) as SourceStatus,
          lastSyncedAt: iso(r.last_synced_at),
          archived: r.archived_at !== null && r.archived_at !== undefined,
          acceptsFiles: r.provider === "awish_csv",
          orders: int(r.orders),
          unmapped: int(r.unmapped),
          lastImport: lastBySource.get(String(r.id)) ?? null,
          savedMapping: savedMappingOf(r.config),
        }),
      ),
      imports: entries,
      queue: queue.map(
        (r): QueueEntry => ({
          id: String(r.id),
          dataSourceId: String(r.data_source_id),
          dataSourceName: String(r.data_source_name ?? ""),
          externalId: String(r.external_id),
          externalName:
            r.external_name === null || r.external_name === undefined
              ? null
              : String(r.external_name),
          pendingOrders: int(r.pending_orders),
          firstOrderAt: iso(r.first_order_at),
          lastOrderAt: iso(r.last_order_at),
          suggestedMachineId: suggestMachine(
            typeof r.external_name === "string" ? r.external_name : String(r.external_id),
            machines,
          ),
        }),
      ),
      machines,
    };
  });
}

/** Fälten i radloggen, tagna ur källraden med importens mappning. */
function detailRow(r: Row, columns: Partial<Record<string, string | null>> | null): ImportDetailRow {
  const raw: Record<string, string> = {};
  if (isRecord(r.raw)) {
    for (const [k, v] of Object.entries(r.raw)) raw[k] = v === null ? "" : String(v);
  }
  const pick = (field: string, fallbacks: readonly string[]): string | null => {
    const header = columns?.[field];
    if (header && header in raw) return raw[header] ?? null;
    for (const f of fallbacks) if (f in raw) return raw[f] ?? null;
    return null;
  };
  return {
    rowNumber: int(r.row_number),
    status: String(r.status) as ImportDetailRow["status"],
    message: typeof r.message === "string" ? r.message : null,
    orderId: typeof r.order_id === "string" ? r.order_id : null,
    externalId: pick("externalId", ["Order No."]),
    title: pick("title", ["Name"]),
    machine: pick("machine", ["Order Machine"]),
    amount: pick("amount", ["Order Amount"]),
    paidAt: pick("paidAt", ["Payment Time"]),
    orderedAt: iso(r.ordered_at),
    raw,
  };
}

/** En import med radlogg (fel, konflikter eller nya). null om den inte finns. */
export async function loadImportDetailFor(
  viewer: Viewer,
  importId: string,
  filter: ImportRowFilter,
): Promise<ImportDetail | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importId)) {
    return null;
  }
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const [head] = await query(
      tx,
      sql`select ${IMPORT_COLUMNS}, i.parser_version, i.file_sha256, i.mapping, ds.source_timezone
          from public.imports i
          join public.data_sources ds on ds.organization_id = i.organization_id and ds.id = i.data_source_id
          left join public.profiles p on p.organization_id = i.organization_id and p.user_id = i.created_by
          where i.organization_id = ${orgId}::uuid and i.id = ${importId}::uuid`,
    );
    if (!head) return null;

    const statuses =
      filter === "fel"
        ? ["error"]
        : filter === "konflikter"
          ? ["conflict"]
          : filter === "nya"
            ? ["new"]
            : ["error", "conflict"];
    const [counts, rows] = await Promise.all([
      query(
        tx,
        sql`select status::text as status, count(*)::int as n from public.import_rows
            where organization_id = ${orgId}::uuid and import_id = ${importId}::uuid
            group by status`,
      ),
      query(
        tx,
        sql`select r.row_number, r.status::text as status, r.message, r.order_id, r.raw,
                   o.ordered_at
            from public.import_rows r
            left join public.orders o on o.organization_id = r.organization_id and o.id = r.order_id
            where r.organization_id = ${orgId}::uuid and r.import_id = ${importId}::uuid
              and r.status::text in (select jsonb_array_elements_text(${JSON.stringify(statuses)}::jsonb))
            order by r.row_number
            limit ${IMPORT_ROWS_LIMIT + 1}`,
      ),
    ]);
    const count = (s: string) => int(counts.find((c) => c.status === s)?.n);
    const mapping = isRecord(head.mapping) && isRecord(head.mapping.columns)
      ? (head.mapping.columns as Partial<Record<string, string | null>>)
      : null;
    return {
      entry: importEntry(head),
      sourceTimezone: String(head.source_timezone),
      parserVersion: String(head.parser_version ?? ""),
      sha256: typeof head.file_sha256 === "string" ? head.file_sha256 : null,
      mapping: mapping as ImportDetail["mapping"],
      counts: { new: count("new"), conflict: count("conflict"), error: count("error") },
      rows: rows.slice(0, IMPORT_ROWS_LIMIT).map((r) => detailRow(r, mapping)),
      truncated: rows.length > IMPORT_ROWS_LIMIT,
    };
  });
}

// ---------------------------------------------------------------------------
// Datakällor
// ---------------------------------------------------------------------------

/** Ny CSV-datakälla (Awish orderlista). Returnerar id. */
export async function createDataSourceFor(
  viewer: Viewer,
  input: { name: string; sourceTimezone: string },
): Promise<string> {
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const [row] = await query<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
          values (${orgId}::uuid, 'awish_csv', ${input.name}, ${input.sourceTimezone})
          returning id`,
    );
    if (!row) throw new Error("Datakällan kunde inte skapas.");
    return row.id;
  });
}

/** Byter namn eller källans tidszon. Loggas i audit_log (trigger). */
export async function updateDataSourceFor(
  viewer: Viewer,
  input: { id: string; name?: string; sourceTimezone?: string },
): Promise<void> {
  const orgId = viewer.organization.id;
  await asOperator(viewer, async (tx) => {
    const updated = await query(
      tx,
      sql`update public.data_sources
          set name = coalesce(${input.name ?? null}, name),
              source_timezone = coalesce(${input.sourceTimezone ?? null}, source_timezone)
          where organization_id = ${orgId}::uuid and id = ${input.id}::uuid
            and archived_at is null
          returning id`,
    );
    if (updated.length === 0) {
      throw new ImportValidationError("Datakällan finns inte.");
    }
  });
}

// ---------------------------------------------------------------------------
// Kön för okända automater
// ---------------------------------------------------------------------------

/**
 * Kopplar en källautomat (Order Machine) till en av våra automater. Dess order får
 * automaten (trigger i databasen) och därmed sina lagerhändelser. En redan kopplad
 * källautomat kopplas inte om. Returnerar antalet order som fick automaten.
 */
export async function mapSourceMachineFor(
  viewer: Viewer,
  input: { sourceMachineId: string; machineId: string },
): Promise<{ orders: number; externalName: string | null; machineCode: string }> {
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const [machine] = await query<{ code: string }>(
      tx,
      sql`select code from public.machines
          where organization_id = ${orgId}::uuid and id = ${input.machineId}::uuid
            and archived_at is null`,
    );
    if (!machine) throw new ImportValidationError("Automaten finns inte.");
    const [pending] = await query<{ n: number }>(
      tx,
      sql`select count(*)::int as n from public.orders
          where organization_id = ${orgId}::uuid and source_machine_id = ${input.sourceMachineId}::uuid
            and machine_id is null`,
    );
    const [updated] = await query<{ external_name: string | null }>(
      tx,
      sql`update public.source_machines set machine_id = ${input.machineId}::uuid
          where organization_id = ${orgId}::uuid and id = ${input.sourceMachineId}::uuid
            and machine_id is null
          returning external_name`,
    );
    if (!updated) {
      throw new ImportValidationError("Källautomaten finns inte eller är redan kopplad.");
    }
    return {
      orders: int(pending?.n),
      externalName: updated.external_name,
      machineCode: machine.code,
    };
  });
}

// ---------------------------------------------------------------------------
// Uppladdning, förhandsvisning och import
// ---------------------------------------------------------------------------

export interface UploadDeps {
  readonly staging: UploadStaging;
  /** Var den importerade filen sparas (standard i runImport: LocalFileStore). */
  readonly fileStore?: FileStore;
  /** Anslutningen runImport använder; den kör ändå som användaren med RLS. */
  readonly db?: Db;
}

function owner(viewer: Viewer) {
  return { organizationId: viewer.organization.id, userId: viewer.user.userId };
}

export async function startUploadFor(
  viewer: Viewer,
  deps: UploadDeps,
  file: { fileName: string; size: number },
): Promise<{ uploadId: string }> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const meta = await deps.staging.start(owner(viewer), file);
  return { uploadId: meta.uploadId };
}

export async function appendChunkFor(
  viewer: Viewer,
  deps: UploadDeps,
  input: { uploadId: string; index: number; bytes: Uint8Array },
): Promise<{ received: number; size: number }> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const meta = await deps.staging.append(owner(viewer), input.uploadId, input.index, input.bytes);
  return { received: meta.received, size: meta.size };
}

export async function discardUploadFor(
  viewer: Viewer,
  deps: UploadDeps,
  uploadId: string,
): Promise<void> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  await deps.staging.discard(owner(viewer), uploadId);
}

/**
 * Rubrikerna i filen och den automatiska mappningen, för att användaren ska kunna
 * välja kolumnerna själv när filen saknar något obligatoriskt fält.
 */
export function mappingNeededOf(
  uploadId: string,
  fileName: string,
  content: Uint8Array,
  error: MappingError,
  override?: MappingOverride,
): MappingNeeded {
  const table = parseCsvTable(content, { delimiter: override?.delimiter });
  const candidates = table.records.slice(0, 10);
  const header =
    candidates.find((r) => countKnownHeaders(r.cells.map((c) => c.trim())) >= 2) ?? candidates[0];
  const seen = new Map<string, number>();
  const headers = (header?.cells ?? []).map((cell, index) => {
    const base = cell.trim() === "" ? `Kolumn ${index + 1}` : cell.trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const columns = autoMap(headers);
  const source = Object.fromEntries(
    IMPORT_FIELDS.map((f) => [f, columns[f] === null ? "none" : "auto"]),
  ) as Record<ImportField, "auto" | "saved" | "override" | "none">;
  for (const field of IMPORT_FIELDS) {
    const wanted = override?.columns?.[field];
    if (wanted === undefined) continue;
    if (wanted === null || headers.includes(wanted)) {
      columns[field] = wanted;
      source[field] = wanted === null ? "none" : "override";
    }
  }
  return {
    uploadId,
    fileName,
    message: error.message,
    missing: error.missing.filter((m): m is ImportField =>
      (IMPORT_FIELDS as readonly string[]).includes(m),
    ),
    mapping: {
      headers,
      columns,
      source,
      delimiter: table.delimiter,
      encoding: table.encoding,
    },
  };
}

/** Förhandsvisning. Saknas obligatoriska kolumner får användaren välja dem. */
export async function previewUploadFor(
  viewer: Viewer,
  deps: UploadDeps,
  input: { uploadId: string; dataSourceId: string; mapping?: MappingOverride },
): Promise<PreviewOutcome> {
  try {
    return { kind: "preview", result: await runUploadFor(viewer, deps, { ...input, dryRun: true }) };
  } catch (error) {
    if (!(error instanceof MappingError)) throw error;
    const { meta, content } = await deps.staging.read(owner(viewer), input.uploadId);
    return {
      kind: "mapping",
      needed: mappingNeededOf(input.uploadId, meta.fileName, content, error, input.mapping),
    };
  }
}

/**
 * Förhandsvisning (dryRun) eller import av en uppladdad fil. Vid import kontrolleras
 * att filen är samma som förhandsvisades (kontrollsumman), och uppladdningen tas bort
 * efteråt.
 */
export async function runUploadFor(
  viewer: Viewer,
  deps: UploadDeps,
  input: {
    uploadId: string;
    dataSourceId: string;
    mapping?: MappingOverride;
    dryRun: boolean;
    expectedSha256?: string;
    saveMapping?: boolean;
  },
): Promise<PreviewResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const { meta, content } = await deps.staging.read(owner(viewer), input.uploadId);
  if (!input.dryRun && input.expectedSha256 && sha256Hex(content) !== input.expectedSha256) {
    // Uppladdningen ändras inte efter att den är klar, men importen ska aldrig
    // gälla en annan fil än den som förhandsvisades.
    throw new ImportValidationError("Filen har ändrats sedan förhandsvisningen. Välj filen igen.");
  }
  const result = await runImport(deps.db ?? getServiceDb(), {
    organizationId: viewer.organization.id,
    dataSourceId: input.dataSourceId,
    actorUserId: viewer.user.userId,
    actorEmail: viewer.user.email,
    file: { name: meta.fileName, content },
    mapping: input.mapping,
    dryRun: input.dryRun,
    fileStore: deps.fileStore,
    saveMapping: input.saveMapping,
    // Alla rader: urvalet för webbläsaren görs i toPreviewResult.
    rowLimit: Number.MAX_SAFE_INTEGER,
  });
  if (!input.dryRun) {
    await deps.staging.discard(owner(viewer), input.uploadId);
  }
  return toPreviewResult(input.uploadId, result);
}
