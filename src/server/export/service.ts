/**
 * "Exportera all data" (Inställningar): organisationens egna data som CSV-filer i en ZIP.
 *
 * Säkerhet i tre lager:
 *   1. Rollen: bara ägaren (requireViewerRole mot databasen).
 *   2. start_data_export i databasen: kontrollerar ägaren igen, loggar exporten i
 *      data_exports och tillåter högst 3 exporter per organisation och timme (BL090).
 *   3. All data läses i samma transaktion som användaren, med RLS, och filtreras på
 *      organisationen. En annan organisations rader kan inte komma med.
 *
 * Filerna komprimeras en i taget (bara en tabell okomprimerad i minnet åt gången).
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { Tx } from "@/db/client";
import { BOM, CSV_EOL, csvField } from "@/lib/csv";
import { AuthorizationError, withUserDbFor } from "@/server/access";
import { requireViewerRole, type Viewer } from "@/server/data/core/loaders";

import { EXPORT_TABLES, README_FILE, type ExportTable } from "./tables";
import { zipEntry, zipParts, type ZipEntry } from "./zip";

/** Högst så många exporter per organisation och timme (samma gräns som i databasen). */
export const EXPORTS_PER_HOUR = 3;

export class ExportRateLimitError extends Error {
  constructor() {
    super(`Högst ${EXPORTS_PER_HOUR} exporter per timme. Försök igen senare.`);
    this.name = "ExportRateLimitError";
  }
}

export interface ExportedFile {
  readonly file: string;
  readonly rows: number;
}

export interface DataExport {
  /** data_exports.id */
  readonly id: string;
  readonly fileName: string;
  /** ZIP-filens delar i ordning (strömmas ut av route.ts). */
  readonly parts: Uint8Array[];
  readonly bytes: number;
  readonly files: readonly ExportedFile[];
}

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx, q: SQL): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

