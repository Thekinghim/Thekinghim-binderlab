/**
 * Lager: larmgräns per automat och titel (slot_alerts) och svinn, mot testdatabasen.
 *
 * - Gränsen 10 och saldot 10 ger en påfyllningspunkt i Att göra som öppnar Lager.
 * - Ägaren sätter gränsen, påfyllaren och läsaren kan inte (koden och RLS).
 * - Svinn sänker saldot, kräver ett räknat saldo och syns i historiken.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { loadLagerFor } from "@/app/(app)/lager/_lib/data";
import { LagerError, registerWasteFor, WASTE_NEEDS_COUNT } from "@/app/(app)/lager/_lib/register";
import { wasteSchema } from "@/app/(app)/lager/_lib/schemas";
import * as s from "@/db/schema";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { loadSlotAlertsFor, setSlotAlertFor } from "@/server/data/core/slot-alerts";
import { loadRankedTodoStateFor } from "@/server/data/todos";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-03-12T09:00:00Z");
const ALL_TIME = { start: "2025-01-01", end: "2030-12-31" };
const NO_SCOPE = { storeId: null, machineId: null };

interface Fixture {
  orgId: string;
  owner: TestUser;
  machineId: string;
  /** 10 pack, inventerad. */
  titleId: string;
  /** Inget lager alls i automaten. */
  emptyTitleId: string;
}

async function seed(): Promise<Fixture> {
  const owner = await createUser(`larm-agare-${crypto.randomUUID()}@test.binderlab.se`);
  const orgId = await createOrg(owner, "Larmtest");
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Butik" })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [title, empty] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Black Bolt" },
        { ...org, name: "Tom titel" },
      ])
      .returning();
    const locations = await tx.select().from(s.stockLocations);
    const loc = locations.find((l) => l.organizationId === orgId && l.machineId === machine!.id);
    await tx.insert(s.stockEvents).values({
      ...org,
      locationId: loc!.id,
      titleId: title!.id,
      kind: "count",
      quantity: 10,
      occurredAt: new Date("2025-03-05T08:00:00Z"),
    });
    return { orgId, owner, machineId: machine!.id, titleId: title!.id, emptyTitleId: empty!.id };
  });
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fx: Fixture;
let owner: Viewer;
let refiller: Viewer;
let reader: Viewer;
let refillerUser: TestUser;
let outsider: Viewer;

