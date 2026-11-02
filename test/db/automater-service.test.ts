/**
 * Automater (src/app/(app)/automater/_lib/service.ts) mot testdatabasen: läsning av
 * order per automat, ny automat, redigering, flytt, avveckling och återaktivering,
 * behörighet (läsare och påfyllare får inte ändra, påfyllaren får inga order),
 * stängda månader och att ändringarna loggas i audit_log.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createMachineFor,
  decommissionMachineFor,
  loadLastOrderAtFor,
  loadMachineOrdersFor,
  moveMachineFor,
  reactivateMachineFor,
  updateMachineFor,
  type Viewer,
} from "../../src/app/(app)/automater/_lib/service";
import * as s from "../../src/db/schema";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

interface Fixture {
  orgId: string;
  owner: TestUser;
  storeId: string;
  machineId: string;
}

/**
 * Egen liten fixtur (som ägaren, genom RLS): en butik, BL-001 placerad där sedan
 * 1 jan. 2025, två order 10 och 11 mars 2025, och december 2024 stängd.
 */
async function seedFixture(): Promise<Fixture> {
  const owner = await createUser(`am-owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Automater ${uniqueSuffix()}`);
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "ICA Testbutik" })
      .returning();
    const [m] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: m!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Surging Sparks" })
      .returning();
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    await tx.insert(s.orders).values(
      ["2025-03-10T10:00:00Z", "2025-03-11T10:00:00Z"].map((at, i) => ({
        ...org,
        dataSourceId: source!.id,
        externalId: `4200${i}`,
        rawTitle: "Surging Sparks",
        titleId: title!.id,
        orderedAt: new Date(at),
        amountOre: 8900,
        paymentMethod: "card",
        machineId: m!.id,
        sourceHash: `h${i}`,
      })),
    );
    await tx.execute(sql`select public.close_period(${orgId}, '2024-12-01'::date)`);
    return { orgId, owner, storeId: store!.id, machineId: m!.id };
  });
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let F: Fixture;
let owner: Viewer;
let reader: Viewer;
let refiller: Viewer;
let secondStoreId: string;

beforeAll(async () => {
  F = await seedFixture();
  owner = await viewerFor(F.owner, F.orgId);
  reader = await viewerFor(await createMember(F.orgId, "viewer"), F.orgId);
  refiller = await viewerFor(await createMember(F.orgId, "refiller"), F.orgId);
  const [store] = await asUser(F.owner, (tx) =>
    tx
      .insert(s.stores)
      .values({ organizationId: F.orgId, name: "Gallerian Väst" })
      .returning({ id: s.stores.id }),
  );
  secondStoreId = store!.id;
});

async function machine(id: string) {
  const [m] = await rows<{
    code: string;
    name: string;
    active_from: string | null;
    active_to: string | null;
    serial: string | null;
  }>(
    db(),
    sql`select code, name, serial, active_from::text, active_to::text from public.machines where id = ${id}`,
  );
  return m!;
}

async function placements(machineId: string) {
  return rows<{
    store_id: string;
    valid_from: string;
    valid_to: string | null;
    note: string | null;
  }>(
    db(),
    sql`select store_id, valid_from::text, valid_to::text, note from public.machine_placements
        where machine_id = ${machineId} order by valid_from`,
  );
}

