/**
 * Där butiksrapporten, robustheten och butiksägarna möts.
 *
 * 1. Butiksrapportens mottagare är butikens ägare (juridiskt namn, org.nr, momsreg.nr,
 *    adress) när butiken har en, sparat i rapporten (`report.basis.recipient`). En butik
 *    utan ägare får rapporten som förut (ingen nyckel, så att utkasten inte blir gamla).
 * 2. Rapporter per ägare är vanliga butiksrapporter i den nya utgåvan: underlaget, redan
 *    betalt (med robusthetens `paid_amount_ore`) och momsvalet.
 * 3. Butiksportalen: butikens egen användare ser sin ägare i rapporten, ingen annan butik
 *    når rapporten, och rapporten nämner aldrig ägarens andra butiker.
 * 4. Ägarfiltret i statistiken är summan av butikerna med robusthetens placeringsregel
 *    (försäljning före automatens första placering hör till butiken), och rapporten räknar
 *    samma försäljning.
 *
 * Fixturen är butiksportalens (A1 och A2 med order i mars 2025). Allt är påhittat.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/db/client";
import type { OrganizationMembership, SessionUser } from "@/server/access";

const session = vi.hoisted(() => ({
  current: null as null | { user: SessionUser; organization: OrganizationMembership },
}));

vi.mock("@/server/session", async () => {
  const access = await import("@/server/access");
  const who = () => {
    if (!session.current) throw new Error("Ingen inloggad i testet.");
    return session.current;
  };
  return {
    AuthorizationError: access.AuthorizationError,
    getSessionUser: async () => session.current?.user ?? null,
    requireUser: async () => who().user,
    getActiveOrganization: async () => who().organization,
    withUserDb: <T>(fn: (tx: Tx) => Promise<T>) => access.withUserDbFor(who().user, fn),
    requireRole: async (organizationId: string, roles: readonly string[]) => {
      const user = who().user;
      const role = await access.requireRoleFor(user, organizationId, roles as never);
      return { user, role };
    },
  };
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers({}),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  permanentRedirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

vi.mock("@/server/auth/next-cookies", () => ({
  nextCookieJar: async () => ({
    get: () => session.current?.organization.id,
    getAll: () => [],
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { createOwnerReportsFor } from "@/app/(app)/rapporter/_lib/owner-reports";
import { profitability } from "@/domain";
import { recipientLines, type StoreBasis } from "@/reports";
import { listOrganizationsFor } from "@/server/access";
import { loadDomainInput, loadPeriod } from "@/server/data/core";
import { queryPortalReport } from "@/server/portal/queries";
import { createReportFor, type Viewer } from "@/server/reports/service";

import { asPostgres, asUser, db, one, settle, type TestUser } from "./helpers";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

const NOW = new Date("2025-04-02T10:00:00Z");
const MARCH = { from: "2025-03-01", to: "2025-03-31" } as const;

let f: PortalFixture;
let ownerId: string;
let owner: Viewer;

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** Rapportens sparade innehåll. */
async function snapshotOf(reportId: string) {
  const row = await one<{ snap: { report?: Record<string, unknown> } }>(
    db(),
    sql`select data_snapshot as snap from public.reports where id = ${reportId}::uuid`,
  );
  return row.snap.report as { basis?: StoreBasis; sales: { orders: number }; store: unknown };
}

/** Laddarnas försäljning för ett filter (?butik= eller ?agare=), som sidorna läser den. */
async function figures(filter: Record<string, string>) {
  session.current = owner;
  const p = await loadPeriod({ ...MARCH, ...filter });
  const input = await loadDomainInput({ period: p.period, compare: null, ...p.scope });
  const t = profitability(input.current, "title").totals;
  return { revenue: t.revenueOre, orders: t.orders, storeShare: t.compensationOre };
}

