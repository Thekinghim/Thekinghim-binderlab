/**
 * Fixtur för butiksportalens tester (test/db/portal-*.test.ts).
 *
 * Organisation A (seedPortalTenant) med två butiker:
 *   A1 = fixturens butik (automat BL-001, order i mars 2025, provision 20 %),
 *   A2 = en andra butik med egen automat (BL-002), egna order, avtal och rapport.
 * Organisation B (seedPortalTenant) med en butik B1.
 * Butiksanvändare för A1, A2 och B1 bjuds in och tar emot inbjudan på riktigt
 * (create_store_invitation + accept_invitation).
 */

import { sql } from "drizzle-orm";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  one,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

/** En organisation med en butik, en automat, order, inköpspriser, en rapport och ett ärende. */
export interface PortalTenant {
  orgId: string;
  owner: TestUser;
  storeId: string;
  machineId: string;
  titleId: string;
  secondTitleId: string;
  dataSourceId: string;
}

/**
 * Egen fixtur (oberoende av seedTenantFixture, som andra områden bygger ut):
 * butiken har provision 20 % från 2025-01-01, automaten BL-001 står där, två
 * order i mars 2025 (79 kr och 89 kr), inköpspriser, en butiksrapport med PDF
 * och ett ärende som operatören skapat.
 */
export async function seedPortalTenant(storeName = "ICA Testbutik"): Promise<PortalTenant> {
  const owner = await createUser(`owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Fixtur ${uniqueSuffix()}`);
  return asPostgres(async (tx) => {
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name, email)
          values (${orgId}, ${storeName}, 'anna@example.se') returning id`,
    );
    await tx.execute(
      sql`insert into public.store_agreements (organization_id, store_id, valid_from, commission_bp)
          values (${orgId}, ${store.id}, '2025-01-01', 2000)`,
    );
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${orgId}, 'BL-001', 'Automat 1', '2025-01-01') returning id`,
    );
    await tx.execute(
      sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
          values (${orgId}, ${machine.id}, ${store.id}, '2025-01-01')`,
    );
    const title = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Pokémon 151 Booster') returning id`,
    );
    const second = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Surging Sparks Booster') returning id`,
    );
    await tx.execute(
      sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
          values (${orgId}, ${title.id}, 4500, '2025-01-01'), (${orgId}, ${second.id}, 5200, '2025-01-01')`,
    );
    const source = await one<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name)
          values (${orgId}, 'awish_csv', 'Awish CSV') returning id`,
    );
    await tx.execute(
      sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                     ordered_at, amount_ore, machine_id, source_hash)
          values
            (${orgId}, ${source.id}, '42001', 'Pokemon 151', ${title.id}, '2025-03-10T10:00:00Z', 7900, ${machine.id}, 'h1'),
            (${orgId}, ${source.id}, '42002', 'Surging Sparks', ${second.id}, '2025-03-11T10:00:00Z', 8900, ${machine.id}, 'h2')`,
    );
    await tx.execute(
      sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                      storage_path, data_snapshot, calc_version)
          values (${orgId}, 'store_statement', '2025-03-01', '2025-03-31', ${store.id},
                  ${`${orgId}/reports/2025-03.pdf`}, '{"revenueOre":16800}'::jsonb, 'calc@1')`,
    );
    await tx.execute(
      sql`insert into public.incidents (organization_id, machine_id, kind, started_at, description)
          values (${orgId}, ${machine.id}, 'coin_jam', '2025-03-12T09:00:00Z', 'Internt ärende')`,
    );
    return {
      orgId,
      owner,
      storeId: store.id,
      machineId: machine.id,
      titleId: title.id,
      secondTitleId: second.id,
      dataSourceId: source.id,
    };
  });
}

export interface PortalFixture {
  a: PortalTenant;
  b: PortalTenant;
  a2: { storeId: string; machineId: string; reportId: string; orderIds: string[] };
  storeA1: TestUser;
  storeA2: TestUser;
  storeB1: TestUser;
  viewerA: TestUser;
  refillerA: TestUser;
  adminA: TestUser;
  /** Rapporten (store_statement) till A1 i fixturen. */
  reportA1: string;
  /** En delägarrapport (owner_statement) i A, som butiken aldrig får se. */
  ownerReportA: string;
}

/** Bjuder in och tar emot: en butiksanvändare för butiken. */
export async function inviteStoreUser(
  inviter: TestUser,
  orgId: string,
  storeId: string,
  email = `butik-${uniqueSuffix()}@test.binderlab.se`,
): Promise<TestUser> {
  const { token } = await asUser(inviter, (tx) =>
    one<{ token: string }>(
      tx,
      sql`select public.create_store_invitation(${orgId}::uuid, ${storeId}::uuid, ${email}) as token`,
    ),
  );
  const user = await createUser(email);
  await asUser(user, (tx) => tx.execute(sql`select public.accept_invitation(${token})`));
  return user;
}