describe("läsning", () => {
  it("ägare och läsare får senaste order per automat; påfyllaren nekas", async () => {
    const last = await loadLastOrderAtFor(owner);
    expect(last.get(F.machineId)).toBe("2025-03-11T10:00:00.000Z");
    expect((await loadLastOrderAtFor(reader)).get(F.machineId)).toBeDefined();
    await expect(loadLastOrderAtFor(refiller)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("första och sista orderdag och de senaste orderna med titelns namn", async () => {
    const r = await loadMachineOrdersFor(owner, F.machineId);
    expect(r.firstOrderDate).toBe("2025-03-10");
    expect(r.lastOrderDate).toBe("2025-03-11");
    expect(r.recent.map((o) => [o.orderedAt, o.titleName, o.amountOre])).toEqual([
      ["2025-03-11T10:00:00.000Z", "Surging Sparks", 8900],
      ["2025-03-10T10:00:00.000Z", "Surging Sparks", 8900],
    ]);
    await expect(loadMachineOrdersFor(refiller, F.machineId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("ny automat", () => {
  it("ägaren lägger till en automat med placering; lagerplats skapas och ändringen loggas", async () => {
    const r = await createMachineFor(owner, {
      code: " bl-002 ",
      name: "Automat 2",
      serial: "SN-2",
      activeFrom: "2025-05-01",
      storeId: secondStoreId,
    });
    expect(r).toMatchObject({ ok: true, data: { code: "BL-002" } });
    const id = r.data!.id;
    expect(await machine(id)).toMatchObject({
      code: "BL-002",
      name: "Automat 2",
      serial: "SN-2",
      active_from: "2025-05-01",
    });
    expect(await placements(id)).toEqual([
      { store_id: secondStoreId, valid_from: "2025-05-01", valid_to: null, note: null },
    ]);
    const [loc] = await rows(
      db(),
      sql`select id from public.stock_locations where machine_id = ${id}`,
    );
    expect(loc).toBeDefined();
    const audit = await rows<{ action: string; actor_id: string }>(
      db(),
      sql`select action::text, actor_id from public.audit_log
          where table_name = 'machines' and row_id = ${id}`,
    );
    expect(audit).toEqual([{ action: "insert", actor_id: F.owner.id }]);
  });

  it("samma kod två gånger nekas med ett begripligt fel", async () => {
    const r = await createMachineFor(owner, {
      code: "BL-002",
      name: "Igen",
      activeFrom: "2025-05-01",
    });
    expect(r).toEqual({ ok: false, error: "Det finns redan en automat med koden BL-002." });
  });

  it("ogiltig kod nekas före databasen", async () => {
    const r = await createMachineFor(owner, { code: "BL 9", name: "X", activeFrom: "2025-05-01" });
    expect(r.ok).toBe(false);
  });

  it("läsare och påfyllare får inte lägga till", async () => {
    for (const v of [reader, refiller]) {
      const r = await createMachineFor(v, { code: "BL-099", name: "X", activeFrom: "2025-05-01" });
      expect(r).toEqual({ ok: false, error: "Bara ägare och admin kan ändra automater." });
    }
    const [m] = await rows(
      db(),
      sql`select id from public.machines where organization_id = ${F.orgId} and code = 'BL-099'`,
    );
    expect(m).toBeUndefined();
  });

  it("en placering i en stängd månad stoppas av databasen och hela ändringen rullas tillbaka", async () => {
    const r = await createMachineFor(owner, {
      code: "BL-050",
      name: "I stängd månad",
      activeFrom: "2024-12-10",
      storeId: secondStoreId,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    const [m] = await rows(
      db(),
      sql`select id from public.machines where organization_id = ${F.orgId} and code = 'BL-050'`,
    );
    expect(m).toBeUndefined();
  });
});

describe("redigera", () => {
  it("namn och serienummer ändras; driftstart efter första ordern nekas", async () => {
    expect(
      await updateMachineFor(owner, {
        machineId: F.machineId,
        name: "Automat Ett",
        serial: "",
        activeFrom: "2025-01-01",
      }),
    ).toEqual({ ok: true });
    expect(await machine(F.machineId)).toMatchObject({ name: "Automat Ett", serial: null });

    const r = await updateMachineFor(owner, {
      machineId: F.machineId,
      name: "Automat Ett",
      activeFrom: "2025-04-01",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^BL-001 har order från 10.mars/);
  });

  it("läsaren får inte redigera", async () => {
    const r = await updateMachineFor(reader, {
      machineId: F.machineId,
      name: "Hack",
      activeFrom: "2025-01-01",
    });
    expect(r.ok).toBe(false);
    expect((await machine(F.machineId)).name).toBe("Automat Ett");
  });
});

describe("flytt, avveckling och återaktivering", () => {
  it("flytt avslutar placeringen dagen före och lägger till den nya", async () => {
    const r = await moveMachineFor(owner, {
      machineId: F.machineId,
      storeId: secondStoreId,
      from: "2025-07-01",
      note: "Bättre läge",
    });
    expect(r).toEqual({ ok: true });
    expect(await placements(F.machineId)).toEqual([
      { store_id: F.storeId, valid_from: "2025-01-01", valid_to: "2025-06-30", note: null },
      { store_id: secondStoreId, valid_from: "2025-07-01", valid_to: null, note: "Bättre läge" },
    ]);
    const audit = await rows(
      db(),
      sql`select 1 from public.audit_log
          where table_name = 'machine_placements' and organization_id = ${F.orgId}
            and actor_id = ${F.owner.id}`,
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("flytt till samma butik och före senaste placeringen nekas", async () => {
    const same = await moveMachineFor(owner, {
      machineId: F.machineId,
      storeId: secondStoreId,
      from: "2025-08-01",
    });
    expect(same.ok).toBe(false);
    expect(same.error).toContain("står redan i Gallerian Väst");
    const before = await moveMachineFor(owner, {
      machineId: F.machineId,
      storeId: F.storeId,
      from: "2025-06-15",
    });
    expect(before.ok).toBe(false);
  });

  it("avveckling före sista ordern nekas; annars sätts sista dag och placeringen avslutas", async () => {
    const early = await decommissionMachineFor(owner, {
      machineId: F.machineId,
      activeTo: "2025-03-01",
    });
    expect(early.ok).toBe(false);
    expect(early.error).toMatch(/har order till 11.mars/);

    expect(
      await decommissionMachineFor(owner, { machineId: F.machineId, activeTo: "2025-09-30" }),
    ).toEqual({ ok: true });
    expect((await machine(F.machineId)).active_to).toBe("2025-09-30");
    expect((await placements(F.machineId)).at(-1)).toMatchObject({ valid_to: "2025-09-30" });
    // Historiken finns kvar.
    expect(await placements(F.machineId)).toHaveLength(2);
    const r = await loadMachineOrdersFor(owner, F.machineId);
    expect(r.lastOrderDate).toBe("2025-03-11");

    const audit = await rows<{
      before: { active_to: string | null };
      after: { active_to: string | null };
    }>(
      db(),
      sql`select before, after from public.audit_log
          where table_name = 'machines' and row_id = ${F.machineId} and action = 'update'
          order by occurred_at desc limit 1`,
    );
    expect(audit[0]?.after.active_to).toBe("2025-09-30");
  });

  it("en avvecklad automat kan inte flyttas efter sista dagen men kan återaktiveras", async () => {
    const move = await moveMachineFor(owner, {
      machineId: F.machineId,
      storeId: F.storeId,
      from: "2025-11-01",
    });
    expect(move.ok).toBe(false);
    expect(move.error).toContain("avvecklad");
    expect(await reactivateMachineFor(owner, { machineId: F.machineId })).toEqual({ ok: true });
    expect((await machine(F.machineId)).active_to).toBeNull();
    expect((await reactivateMachineFor(owner, { machineId: F.machineId })).ok).toBe(false);
  });

  it("påfyllaren får varken flytta eller avveckla", async () => {
    expect(
      (
        await moveMachineFor(refiller, {
          machineId: F.machineId,
          storeId: F.storeId,
          from: "2025-12-01",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await decommissionMachineFor(refiller, { machineId: F.machineId, activeTo: "2025-12-01" }))
        .ok,
    ).toBe(false);
    expect((await reactivateMachineFor(reader, { machineId: F.machineId })).ok).toBe(false);
  });

  it("en annan organisations automat går inte att ändra", async () => {
    const other = await seedFixture();
    const r = await decommissionMachineFor(owner, {
      machineId: other.machineId,
      activeTo: "2025-09-30",
    });
    expect(r).toEqual({ ok: false, error: "Automaten finns inte." });
    expect((await machine(other.machineId)).active_to).toBeNull();
  });
});
