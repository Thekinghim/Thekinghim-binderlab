/**
 * Behörighet: bara ägare och admin får importera (även förhandsvisa).
 * Läsare, påfyllare och utomstående nekas av appen, och databasen (RLS)
 * nekar samma skrivningar om appens kontroll skulle kringgås.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { awishCsvAdapter } from "../../src/import/adapters/awish-csv";
import {
  ImportForbiddenError,
  ImportNotFoundError,
  ImportValidationError,
} from "../../src/import/errors";
import { classify, commitClassification } from "../../src/import/pipeline";
import { runImport } from "../../src/import/run-import";
import { asUser, attempt, createMember, createUser, db, one } from "./helpers";
import { countIn, fixture, setupImportOrg } from "./import-fixtures";

describe("vem får importera", () => {
  it.each(["viewer", "refiller"] as const)(
    "%s nekas, både förhandsvisning och import",
    async (role) => {
      const f = await setupImportOrg();
      const user = await createMember(f.orgId, role);
      for (const dryRun of [true, false]) {
        await expect(
          f.run(fixture("orderlista-2026-11-02.csv"), { user, dryRun }),
        ).rejects.toBeInstanceOf(ImportForbiddenError);
      }
      for (const table of ["orders", "imports", "import_rows", "titles", "source_machines"]) {
        expect(await countIn(table, f.orgId)).toBe(0);
      }
    },
  );

  it("en ägare i en annan organisation nekas", async () => {
    const f = await setupImportOrg();
    const other = await setupImportOrg();
    await expect(
      f.run(fixture("orderlista-2026-11-02.csv"), { user: other.owner }),
    ).rejects.toBeInstanceOf(ImportForbiddenError);
    await expect(
      f.run(fixture("orderlista-2026-11-02.csv"), { user: await createUser(), dryRun: true }),
    ).rejects.toBeInstanceOf(ImportForbiddenError);
    expect(await countIn("orders", f.orgId)).toBe(0);
  });

  it("admin får importera", async () => {
    const f = await setupImportOrg();
    const r = await f.run(fixture("orderlista-2026-11-02.csv"), { user: f.admin });
    expect(r.summary.new).toBe(3);
    const imp = await one<{ created_by: string }>(
      db(),
      sql`select created_by from public.imports where id = ${r.importId}`,
    );
    expect(imp.created_by).toBe(f.admin.id);
  });

  it("datakälla i en annan organisation syns inte", async () => {
    const f = await setupImportOrg();
    const other = await setupImportOrg();
    await expect(
      runImport(db(), {
        organizationId: f.orgId,
        dataSourceId: other.dataSourceId,
        actorUserId: f.owner.id,
        file: { name: "x.csv", content: fixture("orderlista-2026-11-02.csv") },
        dryRun: true,
        fileStore: f.fileStore,
      }),
    ).rejects.toBeInstanceOf(ImportNotFoundError);
  });

  it("en datakälla som inte tar emot filer (awish_grpc) nekas", async () => {
    const f = await setupImportOrg();
    const grpc = await asUser(f.owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`insert into public.data_sources (organization_id, provider, name)
            values (${f.orgId}, 'awish_grpc', 'Awish API') returning id`,
      ),
    );
    await expect(
      runImport(db(), {
        organizationId: f.orgId,
        dataSourceId: grpc.id,
        actorUserId: f.owner.id,
        file: { name: "x.csv", content: fixture("orderlista-2026-11-02.csv") },
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(ImportValidationError);
  });

  it.each(["viewer", "refiller"] as const)(
    "RLS nekar %s även om appens kontroll kringgås",
    async (role) => {
      const f = await setupImportOrg();
      const user = await createMember(f.orgId, role);
      const fetched = await awishCsvAdapter.fetch({
        context: {
          organizationId: f.orgId,
          dataSourceId: f.dataSourceId,
          sourceTimezone: "Asia/Shanghai",
          config: {},
          secretRef: null,
        },
        file: { name: "x.csv", content: fixture("orderlista-2026-11-02.csv") },
      });
      const outcome = await asUser(user, (tx) =>
        attempt(tx, async (sp) => {
          const ctx = {
            organizationId: f.orgId,
            dataSourceId: f.dataSourceId,
            organizationTimezone: "Europe/Stockholm",
          };
          const c = await classify(sp, ctx, fetched);
          const imp = await one<{ id: string }>(
            sp,
            sql`insert into public.imports (organization_id, data_source_id, trigger, parser_version, storage_path)
                values (${f.orgId}, ${f.dataSourceId}, 'upload', 'x', ${`${f.orgId}/x/y.csv`}) returning id`,
          );
          return commitClassification(sp, ctx, imp.id, c);
        }),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("42501");
      expect(await countIn("orders", f.orgId)).toBe(0);
    },
  );
});
