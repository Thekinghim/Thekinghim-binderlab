/**
 * Fixtur för testerna "pengar som inte kan driva" (månadsstängning, kortavgift, betald mot
 * rapport, äldre avräkningar): en organisation med ägare och admin, två butiker och
 * försäljning i september och oktober 2026.
 *
 *   Vinsten   50 % av vinsten efter kostnader. Automat BL-001.
 *   Provision 10 % av försäljningen. Automat BL-002.
 *
 * Titeln "Pack" kostar 40,00 kr från 1 jan. 2026.
 */

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import {
  listOrganizationsFor,
  type OrganizationMembership,
  type SessionUser,
} from "@/server/access";

import { addMember, asPostgres, createOrg, createUser, one, type TestUser } from "./helpers";

export interface Viewerish {
  user: SessionUser;
  organization: OrganizationMembership;
}

export interface MoneyFixture {
  orgId: string;
  ownerUser: TestUser;
  adminUser: TestUser;
  owner: Viewerish;
  admin: Viewerish;
  stores: { vinsten: string; provision: string };
  machines: { m1: string; m2: string };
  titleId: string;
  sourceId: string;
  /** Lägger in en order (som systemet). Ger orderns id. */
  order: (machine: "m1" | "m2", day: string, ore: number) => Promise<string>;
}

export async function seedMoneyFixture(name = "Pengar"): Promise<MoneyFixture> {
  const ownerUser = await createUser();
  const adminUser = await createUser();
  const orgId = await createOrg(ownerUser, name);
  await addMember(orgId, adminUser, "admin");
  let n = 0;
  const setup = await asPostgres(async (tx) => {
    const id = async (q: ReturnType<typeof sql>) => (await one<{ id: string }>(tx, q)).id;
    const vinsten = await id(
      sql`insert into public.stores (organization_id, name) values (${orgId}, 'Vinsten') returning id`,
    );
    const provision = await id(
      sql`insert into public.stores (organization_id, name) values (${orgId}, 'Provision') returning id`,
    );
    await tx.execute(sql`insert into public.store_agreements
      (organization_id, store_id, valid_from, commission_base, commission_bp)
      values (${orgId}, ${vinsten}, '2026-01-01', 'profit_after_costs', 5000),
             (${orgId}, ${provision}, '2026-01-01', 'net_excl_vat', 1000)`);
    const m1 = await id(
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${orgId}, 'BL-001', 'BL-001', '2026-01-01') returning id`,
    );
    const m2 = await id(
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${orgId}, 'BL-002', 'BL-002', '2026-01-01') returning id`,
    );
    await tx.execute(sql`insert into public.machine_placements
      (organization_id, machine_id, store_id, valid_from)
      values (${orgId}, ${m1}, ${vinsten}, '2026-01-01'), (${orgId}, ${m2}, ${provision}, '2026-01-01')`);
    const titleId = await id(
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Pack') returning id`,
    );
    await tx.execute(sql`insert into public.purchase_prices
      (organization_id, title_id, unit_cost_ore, valid_from)
      values (${orgId}, ${titleId}, 4000, '2026-01-01')`);
    const sourceId = await id(
      sql`insert into public.data_sources (organization_id, provider, name)
          values (${orgId}, 'awish_csv', 'CSV') returning id`,
    );
    return { vinsten, provision, m1, m2, titleId, sourceId };
  });
  const insertOrder = async (tx: Tx, machineId: string, day: string, ore: number) => {
    n += 1;
    const key = `${orgId.slice(0, 8)}-${n}`;
    return (
      await one<{ id: string }>(
        tx,
        sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title,
              title_id, ordered_at, amount_ore, machine_id, source_hash)
            values (${orgId}, ${setup.sourceId}, ${`p-${key}`}, 'Pack', ${setup.titleId},
              ${`${day}T10:00:00Z`}, ${ore}, ${machineId}, ${`ph-${key}`})
            returning id`,
      )
    ).id;
  };
  const order: MoneyFixture["order"] = (machine, day, ore) =>
    asPostgres((tx) => insertOrder(tx, machine === "m1" ? setup.m1 : setup.m2, day, ore));
  // September: 100 kr i varje butik. Oktober: 200 kr hos Vinsten, 300 kr hos Provision.
  await order("m1", "2026-09-10", 10_000);
  await order("m2", "2026-09-11", 10_000);
  await order("m1", "2026-10-05", 10_000);
  await order("m1", "2026-10-20", 10_000);
  await order("m2", "2026-10-06", 30_000);
  const viewer = async (u: TestUser): Promise<Viewerish> => {
    const user = { userId: u.id, email: u.email };
    const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId)!;
    return { user, organization };
  };
  return {
    orgId,
    ownerUser,
    adminUser,
    owner: await viewer(ownerUser),
    admin: await viewer(adminUser),
    stores: { vinsten: setup.vinsten, provision: setup.provision },
    machines: { m1: setup.m1, m2: setup.m2 },
    titleId: setup.titleId,
    sourceId: setup.sourceId,
    order,
  };
}

/** Avräkningens id för butiken och månaden ('ÅÅÅÅ-MM'). */
export async function settlementId(orgId: string, storeId: string, month: string): Promise<string> {
  return asPostgres(
    async (tx) =>
      (
        await one<{ id: string }>(
          tx,
          sql`select id from public.store_settlements
              where organization_id = ${orgId} and store_id = ${storeId} and month = ${`${month}-01`}`,
        )
      ).id,
  );
}
