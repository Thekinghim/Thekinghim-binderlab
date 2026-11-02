/**
 * Oberoende granskning av butiksportalen (fas 10): attacktester.
 *
 * Ett utkast till butiksrapport (reports utan rad i report_approvals) är inte
 * godkänt av ägare/admin och får inte nå butiken förrän det godkänts
 * (20261102104410_rapporter_report_approvals.sql: "Innan den får skickas måste en
 * ägare eller admin godkänna just den versionen"). portal_reports, portal_report
 * och storage-policyn binderlab_reports_select_store kontrollerar inte
 * godkännandet, så butiken ser utkast (och varje omgjord version) innan
 * operatören godkänt dem.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { asPostgres, asUser, attempt, one, rows } from "./helpers";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

let f: PortalFixture;
let draftId: string;
let draftPath: string;

beforeAll(async () => {
  f = await seedPortalFixture();
  draftPath = `${f.a.orgId}/reports/utkast-2025-04.pdf`;
  draftId = await asPostgres(async (tx) => {
    const snapshot = {
      type: "butik",
      report: { kind: "store", store: { id: f.a.storeId, name: "ICA Testbutik" } },
    };
    const r = await one<{ id: string }>(
      tx,
      sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                      storage_path, data_snapshot, calc_version)
          values (${f.a.orgId}, 'store_statement', '2025-04-01', '2025-04-30', ${f.a.storeId},
                  ${draftPath}, ${JSON.stringify(snapshot)}::jsonb, 'calc@1')
          returning id`,
    );
    await tx.execute(
      sql`insert into storage.objects (bucket_id, name) values ('reports', ${draftPath})`,
    );
    return r.id;
  });
});

describe("utkast till butiksrapport (inte godkänt)", () => {
  it("syns inte i portal_reports", async () => {
    const list = await asUser(f.storeA1, (tx) =>
      rows<{ report_id: string }>(
        tx,
        sql`select report_id from public.portal_reports(${f.a.storeId}::uuid)`,
      ),
    );
    expect(list.map((r) => r.report_id)).not.toContain(draftId);
  });

  it("portal_report ger samma fel som för en rapport som inte finns", async () => {
    const outcome = await asUser(f.storeA1, (tx) =>
      attempt(tx, (sp) =>
        rows(sp, sql`select * from public.portal_report(${f.a.storeId}::uuid, ${draftId}::uuid)`),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("P0002");
  });

  it("PDF:en i lagringen går inte att läsa", async () => {
    const seen = await asUser(f.storeA1, (tx) =>
      rows<{ name: string }>(
        tx,
        sql`select name from storage.objects where bucket_id = 'reports' and name = ${draftPath}`,
      ),
    );
    expect(seen).toEqual([]);
  });

  it("syns när en ägare godkänt den", async () => {
    await asUser(f.a.owner, (tx) =>
      tx.execute(
        sql`insert into public.report_approvals (organization_id, report_id, approved_by)
            values (${f.a.orgId}, ${draftId}, ${f.a.owner.id})`,
      ),
    );
    const list = await asUser(f.storeA1, (tx) =>
      rows<{ report_id: string }>(
        tx,
        sql`select report_id from public.portal_reports(${f.a.storeId}::uuid)`,
      ),
    );
    expect(list.map((r) => r.report_id)).toContain(draftId);
  });
});
