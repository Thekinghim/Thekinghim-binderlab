/**
 * Gemensam uppställning för importtesterna (test/db/import-*.test.ts).
 * Varje anrop skapar en egen organisation, så testerna påverkar inte varandra.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";

import { LocalFileStore } from "../../src/import/file-store";
import type { MappingOverride } from "../../src/import/mapping";
import { runImport, type RunImportResult } from "../../src/import/run-import";
import {
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

export const HEADER =
  "ID,Date,Name,Order No.,Order Machine,Payment Method,Order Amount,Is Paid,Payment Time,Actions";

const FIXTURES = path.join(__dirname, "..", "fixtures", "awish");

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)));
}

export interface CsvOrder {
  no: string;
  name?: string;
  machine?: string;
  amount?: string;
  paid?: string;
  time: string;
  method?: string;
}

/** En Awish-CSV med rubrikrad (rad 1) och en order per rad (rad 2, 3 ...). */
export function awishCsv(orders: CsvOrder[]): string {
  const q = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const lines = orders.map((o, i) =>
    [
      String(9000 + i),
      o.time,
      q(o.name ?? "Pokémon TCG: Surging Sparks Booster"),
      o.no,
      q(o.machine ?? "BL-001 ICA Lund"),
      o.method ?? "Swish",
      q(o.amount ?? "Amount: 170.00"),
      o.paid ?? "Paid Success",
      o.time,
      "Details",
    ].join(","),
  );
  return `${HEADER}\r\n${lines.join("\r\n")}\r\n`;
}

export interface ImportFixture {
  orgId: string;
  owner: TestUser;
  admin: TestUser;
  dataSourceId: string;
  fileStore: LocalFileStore;
  /** Kör runImport som `user` (standard: ägaren). */
  run(
    file: string | Uint8Array,
    options?: { dryRun?: boolean; user?: TestUser; name?: string; mapping?: MappingOverride },
  ): Promise<RunImportResult>;
}

export async function setupImportOrg(
  options: { sourceTimezone?: string } = {},
): Promise<ImportFixture> {
  const owner = await createUser(`import-owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Import ${uniqueSuffix()}`);
  const admin = await createMember(orgId, "admin");
  const source = await asUser(owner, (tx) =>
    one<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
          values (${orgId}, 'awish_csv', 'Awish orderlista', ${options.sourceTimezone ?? "Asia/Shanghai"})
          returning id`,
    ),
  );
  const fileStore = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-import-")));
  return {
    orgId,
    owner,
    admin,
    dataSourceId: source.id,
    fileStore,
    run(file, opts = {}) {
      const user = opts.user ?? owner;
      return runImport(db(), {
        organizationId: orgId,
        dataSourceId: source.id,
        actorUserId: user.id,
        actorEmail: user.email,
        file: { name: opts.name ?? "orderlista.csv", content: file },
        mapping: opts.mapping,
        dryRun: opts.dryRun ?? false,
        fileStore,
      });
    },
  };
}

/** Skapar en automat och kopplar källans automat (Order Machine) till den. */
export async function mapMachine(
  f: ImportFixture,
  externalId: string,
  code: string,
): Promise<string> {
  return asUser(f.owner, async (tx) => {
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${f.orgId}, ${code}, ${`Automat ${code}`}, '2025-01-01') returning id`,
    );
    await tx.execute(
      sql`insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
          values (${f.orgId}, ${f.dataSourceId}, ${externalId}, ${externalId}, ${machine.id})
          on conflict (organization_id, data_source_id, external_id)
          do update set machine_id = excluded.machine_id`,
    );
    return machine.id;
  });
}

export interface OrderRow extends Record<string, unknown> {
  id: string;
  external_id: string;
  raw_title: string;
  title_id: string | null;
  ordered_at: string;
  business_date: string;
  amount_ore: string;
  machine_id: string | null;
  source_machine_id: string | null;
  import_id: string;
  source_hash: string;
  late_in_closed_period: boolean;
}

export function ordersOf(orgId: string): Promise<OrderRow[]> {
  return rows<OrderRow>(
    db(),
    sql`select id, external_id, raw_title, title_id,
               to_char(ordered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ordered_at,
               business_date::text as business_date, amount_ore::text as amount_ore, machine_id,
               source_machine_id, import_id, source_hash, late_in_closed_period
        from public.orders where organization_id = ${orgId} order by external_id`,
  );
}

export async function countIn(table: string, orgId: string): Promise<number> {
  const r = await one<{ n: number }>(
    db(),
    sql`select count(*)::int as n from ${sql.identifier("public")}.${sql.identifier(table)}
        where organization_id = ${orgId}`,
  );
  return r.n;
}
