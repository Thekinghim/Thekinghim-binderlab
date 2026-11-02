/**
 * Oberoende granskning av Rapporter (fas 6): försök att kringgå behörigheten och
 * kontroller av att underlaget stämmer mot databasen.
 *
 * - Butiksanvändare och påfyllare når varken tjänsten eller tabellerna.
 * - Läsaren (delägaren) kan inte godkänna, inte ens direkt mot databasen.
 * - Godkännandet kan inte förfalskas (annan användare, annan organisation).
 * - Bokföringsunderlaget tar med ALL försäljning, även order vars titel inte är kopplad.
 * - Butiksrapportens "påfyllningar" räknar besök, inte en rad per titel.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, listOrganizationsFor, type SessionUser } from "@/server/access";
import {
  approveReportFor,
  createReportFor,
  getReportFor,
  listArchiveFor,
  previewReportFor,
  type Viewer,
} from "@/server/reports/service";

import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-11-05T09:00:00Z");
const OCT = "2025-10";

let owner: TestUser;
let otherOwner: TestUser;
let viewer: TestUser;
let refiller: TestUser;
let storeUser: TestUser;
let orgId: string;
let otherOrgId: string;
let storeId: string;
let ownerViewer: Viewer;
let reportId: string;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** En Viewer för en användare som inte syns i listOrganizationsFor (butik). */
function forgedViewer(u: TestUser): Viewer {
  return { user: { userId: u.id, email: u.email }, organization: ownerViewer.organization };
}