beforeAll(async () => {
  fx = await seed();
  owner = await viewerFor(fx.owner, fx.orgId);
  refillerUser = await createMember(fx.orgId, "refiller");
  refiller = await viewerFor(refillerUser, fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  const other = await seed();
  outsider = await viewerFor(other.owner, other.orgId);
});

const key = () => `refill:${fx.machineId}:${fx.titleId}`;

describe("larmgräns", () => {
  it("utan gräns: ingen påfyllningspunkt (ingen försäljning)", async () => {
    const state = await loadRankedTodoStateFor(owner, NOW);
    expect(state.items.map((t) => t.key)).not.toContain(key());
  });

  it("gräns 10 och saldo 10 ger en punkt som öppnar Lager, för ägaren och påfyllaren", async () => {
    expect(
      await setSlotAlertFor(owner, {
        machineId: fx.machineId,
        titleId: fx.titleId,
        alertAtUnits: 10,
      }),
    ).toBe(10);
    for (const v of [owner, refiller]) {
      const item = (await loadRankedTodoStateFor(v, NOW)).items.find((t) => t.key === key());
      expect(item).toMatchObject({
        detail: "Saldo 10, larmgräns 10.",
        link: `/lager?automat=${fx.machineId}&titel=${fx.titleId}`,
      });
    }
    // Läsaren har ingen Att göra.
    expect((await loadRankedTodoStateFor(reader, NOW)).items).toEqual([]);
  });

  it("fullt fack (Awish-kapacitet 10, saldo 10): ingen punkt och inte Låg, som Fyll på", async () => {
    const add = () =>
      db().execute(sql`
        insert into public.machine_slot_capacity
          (organization_id, machine_id, title_id, capacity, channels, synced_at)
        values (${fx.orgId}::uuid, ${fx.machineId}::uuid, ${fx.titleId}::uuid, 10, '{A1}',
                ${NOW.toISOString()}::timestamptz)`);
    const remove = () =>
      db().execute(sql`
        delete from public.machine_slot_capacity
        where organization_id = ${fx.orgId}::uuid and machine_id = ${fx.machineId}::uuid`);
    await add();
    try {
      for (const v of [owner, refiller]) {
        const state = await loadRankedTodoStateFor(v, NOW);
        expect(state.items.map((t) => t.key)).not.toContain(key());
      }
      const view = await loadLagerFor(owner, { period: ALL_TIME, scope: NO_SCOPE }, NOW);
      const i = view.titles.findIndex((t) => t.id === fx.titleId);
      expect(view.cells[i]?.[0]).toMatchObject({ alertAt: 10, status: "ok", onHand: 10 });
    } finally {
      await remove();
    }
    // Utan kapaciteten är punkten tillbaka.
    expect((await loadRankedTodoStateFor(owner, NOW)).items.map((t) => t.key)).toContain(key());
  });

  it("Lager visar gränsen och gör cellen Låg; bara ägare och admin får ändra", async () => {
    const view = await loadLagerFor(refiller, { period: ALL_TIME, scope: NO_SCOPE }, NOW);
    const i = view.titles.findIndex((t) => t.id === fx.titleId);
    expect(view.cells[i]?.[0]).toMatchObject({ alertAt: 10, status: "low", onHand: 10 });
    expect(view.canSetAlert).toBe(false);
    expect(
      (await loadLagerFor(owner, { period: ALL_TIME, scope: NO_SCOPE }, NOW)).canSetAlert,
    ).toBe(true);
  });

  it("påfyllaren och läsaren kan inte sätta gränsen, varken i koden eller via RLS", async () => {
    for (const v of [refiller, reader]) {
      await expect(
        setSlotAlertFor(v, { machineId: fx.machineId, titleId: fx.titleId, alertAtUnits: 3 }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }
    await asUser(refillerUser, async (tx) => {
      const insert = await attempt(tx, (sp) =>
        sp.insert(s.slotAlerts).values({
          organizationId: fx.orgId,
          machineId: fx.machineId,
          titleId: fx.emptyTitleId,
          alertAtUnits: 1,
        }),
      );
      expect(insert.ok).toBe(false);
      const updated = await tx
        .update(s.slotAlerts)
        .set({ alertAtUnits: 1 })
        .where(sql`organization_id = ${fx.orgId}`)
        .returning();
      expect(updated).toEqual([]);
    });
    expect((await loadSlotAlertsFor(refiller)).map((a) => a.alertAtUnits)).toEqual([10]);
  });

  it("en annan organisation ser inga gränser", async () => {
    expect(await loadSlotAlertsFor(outsider)).toEqual([]);
  });

  it("ändringen loggas i audit_log", async () => {
    const log = await rows<{ action: string }>(
      db(),
      sql`select action::text as action from public.audit_log
          where organization_id = ${fx.orgId} and table_name = 'slot_alerts'`,
    );
    expect(log.length).toBeGreaterThan(0);
  });

  it("databasen avvisar en gräns utanför 0–10 000", async () => {
    await asUser(fx.owner, async (tx) => {
      const bad = await attempt(tx, (sp) =>
        sp.insert(s.slotAlerts).values({
          organizationId: fx.orgId,
          machineId: fx.machineId,
          titleId: fx.emptyTitleId,
          alertAtUnits: 10_001,
        }),
      );
      expect(bad.ok).toBe(false);
    });
  });

  it("null tar bort gränsen och punkten", async () => {
    await setSlotAlertFor(owner, {
      machineId: fx.machineId,
      titleId: fx.titleId,
      alertAtUnits: null,
    });
    expect(await loadSlotAlertsFor(owner)).toEqual([]);
    const state = await loadRankedTodoStateFor(owner, NOW);
    expect(state.items.map((t) => t.key)).not.toContain(key());
  });
});

describe("svinn", () => {
  it("påfyllaren registrerar svinn: saldot sjunker och raden syns i historiken", async () => {
    const res = await registerWasteFor(refiller, {
      machineId: fx.machineId,
      titleId: fx.titleId,
      quantity: 2,
      note: "Trasig förpackning",
    });
    expect(res).toMatchObject({ previous: 10, onHand: 8 });
    const view = await loadLagerFor(owner, { period: ALL_TIME, scope: NO_SCOPE }, new Date());
    const waste = view.history.find((h) => h.kind === "waste");
    expect(waste).toMatchObject({ quantity: -2, titleId: fx.titleId });
  });

  it("spärras utan räknat saldo och kan inte ta saldot under 0", async () => {
    await expect(
      registerWasteFor(refiller, {
        machineId: fx.machineId,
        titleId: fx.emptyTitleId,
        quantity: 1,
        note: "x",
      }),
    ).rejects.toThrow(WASTE_NEEDS_COUNT);
    await expect(
      registerWasteFor(refiller, {
        machineId: fx.machineId,
        titleId: fx.titleId,
        quantity: 9,
        note: "x",
      }),
    ).rejects.toBeInstanceOf(LagerError);
  });

  it("läsaren kan inte registrera svinn, och orsaken är obligatorisk", async () => {
    await expect(
      registerWasteFor(reader, {
        machineId: fx.machineId,
        titleId: fx.titleId,
        quantity: 1,
        note: "x",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(
      wasteSchema.safeParse({
        machineId: fx.machineId,
        titleId: fx.titleId,
        quantity: 1,
        note: " ",
      }).success,
    ).toBe(false);
  });
});
