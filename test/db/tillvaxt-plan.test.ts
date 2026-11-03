/**
 * Plan för fler automater (growth_plans, 20261104233300_tillvaxt_plan.sql) mot
 * testdatabasen: standard utan rad, spara och läsa (ägare och admin), läsaren läser,
 * påfyllaren ingenting, isolering mellan organisationer, gränser i databasen, ingen
 * radering och ändringslogg.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  GROWTH_PLAN_EMPTY,
  loadGrowthPlanFor,
  saveGrowthPlanFor,
  type Viewer,
} from "../../src/app/(app)/expansion/_lib/service";
import { growthPlanSchema } from "../../src/app/(app)/expansion/_lib/schemas";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let orgId: string;
let otherOrgId: string;
let ownerUser: TestUser;
let viewerUser: TestUser;
let refillerUser: TestUser;
let owner: Viewer;
let admin: Viewer;
let viewer: Viewer;
let refiller: Viewer;
let otherOwner: Viewer;

const BASE = {
  targetMachines: 20,
  machinePriceOre: null,
  startStockOre: null,
  machinesPerMonth: null,
  refillMinutesPerMachineWeek: null,
  people: 2,
  hoursPerPersonWeek: 10,
};

beforeAll(async () => {
  ownerUser = await createUser(`owner-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(ownerUser, "Plan AB");
  owner = await viewerFor(ownerUser, orgId);
  admin = await viewerFor(await createMember(orgId, "admin"), orgId);
  viewerUser = await createMember(orgId, "viewer");
  viewer = await viewerFor(viewerUser, orgId);
  refillerUser = await createMember(orgId, "refiller");
  refiller = await viewerFor(refillerUser, orgId);
  const o2 = await createUser(`owner2-${uniqueSuffix()}@test.binderlab.se`);
  otherOrgId = await createOrg(o2, "Annan AB");
  otherOwner = await viewerFor(o2, otherOrgId);
});

describe("growth_plans", () => {
  it("utan rad: standardvalen", async () => {
    expect(await loadGrowthPlanFor(owner)).toEqual(GROWTH_PLAN_EMPTY);
    expect(GROWTH_PLAN_EMPTY.saved).toBe(false);
  });

  it("ägare och admin sparar (en rad per organisation), läsaren läser", async () => {
    await saveGrowthPlanFor(owner, { ...BASE, targetMachines: 25, machinePriceOre: 3_500_000 });
    await saveGrowthPlanFor(admin, {
      ...BASE,
      targetMachines: 30,
      machinePriceOre: 4_000_000,
      machinesPerMonth: 3,
      refillMinutesPerMachineWeek: 40,
      hoursPerPersonWeek: 12,
    });
    expect(await loadGrowthPlanFor(viewer)).toEqual({
      ...BASE,
      targetMachines: 30,
      machinePriceOre: 4_000_000,
      machinesPerMonth: 3,
      refillMinutesPerMachineWeek: 40,
      hoursPerPersonWeek: 12,
      saved: true,
    });
    const { n } = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.growth_plans where organization_id = ${orgId}`,
    );
    expect(n).toBe(1);
  });

  it("läsaren och påfyllaren kan inte spara; påfyllaren läser inte", async () => {
    await expect(saveGrowthPlanFor(viewer, BASE)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(saveGrowthPlanFor(refiller, BASE)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadGrowthPlanFor(refiller)).rejects.toBeInstanceOf(AuthorizationError);
    // Direkt mot databasen med RLS: läsaren uppdaterar inga rader, påfyllaren ser inga.
    const updated = await asUser(viewerUser, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`update public.growth_plans set target_machines = 999
            where organization_id = ${orgId} returning id`,
      ),
    );
    expect(updated).toEqual([]);
    const seen = await asUser(refillerUser, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from public.growth_plans where organization_id = ${orgId}`,
      ),
    );
    expect(seen).toEqual([]);
    const insert = await asUser(viewerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.growth_plans (organization_id, target_machines)
              values (${orgId}, 5)`,
        ),
      ),
    );
    expect(insert.ok).toBe(false);
  });

  it("isolering: en annan organisation ser och ändrar bara sin egen plan", async () => {
    expect(await loadGrowthPlanFor(otherOwner)).toEqual(GROWTH_PLAN_EMPTY);
    await saveGrowthPlanFor(otherOwner, { ...BASE, targetMachines: 7 });
    expect((await loadGrowthPlanFor(owner)).targetMachines).toBe(30);
    // Ägaren i den andra organisationen kan inte skriva in en rad i vår.
    const cross = await asUser(ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.growth_plans (organization_id, target_machines)
              values (${otherOrgId}, 5)`,
        ),
      ),
    );
    expect(cross.ok).toBe(false);
    const moved = await asUser(ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.growth_plans set organization_id = ${otherOrgId}
              where organization_id = ${orgId}`,
        ),
      ),
    );
    expect(moved.ok).toBe(false);
  });

  it("gränser i databasen och ingen radering", async () => {
    for (const bad of [
      sql`target_machines = 0`,
      sql`people = 0`,
      sql`hours_per_person_week = 81`,
      sql`machines_per_month = 0`,
      sql`machine_price_ore = -1`,
      sql`refill_minutes_per_machine_week = 0`,
    ]) {
      const r = await asUser(ownerUser, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`update public.growth_plans set ${bad} where organization_id = ${orgId}`),
        ),
      );
      expect(r.ok).toBe(false);
    }
    const del = await db().transaction((tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`delete from public.growth_plans where organization_id = ${orgId}`),
      ),
    );
    expect(del.ok).toBe(false);
  });

  it("ändringar loggas", async () => {
    const logged = await rows<{ action: string }>(
      db(),
      sql`select a.action::text as action from public.audit_log a
          join public.growth_plans g on g.id = a.row_id
          where g.organization_id = ${orgId} and a.table_name = 'growth_plans'
          order by a.occurred_at`,
    );
    expect(logged.map((l) => l.action)).toEqual(["insert", "update"]);
  });
});

describe("growthPlanSchema", () => {
  it("tomma fält blir standard, text blir heltal och öre", () => {
    expect(
      growthPlanSchema.parse({
        targetMachines: "20",
        machinePriceOre: "35 000",
        startStockOre: "",
        machinesPerMonth: "",
        refillMinutesPerMachineWeek: "45",
        people: "2",
        hoursPerPersonWeek: "10",
      }),
    ).toEqual({ ...BASE, machinePriceOre: 3_500_000, refillMinutesPerMachineWeek: 45 });
  });

  it("felaktiga värden avvisas med svenskt meddelande", () => {
    const r = growthPlanSchema.safeParse({
      targetMachines: "",
      machinePriceOre: "2 000 000",
      people: "0",
      hoursPerPersonWeek: "x",
    });
    expect(r.success).toBe(false);
    const fields = new Set(r.error!.issues.map((i) => String(i.path[0])));
    expect(fields).toEqual(
      new Set(["targetMachines", "machinePriceOre", "people", "hoursPerPersonWeek"]),
    );
  });
});
