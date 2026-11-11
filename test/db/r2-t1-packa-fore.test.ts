/**
 * Runda 2, T1-2: "Packa 1 omgång före fredag" räknat från facken, mot testdatabasen.
 *
 * Som i prod: 1 automat, 9 mystery packs i facket och 3 sålda om dagen de senaste 14
 * dagarna. Mystery-laddaren (loadMysteryOverviewFor) ska ge 1 omgång med en dag, aldrig
 * planens 4. Med en omgång packad hemma: 0 omgångar och 1 färdig. Påfyllaren (ser inga
 * belopp och inga order) får samma svar. En ny automat med tomt fack och utan historik ger
 * en omgång till, märkt som ny.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { addDays } from "../../src/domain";
import { listOrganizationsFor } from "../../src/server/access";
import { businessToday, type Viewer } from "../../src/server/data/core/loaders";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { loadMysteryOverviewFor, loadMysteryPackPlansFor } =
  await import("../../src/app/(app)/vart-lager/mystery/_lib/data");
const { packSentence } = await import("../../src/app/(app)/vart-lager/mystery/_lib/model");
const { sv } = await import("../../src/i18n/sv");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const NOW = new Date();
let owner: TestUser;
let refiller: TestUser;
let orgId: string;
let m1: string;
let m2: string;
let loc1: string;
let centralId: string;
let mp: string;
let part: string;
let today: string;

async function event(location: string, titleId: string, kind: string, quantity: number) {
  await asPostgres((tx) =>
    tx.execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      values (${orgId}::uuid, ${location}::uuid, ${titleId}::uuid, ${kind}::public.stock_event_kind,
              ${quantity}, now(), 'test')`),
  );
}

const locationOf = async (machineId: string) =>
  (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
    )
  ).id;

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  refiller = await createMember(orgId, "refiller");
  const viewer = await viewerFor(owner, orgId);
  today = businessToday(NOW, viewer.organization.timezone);
  const machines = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Automat 1", activeFrom: "2026-01-01" },
        { organizationId: orgId, code: "BL-002", name: "Automat 2", activeFrom: "2026-01-01" },
      ])
      .returning(),
  );
  m1 = machines.find((m) => m.code === "BL-001")!.id;
  m2 = machines.find((m) => m.code === "BL-002")!.id;
  loc1 = await locationOf(m1);
  centralId = (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where organization_id = ${orgId}::uuid and is_central`,
    )
  ).id;
  await asUser(owner, async (tx) => {
    const titles = await tx
      .insert(s.titles)
      .values([
        { organizationId: orgId, name: "Mystery Pack", ownProduct: true },
        { organizationId: orgId, name: "Phantasmal Flames" },
      ])
      .returning();
    [mp, part] = titles.map((t) => t.id) as [string, string];
    await tx.execute(
      sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 14,
            ${JSON.stringify([{ titleId: part, quantity: 14, hit: false }])}::jsonb)`,
    );
  });
  // 3 köp om dagen i BL-001 de senaste 14 hela dagarna (t.o.m. i går).
  await asPostgres(async (tx) => {
    const [src] = Array.from(
      await tx.execute(
        sql`insert into public.data_sources (organization_id, provider, name)
            values (${orgId}::uuid, 'awish_csv', 'Awish CSV') returning id::text as id`,
      ),
    ) as { id: string }[];
    await tx.execute(sql`
      insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                 ordered_at, amount_ore, machine_id, source_hash)
      select ${orgId}::uuid, ${src!.id}::uuid, 'r2t1-' || d || '-' || n, 'Mystery Pack', ${mp}::uuid,
             ((${today}::date - d) + time '12:00' + (n || ' minutes')::interval)
               at time zone 'Europe/Stockholm',
             17900, ${m1}::uuid, md5('r2t1-' || d || '-' || n)
      from generate_series(1, 14) d, generate_series(1, 3) n`);
  });
  // Räknat efter försäljningen: 9 pack kvar i facket.
  await event(loc1, mp, "count", 9);
  await event(centralId, mp, "count", 0);
});

describe("Mystery-laddaren: omgångar räknade från facken", () => {
  it("försäljningen finns som händelser i automatens lager (42 pack på 14 dagar)", async () => {
    const row = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events
          where organization_id = ${orgId}::uuid and location_id = ${loc1}::uuid
            and title_id = ${mp}::uuid and kind = 'sale'`,
    );
    expect(Number(row.n)).toBe(42);
  });

  it("9 pack i facket och 3 om dagen: 1 omgång, tom om 3 dagar, aldrig 4 omgångar", async () => {
    for (const u of [owner, refiller]) {
      const view = await loadMysteryOverviewFor(await viewerFor(u, orgId), NOW);
      const title = view.titles.find((t) => t.id === mp)!;
      expect(title.toPack).toMatchObject({
        batches: 1,
        packs: 14,
        readyBatches: 0,
        before: addDays(today, 3),
        basis: "slots",
      });
      expect(title.toPack?.first).toMatchObject({ label: "BL-001", daysLeft: 3 });
      expect(packSentence(title.toPack, sv)?.text).toMatch(
        /^Packa 1 omgång före \S+\. BL-001 är tom om ca 3 dagar\.$/,
      );
    }
  });

  it("en omgång packad hemma: inget att packa, '1 omgång ligger klar hemma'", async () => {
    await event(centralId, mp, "count", 14);
    const view = await loadMysteryOverviewFor(await viewerFor(owner, orgId), NOW);
    const title = view.titles.find((t) => t.id === mp)!;
    expect(title.toPack).toMatchObject({ batches: 0, packs: 0, readyBatches: 1, before: null });
    expect(packSentence(title.toPack, sv)?.text).toContain("1 omgång ligger klar hemma.");
    await event(centralId, mp, "count", 0);
  });

  it("ny automat med titeln i sortimentet, tomt fack och ingen historik: en omgång till", async () => {
    await asPostgres((tx) =>
      tx.execute(
        sql`insert into public.machine_slots (organization_id, machine_id, title_id, slots, valid_from)
            values (${orgId}::uuid, ${m2}::uuid, ${mp}::uuid, 1, ${today}::date - 2)`,
      ),
    );
    const plans = await loadMysteryPackPlansFor(await viewerFor(refiller, orgId), NOW);
    const plan = plans.get(mp)!;
    expect(plan.batches).toBe(2);
    expect(plan.due?.map((d) => [d.label, d.isNew, d.emptyNow])).toEqual([
      ["BL-002", true, true],
      ["BL-001", false, false],
    ]);
    expect(packSentence(plan, sv)?.text).toBe(
      "Ny automat BL-002: packa 2 omgångar. 1 automat till blir tom i veckan.",
    );
  });

  it("en titel som gått ur automatens sortiment och står på 0 räknas inte", async () => {
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.machine_slots set valid_to = ${today}::date - 1
            where organization_id = ${orgId}::uuid and machine_id = ${m2}::uuid`,
      ),
    );
    const plans = await loadMysteryPackPlansFor(await viewerFor(owner, orgId), NOW);
    expect(plans.get(mp)).toMatchObject({ batches: 1 });
    expect(plans.get(mp)?.due?.map((d) => d.label)).toEqual(["BL-001"]);
  });
});
