/**
 * Rapporter: en butiksrapport per butik hos en butiksägare i ett svep
 * (src/app/(app)/rapporter/_lib/owner-reports.ts). Rapporten är den vanliga butiksrapporten
 * (createReportFor), en per butik, med samma månad och hälsning. Bara ägarens aktiva
 * butiker bland de valda; läsaren och påfyllaren får inte; en annan organisation hittar
 * inte ägarens butiker. Fixturen är butiksportalens (A1 och A2 med order i mars 2025).
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createOwnerReportsFor } from "@/app/(app)/rapporter/_lib/owner-reports";
import { listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/reports/service";

import { db, one, rows, type TestUser } from "./helpers";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

let f: PortalFixture;
let ownerId: string;

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

beforeAll(async () => {
  f = await seedPortalFixture();
  const o = await one<{ id: string }>(
    db(),
    sql`insert into public.store_owners (organization_id, legal_name, org_number)
        values (${f.a.orgId}::uuid, 'Godisbolaget Väst AB', '559900-1236') returning id`,
  );
  ownerId = o.id;
  await db().execute(
    sql`update public.stores set owner_id = ${ownerId}::uuid
        where id in (${f.a.storeId}::uuid, ${f.a2.storeId}::uuid)`,
  );
}, 120_000);

describe("en rapport per butik hos ägaren", () => {
  it("skapar ett utkast per butik med samma månad och hälsning", async () => {
    const owner = await viewerFor(f.a.owner, f.a.orgId);
    const result = await createOwnerReportsFor(owner, {
      ownerId,
      month: "2025-03",
      period: null,
      greeting: "Tack för i månaden!",
    });
    expect(result.skipped).toEqual([]);
    expect(result.created.map((c) => c.storeName).sort()).toEqual([
      "Coop Andra butiken",
      "ICA Testbutik",
    ]);
    const created = await rows<{ store_id: string; kind: string; period_start: string }>(
      db(),
      sql`select store_id, kind::text as kind, period_start::text as period_start
          from public.reports
          where id in (${sql.join(
            result.created.map((c) => sql`${c.reportId}::uuid`),
            sql`, `,
          )})`,
    );
    expect(created.map((r) => r.store_id).sort()).toEqual([f.a.storeId, f.a2.storeId].sort());
    expect(
      created.every((r) => r.kind === "store_statement" && r.period_start === "2025-03-01"),
    ).toBe(true);
  });

  it("bara de valda butikerna, och bara ägarens", async () => {
    const owner = await viewerFor(f.a.owner, f.a.orgId);
    const result = await createOwnerReportsFor(owner, {
      ownerId,
      month: "2025-03",
      period: null,
      greeting: null,
      // A2 och en butik i en annan organisation: bara A2 får en rapport.
      storeIds: [f.a2.storeId, f.b.storeId],
    });
    expect(result.created.map((c) => c.storeId)).toEqual([f.a2.storeId]);
  });

  it("läsaren, påfyllaren och en annan organisation får inga rapporter", async () => {
    const before = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.reports where organization_id = ${f.a.orgId}::uuid`,
    );
    for (const u of [f.viewerA, f.refillerA]) {
      await expect(
        createOwnerReportsFor(await viewerFor(u, f.a.orgId), {
          ownerId,
          month: "2025-03",
          period: null,
          greeting: null,
        }),
      ).rejects.toThrow();
    }
    // B:s ägare ser inte A:s butiker: ägaren har inga butiker för hen.
    await expect(
      createOwnerReportsFor(await viewerFor(f.b.owner, f.b.orgId), {
        ownerId,
        month: "2025-03",
        period: null,
        greeting: null,
      }),
    ).rejects.toThrow("Butiksägaren har inga butiker.");
    const after = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.reports where organization_id = ${f.a.orgId}::uuid`,
    );
    expect(after.n).toBe(before.n);
  });
});