export async function seedPortalFixture(): Promise<PortalFixture> {
  const a = await seedPortalTenant("ICA Testbutik");
  const b = await seedPortalTenant("Hemköp Annan organisation");

  const a2 = await asPostgres(async (tx) => {
    const org = a.orgId;
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name, email)
          values (${org}, 'Coop Andra butiken', 'coop@example.se') returning id`,
    );
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${org}, 'BL-002', 'Automat 2', '2025-01-01') returning id`,
    );
    await tx.execute(
      sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
          values (${org}, ${machine.id}, ${store.id}, '2025-01-01')`,
    );
    await tx.execute(
      sql`insert into public.store_agreements (organization_id, store_id, valid_from, commission_bp, monthly_rent_ore)
          values (${org}, ${store.id}, '2025-01-01', 1500, 50000)`,
    );
    const orders = await tx.execute(
      sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                     ordered_at, amount_ore, machine_id, source_hash)
          values
            (${org}, ${a.dataSourceId}, ${`A2-${uniqueSuffix()}`}, 'Pokemon 151', ${a.titleId},
             '2025-03-12T10:00:00Z', 12900, ${machine.id}, 'a2-1'),
            (${org}, ${a.dataSourceId}, ${`A2-${uniqueSuffix()}`}, 'Pokemon 151', ${a.titleId},
             '2025-03-13T10:00:00Z', 12900, ${machine.id}, 'a2-2'),
            (${org}, ${a.dataSourceId}, ${`A2-${uniqueSuffix()}`}, 'Surging Sparks', ${a.secondTitleId},
             '2025-03-14T10:00:00Z', 9900, ${machine.id}, 'a2-3')
          returning id`,
    );
    const report = await one<{ id: string }>(
      tx,
      sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                      storage_path, data_snapshot, calc_version)
          values (${org}, 'store_statement', '2025-03-01', '2025-03-31', ${store.id},
                  ${`${org}/reports/a2-2025-03.pdf`},
                  ${JSON.stringify({ kind: "store", store: { id: store.id, name: "Coop Andra butiken" } })}::jsonb,
                  'calc@1')
          returning id`,
    );
    return {
      storeId: store.id,
      machineId: machine.id,
      reportId: report.id,
      orderIds: Array.from(orders).map((r) => String((r as { id: string }).id)),
    };
  });

  const { reportA1, ownerReportA } = await asPostgres(async (tx) => {
    const r1 = await one<{ id: string }>(
      tx,
      sql`select id from public.reports
          where organization_id = ${a.orgId} and store_id = ${a.storeId} and kind = 'store_statement'
          limit 1`,
    );
    const owner = await one<{ id: string }>(
      tx,
      sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                      storage_path, data_snapshot, calc_version)
          values (${a.orgId}, 'owner_statement', '2025-03-01', '2025-03-31', ${a.storeId},
                  ${`${a.orgId}/reports/agare-2025-03.pdf`},
                  '{"kind":"store","profitOre":123}'::jsonb, 'calc@1')
          returning id`,
    );
    // Butiken ser bara godkända rapporter (report_approvals). Fixturens
    // rapporter godkänns här; utkast testas i redteam-portal.test.ts.
    for (const [org, id] of [
      [a.orgId, r1.id],
      [a.orgId, a2.reportId],
      [a.orgId, owner.id],
      [b.orgId, null],
    ] as const) {
      await tx.execute(
        id
          ? sql`insert into public.report_approvals (organization_id, report_id) values (${org}, ${id})`
          : sql`insert into public.report_approvals (organization_id, report_id)
                select organization_id, id from public.reports
                where organization_id = ${org} and kind = 'store_statement'`,
      );
    }
    return { reportA1: r1.id, ownerReportA: owner.id };
  });

  const storeA1 = await inviteStoreUser(a.owner, a.orgId, a.storeId);
  const storeA2 = await inviteStoreUser(a.owner, a.orgId, a2.storeId);
  const storeB1 = await inviteStoreUser(b.owner, b.orgId, b.storeId);
  const viewerA = await createMember(a.orgId, "viewer");
  const refillerA = await createMember(a.orgId, "refiller");
  const adminA = await createMember(a.orgId, "admin");

  return {
    a,
    b,
    a2,
    storeA1,
    storeA2,
    storeB1,
    viewerA,
    refillerA,
    adminA,
    reportA1,
    ownerReportA,
  };
}