beforeAll(async () => {
  owner = await createUser(`rt-rapport-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `RT Rapporter ${uniqueSuffix()}`);
  otherOwner = await createUser(`rt-rapport-annan-${uniqueSuffix()}@test.binderlab.se`);
  otherOrgId = await createOrg(otherOwner, `RT Annan ${uniqueSuffix()}`);

  await asPostgres(async (tx) => {
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name) values (${orgId}, 'Nordstan') returning id`,
    );
    storeId = store.id;
    await tx.execute(sql`insert into public.store_agreements
        (organization_id, store_id, valid_from, commission_bp)
        values (${orgId}, ${storeId}, '2025-01-01', 1000)`);
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${orgId}, 'BL-001', 'Entré', '2025-01-01') returning id`,
    );
    await tx.execute(sql`insert into public.machine_placements
        (organization_id, machine_id, store_id, valid_from)
        values (${orgId}, ${machine.id}, ${storeId}, '2025-01-01')`);
    const t1 = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Black Bolt') returning id`,
    );
    const t2 = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Surging Sparks') returning id`,
    );
    const source = await one<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name)
          values (${orgId}, 'awish_csv', 'Awish') returning id`,
    );
    // Tre order i oktober: två med titel, en vars titel inte kopplats ännu (nytt namn i
    // Awish). Alla tre är försäljning som ska bokföras.
    const order = (ext: string, at: string, titleId: string | null, amount: number) =>
      tx.execute(sql`insert into public.orders
          (organization_id, data_source_id, external_id, raw_title, title_id, ordered_at,
           amount_ore, machine_id, source_hash)
          values (${orgId}, ${source.id}, ${ext}, 'x', ${titleId}, ${at}::timestamptz,
                  ${amount}, ${machine.id}, ${`h${ext}`})`);
    await order("2001", "2025-10-03T10:00:00Z", t1.id, 4900);
    await order("2002", "2025-10-04T10:00:00Z", null, 5900);
    await order("2003", "2025-10-05T10:00:00Z", t1.id, 4900);

    // Två påfyllningsbesök, tre titlar per gång eller två: 2 besök, 4 rader.
    const loc = await one<{ id: string }>(
      tx,
      sql`select id from public.stock_locations
          where organization_id = ${orgId} and machine_id = ${machine.id}`,
    ).catch(() =>
      one<{ id: string }>(
        tx,
        sql`insert into public.stock_locations (organization_id, kind, machine_id, name)
            values (${orgId}, 'machine', ${machine.id}, 'Entré') returning id`,
      ),
    );
    for (const [title, at] of [
      [t1.id, "2025-10-10T08:00:00Z"],
      [t2.id, "2025-10-10T08:00:00Z"],
      [t1.id, "2025-10-20T08:00:00Z"],
      [t2.id, "2025-10-20T08:00:00Z"],
    ] as const) {
      await tx.execute(sql`insert into public.stock_events
          (organization_id, location_id, title_id, kind, quantity, occurred_at, business_date)
          values (${orgId}, ${loc.id}, ${title}, 'refill', 5, ${at}::timestamptz,
                  (${at}::timestamptz at time zone 'Europe/Stockholm')::date)`);
    }
  });

  ownerViewer = await viewerFor(owner, orgId);
  viewer = await createMember(orgId, "viewer");
  refiller = await createMember(orgId, "refiller");
  storeUser = await createUser(`rt-butik-${uniqueSuffix()}@test.binderlab.se`);
  await asPostgres((tx) =>
    tx.execute(sql`insert into public.memberships (organization_id, user_id, role, store_id)
        values (${orgId}, ${storeUser.id}, 'store', ${storeId})`),
  );
  reportId = await createReportFor(ownerViewer, { type: "butik", month: OCT, storeId }, NOW);
});

describe("butik och påfyllare når inte rapporterna", () => {
  it("tjänsten nekar butiksanvändaren och påfyllaren", async () => {
    for (const u of [storeUser, refiller]) {
      const v = forgedViewer(u);
      await expect(listArchiveFor(v)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(getReportFor(v, reportId)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        previewReportFor(v, { type: "delagare", month: OCT }, NOW),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(approveReportFor(v, reportId)).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it("tabellerna är tomma för butiksanvändaren och påfyllaren", async () => {
    for (const u of [storeUser, refiller]) {
      await asUser(u, async (tx) => {
        for (const table of [
          "reports",
          "report_approvals",
          "report_deliveries",
          "report_recipients",
        ]) {
          const r = await rows(tx, sql`select 1 from ${sql.raw(`public.${table}`)}`);
          expect(r, `${u.email} ${table}`).toHaveLength(0);
        }
      });
    }
  });
});

describe("godkännandet kan inte kringgås", () => {
  it("läsaren kan inte godkänna direkt mot databasen", async () => {
    await asUser(viewer, async (tx) => {
      const r = await attempt(tx, (sp) =>
        sp.execute(sql`insert into public.report_approvals (organization_id, report_id, approved_by)
            values (${orgId}, ${reportId}, ${viewer.id})`),
      );
      expect(r.ok).toBe(false);
    });
  });

  it("ägaren i en annan organisation kan inte godkänna", async () => {
    await asUser(otherOwner, async (tx) => {
      const r = await attempt(tx, (sp) =>
        sp.execute(sql`insert into public.report_approvals (organization_id, report_id, approved_by)
            values (${orgId}, ${reportId}, ${otherOwner.id})`),
      );
      expect(r.ok).toBe(false);
      const r2 = await attempt(tx, (sp) =>
        sp.execute(sql`insert into public.report_approvals (organization_id, report_id, approved_by)
            values (${otherOrgId}, ${reportId}, ${otherOwner.id})`),
      );
      expect(r2.ok).toBe(false);
    });
  });

  it("godkännandet står alltid i den inloggades namn", async () => {
    const admin = await createMember(orgId, "admin");
    const id = await createReportFor(ownerViewer, { type: "delagare", month: OCT }, NOW);
    await asUser(admin, async (tx) => {
      const r = await attempt(tx, (sp) =>
        sp.execute(sql`insert into public.report_approvals (organization_id, report_id, approved_by)
            values (${orgId}, ${id}, ${owner.id})`),
      );
      // Antingen nekas det, eller så skriver databasen över med den inloggade.
      if (r.ok) {
        const row = await one<{ approved_by: string }>(
          tx,
          sql`select approved_by from public.report_approvals where report_id = ${id}`,
        );
        expect(row.approved_by).toBe(admin.id);
      }
    });
  });
});

describe("underlaget stämmer mot databasen", () => {
  it("bokföringsunderlaget tar med order vars titel inte är kopplad", async () => {
    const snap = await previewReportFor(ownerViewer, { type: "bokforing", month: OCT }, NOW);
    if (snap.type !== "bokforing") throw new Error("fel typ");
    const db = await asPostgres((tx) =>
      one<{ n: number; sum: string }>(
        tx,
        sql`select count(*)::int as n, sum(amount_ore)::text as sum from public.orders
            where organization_id = ${orgId}
              and business_date between '2025-10-01' and '2025-10-31'`,
      ),
    );
    expect(db.n).toBe(3);
    // All försäljning i perioden ska bokföras, oavsett om titeln är kopplad.
    expect(snap.report.totals.orders).toBe(db.n);
    expect(snap.report.totals.grossOre).toBe(Number(db.sum));
  });

  it("butiksersättningen räknas på all försäljning i butiken", async () => {
    const snap = await previewReportFor(ownerViewer, { type: "butik", month: OCT, storeId }, NOW);
    if (snap.type !== "butik") throw new Error("fel typ");
    expect(snap.report.sales.revenueOre).toBe(4900 + 5900 + 4900);
    expect(snap.report.compensation.commissionOre).toBe(490 + 590 + 490);
  });

  it("påfyllningar räknas som besök, inte som en rad per titel", async () => {
    const snap = await previewReportFor(ownerViewer, { type: "butik", month: OCT, storeId }, NOW);
    if (snap.type !== "butik") throw new Error("fel typ");
    expect(snap.service.refills.count).toBe(2);
    expect(snap.service.refills.last).toBe("2025-10-20");
  });
});