function pgCode(error: unknown): string | undefined {
  for (let e: unknown = error, i = 0; e && i < 4; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Kolumnerna som användaren får läsa per tabell, i tabellens ordning (en fråga). */
async function columnsByTable(tx: Tx): Promise<Map<string, Array<{ name: string; type: string }>>> {
  const rows = await query<{ table: string; name: string; type: string }>(
    tx,
    sql`select table_name::text as table, column_name::text as name, data_type::text as type
        from information_schema.columns
        where table_schema = 'public'
          and table_name in (select jsonb_array_elements_text(${JSON.stringify(EXPORT_TABLES.map((t) => t.table))}::jsonb))
        order by table_name, ordinal_position`,
  );
  const map = new Map<string, Array<{ name: string; type: string }>>();
  for (const r of rows) {
    const list = map.get(r.table) ?? [];
    list.push({ name: r.name, type: r.type });
    map.set(r.table, list);
  }
  return map;
}

/** Ett värde som text: tider i UTC (ISO 8601), sant/falskt som true/false, resten som i Postgres. */
function projection(column: { name: string; type: string }): SQL {
  const id = sql.identifier(column.name);
  if (column.type === "boolean") {
    return sql`case when t.${id} then 'true' when not t.${id} then 'false' end as ${id}`;
  }
  if (column.type === "timestamp with time zone") {
    return sql`to_char(t.${id} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ${id}`;
  }
  return sql`t.${id}::text as ${id}`;
}

/** CSV för en tabell (svenskt Excel-format: semikolon, BOM, CRLF). */
export function tableCsv(headers: readonly string[], rows: readonly Row[]): string {
  const lines = [headers.map((h) => csvField(h)).join(";")];
  for (const row of rows) {
    lines.push(
      headers.map((h) => csvField((row[h] as string | null | undefined) ?? null)).join(";"),
    );
  }
  return `${BOM}${lines.join(CSV_EOL)}${CSV_EOL}`;
}

async function readTable(
  tx: Tx,
  organizationId: string,
  spec: ExportTable,
  available: ReadonlyArray<{ name: string; type: string }>,
): Promise<{ headers: string[]; rows: Row[] }> {
  const omit = new Set(spec.omit ?? []);
  const columns = available.filter((c) => !omit.has(c.name));
  if (columns.length === 0) return { headers: [], rows: [] };
  const names = new Set(columns.map((c) => c.name));
  const order = (spec.orderBy ?? ["created_at", "id"]).filter((c) => names.has(c));
  const where =
    spec.table === "organizations"
      ? sql`t.id = ${organizationId}::uuid`
      : sql`t.organization_id = ${organizationId}::uuid`;
  const rows = await query<Row>(
    tx,
    sql`select ${sql.join(columns.map(projection), sql`, `)}
        from ${sql.identifier("public")}.${sql.identifier(spec.table)} t
        where ${where}
        ${
          order.length > 0
            ? sql`order by ${sql.join(
                order.map((c) => sql`t.${sql.identifier(c)}`),
                sql`, `,
              )}`
            : sql``
        }`,
  );
  return { headers: columns.map((c) => c.name), rows };
}

function readme(args: {
  organizationName: string;
  at: Date;
  files: readonly ExportedFile[];
}): string {
  const lines = [
    "Binderlab: export av all data",
    "",
    `Organisation: ${args.organizationName}`,
    `Exporterad: ${args.at.toISOString()} (UTC)`,
    "",
    "Format",
    "- En CSV-fil per tabell: UTF-8 med BOM, semikolon, en rubrikrad (kolumnernas namn).",
    "- Belopp i öre (kolumner som slutar på _ore): 7900 = 79,00 kr.",
    "- Procent i baspunkter (_bp): 2500 = 25 %.",
    "- Tider i UTC (ISO 8601, slutar på Z). Datum (YYYY-MM-DD) är affärsdagar i organisationens tidszon.",
    "- Id:n (uuid) kopplar ihop filerna, t.ex. orders.machine_id = machines.id.",
    "- Text som börjar med = + - @ har fått ett ' först (skydd mot formler i Excel).",
    "- Inloggningar till automatplattformar (Vault) och användarnas lösenord tas inte med.",
    "",
    "Filer",
    ...args.files.map((f) => {
      const spec = EXPORT_TABLES.find((t) => t.file === f.file);
      return `- ${f.file} (${f.rows} rader): ${spec?.description ?? ""}`;
    }),
    "",
  ];
  return lines.join(CSV_EOL);
}

function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s === "" ? "organisation" : s;
}

/** Filnamnet: binderlab-export-<organisation>-<YYYY-MM-DD>.zip (datum i organisationens tidszon). */
export function exportFileName(organizationName: string, at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return `binderlab-export-${slug(organizationName)}-${day}.zip`;
}

/**
 * Exporterar organisationens data. Kastar AuthorizationError (inte ägaren) och
 * ExportRateLimitError (fler än 3 exporter den senaste timmen).
 */
export async function exportOrganizationDataFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<DataExport> {
  await requireViewerRole(viewer, ["owner"]);
  const organizationId = viewer.organization.id;

  return withUserDbFor(viewer.user, async (tx) => {
    let id: string;
    try {
      const [row] = await query<{ id: string }>(
        tx,
        sql`select public.start_data_export(${organizationId}::uuid) as id`,
      );
      if (!row) throw new Error("Exporten kunde inte startas.");
      id = row.id;
    } catch (error) {
      const code = pgCode(error);
      if (code === "BL090") throw new ExportRateLimitError();
      if (code === "42501") throw new AuthorizationError("forbidden");
      throw error;
    }

    const entries: ZipEntry[] = [];
    const files: ExportedFile[] = [];
    const columns = await columnsByTable(tx);
    for (const spec of EXPORT_TABLES) {
      const { headers, rows } = await readTable(
        tx,
        organizationId,
        spec,
        columns.get(spec.table) ?? [],
      );
      if (headers.length === 0) continue;
      entries.push(zipEntry(spec.file, tableCsv(headers, rows)));
      files.push({ file: spec.file, rows: rows.length });
    }
    entries.unshift(
      zipEntry(
        README_FILE,
        `${BOM}${readme({ organizationName: viewer.organization.name, at: now, files })}`,
      ),
    );
    const parts = zipParts(entries, now);
    return {
      id,
      fileName: exportFileName(viewer.organization.name, now, viewer.organization.timezone),
      parts,
      bytes: parts.reduce((n, p) => n + p.length, 0),
      files,
    };
  });
}

/** De senaste exporterna (ägaren): när och av vem. */
export async function listDataExportsFor(
  viewer: Viewer,
  limit = 5,
): Promise<Array<{ id: string; createdAt: string; createdBy: string | null }>> {
  await requireViewerRole(viewer, ["owner"]);
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await query<{ id: string; created_at: Date | string; name: string | null }>(
      tx,
      sql`select e.id, e.created_at, nullif(trim(p.display_name), '') as name
          from public.data_exports e
          left join public.profiles p
            on p.organization_id = e.organization_id and p.user_id = e.created_by
          where e.organization_id = ${viewer.organization.id}::uuid
          order by e.created_at desc
          limit ${limit}`,
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      createdBy: r.name,
    }));
  });
}