beforeAll(async () => {
  f = await seedPortalFixture();
  owner = await viewerFor(f.a.owner, f.a.orgId);
  // Påhittat bolag som äger båda butikerna i A.
  const o = await one<{ id: string }>(
    db(),
    sql`insert into public.store_owners
          (organization_id, legal_name, org_number, vat_number, street_address, postal_code, city)
        values (${f.a.orgId}::uuid, 'Godisbolaget Väst AB', '559900-1236', 'SE559900123601',
                'Exempelgatan 4', '411 01', 'Exempelstad')
        returning id`,
  );
  ownerId = o.id;
  await db().execute(
    sql`update public.stores set owner_id = ${ownerId}::uuid
        where id in (${f.a.storeId}::uuid, ${f.a2.storeId}::uuid)`,
  );
  await asPostgres(async (tx) => {
    // En ny automat i A1: placerad den 20:e, men den sålde redan den 5:e. Placeringsregeln
    // ger butiken också den försäljningen.
    const m = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${f.a.orgId}, 'BL-009', 'Automat 9', '2025-03-05') returning id`,
    );
    await tx.execute(
      sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
          values (${f.a.orgId}, ${m.id}, ${f.a.storeId}, '2025-03-20')`,
    );
    await tx.execute(
      sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                     ordered_at, amount_ore, machine_id, source_hash)
          values
            (${f.a.orgId}, ${f.a.dataSourceId}, 'S-1', 'Pokemon 151', ${f.a.titleId},
             '2025-03-05T10:00:00Z', 7900, ${m.id}, 'samlat-1'),
            (${f.a.orgId}, ${f.a.dataSourceId}, 'S-2', 'Pokemon 151', ${f.a.titleId},
             '2025-03-25T10:00:00Z', 7900, ${m.id}, 'samlat-2')`,
    );
    // Mars är redan betald till A1, med ett annat belopp än avräkningens.
    const st = await one<{ id: string }>(
      tx,
      sql`insert into public.store_settlements
            (organization_id, store_id, month, amount_ore, statement, calc_version)
          values (${f.a.orgId}, ${f.a.storeId}, '2025-03-01', 1500, '{}'::jsonb, 'test')
          returning id`,
    );
    await tx.execute(
      sql`update public.store_settlements set paid_on = '2025-04-01', paid_amount_ore = 1400
          where id = ${st.id}`,
    );
  });
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  session.current = null;
});

describe("rapporter per ägare med underlaget", () => {
  let reportA1: string;
  let reportA2: string;

  beforeAll(async () => {
    const result = await createOwnerReportsFor(owner, {
      ownerId,
      month: "2025-03",
      period: null,
      greeting: null,
    });
    expect(result.skipped).toEqual([]);
    reportA1 = result.created.find((c) => c.storeId === f.a.storeId)!.reportId;
    reportA2 = result.created.find((c) => c.storeId === f.a2.storeId)!.reportId;
  });

  it("mottagaren är butikens ägare, i den nya utgåvan", async () => {
    const r = await snapshotOf(reportA1);
    expect(r.basis?.rev).toBe(2);
    expect(r.basis?.recipient).toEqual({
      name: "Godisbolaget Väst AB",
      orgNumber: "559900-1236",
      vatNumber: "SE559900123601",
      address: "Exempelgatan 4, 411 01 Exempelstad",
    });
    expect(recipientLines(r.basis!, "ICA Testbutik")).toEqual([
      "Godisbolaget Väst AB",
      "För butiken ICA Testbutik",
      "Org.nr 559900-1236",
      "Exempelgatan 4, 411 01 Exempelstad",
      "Momsreg.nr SE559900123601",
    ]);
    expect(r.basis?.vatMode).toBe("added");
  });

  it("redan betalt läser beloppet som betalades (paid_amount_ore)", async () => {
    const r = await snapshotOf(reportA1);
    expect(r.basis?.payments).toEqual([
      { paidOn: "2025-04-01", amountOre: 1400, month: "2025-03" },
    ]);
    // A2 har ingen betald avräkning.
    expect((await snapshotOf(reportA2)).basis?.payments ?? []).toEqual([]);
  });

  it("rapporten nämner aldrig ägarens andra butik", async () => {
    const text = JSON.stringify(await snapshotOf(reportA1));
    expect(text).not.toContain(f.a2.storeId);
    expect(text).not.toContain("Coop Andra butiken");
    expect(text).not.toContain(ownerId);
  });

  it("en butik utan ägare får rapporten som förut, utan mottagarens bolag", async () => {
    const b = await viewerFor(f.b.owner, f.b.orgId);
    session.current = b;
    const id = await createReportFor(b, {
      type: "butik",
      month: "2025-03",
      period: null,
      storeId: f.b.storeId,
      greeting: null,
    });
    const r = await snapshotOf(id);
    expect(r.basis?.rev).toBe(2);
    expect(r.basis && "recipient" in r.basis).toBe(false);
    expect(recipientLines(r.basis!, "Hemköp Annan organisation")[0]).toBe(
      "Hemköp Annan organisation",
    );
  });

  it("portalen: butikens användare ser sin ägare, ingen annan butik når rapporten", async () => {
    // Klockan i testet står i april 2025: rapporten görs nyare än fixturens godkända rapport
    // för samma månad, så att portalen visar den.
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`update public.reports set generated_at = now() + interval '1 minute'
            where id = ${reportA1}::uuid`,
      );
      await tx.execute(
        sql`insert into public.report_approvals (organization_id, report_id)
            values (${f.a.orgId}, ${reportA1})`,
      );
    });
    const res = await asUser(f.storeA1, (tx) => queryPortalReport(tx, f.a.storeId, reportA1));
    const report = res.report as { basis?: StoreBasis } | null;
    expect(report?.basis?.recipient?.name).toBe("Godisbolaget Väst AB");
    for (const [u, storeId] of [
      [f.storeA2, f.a.storeId],
      [f.storeA2, f.a2.storeId],
      [f.storeB1, f.b.storeId],
    ] as const) {
      const outcome = await settle(asUser(u, (tx) => queryPortalReport(tx, storeId, reportA1)));
      expect(outcome.ok).toBe(false);
    }
  });

  it("portalens SQL-kontroll godkänner mottagaren", async () => {
    const row = await one<{ ok: boolean }>(
      db(),
      sql`select private.portal_snapshot_safe(r.data_snapshot -> 'report', r.store_id) as ok
            from public.reports r where r.id = ${reportA1}::uuid`,
    );
    expect(row.ok).toBe(true);
  });
});

describe("ägarfiltret med en placeringsregel", () => {
  it("ägaren är summan av butikerna, och försäljningen före placeringen räknas", async () => {
    const all = await figures({ agare: ownerId });
    const a1 = await figures({ butik: f.a.storeId });
    const a2 = await figures({ butik: f.a2.storeId });
    // A1: två order på BL-001 och två på BL-009, varav en före placeringen.
    expect(a1.orders).toBe(4);
    expect(a2.orders).toBe(3);
    expect(all.orders).toBe(a1.orders + a2.orders);
    expect(all.revenue).toBe(a1.revenue + a2.revenue);
    expect(all.storeShare).toBe(a1.storeShare + a2.storeShare);
  });

  it("butiksrapporten räknar samma order som filtret", async () => {
    session.current = owner;
    const id = await createReportFor(owner, {
      type: "butik",
      month: "2025-03",
      period: null,
      storeId: f.a.storeId,
      greeting: null,
    });
    expect((await snapshotOf(id)).sales.orders).toBe(4);
  });
});
