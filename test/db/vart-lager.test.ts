/**
 * Vårt lager mot testdatabasen (binderlab_test_feat) och låtsas-Awish:
 *
 * - Awish-synken drar en påfyllning ur vårt lager: ökningen i en automat som redan har
 *   lästs blir ett uttag (adjustment, source 'awish', "Awish-påfyllning <kod> <butik>"),
 * - aldrig vid första läsningen, aldrig vid minskning eller samma antal,
 * - en påfyllning registrerad i appen (från vårt lager) dras inte en gång till,
 * - två automater med samma titel ger två uttag; saldot får bli negativt,
 * - sidans laddare (antal hemma, i automaterna, senaste ändring, värde) och skrivningarna
 *   (antal hemma = inventering, + Inköp = 'receipt'); läsaren får inte skriva.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { syncAwishSource } from "../../src/server/awish/sync";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";
import { registerRefillFor } from "../../src/app/(app)/lager/_lib/register";
import { loadVartLagerFor } from "../../src/app/(app)/vart-lager/_lib/data";
import { registerReceiptFor, setHomeCountFor } from "../../src/app/(app)/vart-lager/_lib/register";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeAwish;
const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
  createAwishClient(creds, { address: fake.address, tls: false, sleep: async () => {} });

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [
      { id: "2", name: "Sega gubben", machine_no: "163271xx" },
      { id: "4", name: "Hörnan", machine_no: "163274xx" },
    ],
    orders: [],
    products: {
      "2": [
        { channel: "A1", good: "Surging Sparks", current: 3, capacity: 8 },
        { channel: "A2", good: "Black Bolt", current: 5, capacity: 8 },
      ],
      "4": [{ channel: "A1", good: "Surging Sparks", current: 2, capacity: 8 }],
    },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("Vårt lager och påfyllning enligt Awish", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineA: string;
  let machineB: string;
  let centralId: string;
  let surging: string;
  let black: string;

  // Synken räknar med riktig tid (påfyllningen i appen får dagens tid).
  const run = () =>
    syncAwishSource(
      { db: db(), connect, now: () => new Date() },
      { dataSourceId: sourceId, trigger: "manual" },
    );
  const home = async (titleId: string) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${centralId}::uuid and title_id = ${titleId}::uuid`,
      )
    )[0]?.q ?? 0;
  const awishOut = () =>
    rows<{ title_id: string; quantity: number; note: string }>(
      db(),
      sql`select title_id::text, quantity, note from public.stock_events
          where location_id = ${centralId}::uuid and source = 'awish' order by seq`,
    );
  const titleId = async (name: string) =>
    (
      await one<{ id: string }>(
        db(),
        sql`select id from public.titles where organization_id = ${orgId}::uuid and name = ${name}`,
      )
    ).id;
  const setCurrent = (machine: string, good: string, current: number) => {
    fake.state.products[machine]!.find((p) => p.good === good)!.current = current;
  };

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    const viewer = await viewerFor(owner, orgId);
    const [a, b] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values([
          { organizationId: orgId, code: "BL-001", name: "Automat 1", activeFrom: "2026-10-01" },
          { organizationId: orgId, code: "BL-002", name: "Automat 2", activeFrom: "2026-10-01" },
        ])
        .returning(),
    );
    machineA = a!.id;
    machineB = b!.id;
    await asUser(owner, async (tx) => {
      const [store] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Sega gubben" })
        .returning();
      await tx.insert(s.machinePlacements).values({
        organizationId: orgId,
        machineId: machineA,
        storeId: store!.id,
        validFrom: "2026-10-01",
      });
    });
    centralId = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations where organization_id = ${orgId}::uuid and is_central`,
      )
    ).id;
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(viewer, {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
    const first = await run();
    expect(first.ok, first.message ?? "").toBe(true);
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineA}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '2'`,
    );
  });

  it("första läsningen drar inget ur vårt lager", async () => {
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.stock).toMatchObject({ read: 1, warehouseOut: 0 });
    surging = await titleId("Surging Sparks");
    black = await titleId("Black Bolt");
    // Ägaren skriver antalet hemma.
    const viewer = await viewerFor(owner, orgId);
    await setHomeCountFor(viewer, { titleId: surging, counted: 40 });
    await setHomeCountFor(viewer, { titleId: black, counted: 4 });
    expect(await home(surging)).toBe(40);
    expect(await awishOut()).toEqual([]);
  });

  it("en ökning i automaten dras ur vårt lager, med butikens namn", async () => {
    setCurrent("2", "Surging Sparks", 15);
    const r = await run();
    expect(r.stock).toMatchObject({ read: 1, warehouseOut: 12 });
    expect(await home(surging)).toBe(28);
    expect(await awishOut()).toEqual([
      { title_id: surging, quantity: -12, note: "Awish-påfyllning BL-001 Sega gubben" },
    ]);
    // Samma antal igen: ingenting.
    const again = await run();
    expect(again.stock).toMatchObject({ warehouseOut: 0 });
    expect(await home(surging)).toBe(28);
  });

  it("minskning (försäljning) drar inget", async () => {
    setCurrent("2", "Surging Sparks", 11);
    const r = await run();
    expect(r.stock).toMatchObject({ warehouseOut: 0 });
    expect(await home(surging)).toBe(28);
  });

  it("påfyllning i appen och sedan synk: dras bara en gång", async () => {
    const viewer = await viewerFor(owner, orgId);
    // Black Bolt: inget Awish-uttag för titeln ännu (ett uttag strax före räknas av).
    await registerRefillFor(viewer, {
      machineId: machineA,
      titleId: black,
      quantity: 3,
      fromWarehouse: true,
    });
    expect(await home(black)).toBe(1);
    setCurrent("2", "Black Bolt", 8);
    const r = await run();
    expect(r.stock).toMatchObject({ warehouseOut: 0 });
    expect(await home(black)).toBe(1);
    expect(await home(surging)).toBe(28);
  });

  it("två automater med samma titel ger två uttag; vårt lager kan bli negativt", async () => {
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineB}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '4'`,
    );
    // Automat 2:s första läsning: inget uttag.
    const firstB = await run();
    expect(firstB.stock).toMatchObject({ read: 2, warehouseOut: 0 });
    setCurrent("2", "Surging Sparks", 20); // +9
    setCurrent("4", "Surging Sparks", 8); // +6
    setCurrent("2", "Black Bolt", 12); // +4, bara 1 hemma
    const r = await run();
    expect(r.stock).toMatchObject({ read: 2, warehouseOut: 19 });
    expect(await home(surging)).toBe(13);
    expect(await home(black)).toBe(-3);
    const notes = (await awishOut()).map((e) => e.note);
    expect(notes).toContain("Awish-påfyllning BL-002 Automat 2");
  });

  it("sidans laddare: rader, i automaterna, senaste ändring och Räkna om", async () => {
    await asUser(owner, (tx) =>
      tx.insert(s.purchasePrices).values({
        organizationId: orgId,
        titleId: surging,
        unitCostOre: 5000,
        validFrom: "2026-01-01",
      }),
    );
    const view = await loadVartLagerFor(await viewerFor(owner, orgId));
    expect(view.canEdit).toBe(true);
    expect(view.rows.map((r) => r.name)).toEqual(["Black Bolt", "Surging Sparks"]);
    const [bb, ss] = view.rows;
    expect(bb).toMatchObject({ home: -3, negative: true, inMachines: 12 });
    expect(ss).toMatchObject({ home: 13, inMachines: 28, valueOre: 65_000 });
    expect(ss!.latest?.automatic).toBe(true);
    expect(ss!.latest?.text).toMatch(/^−6 påfyllning Automat 2$|^−9 påfyllning Sega gubben$/);
    expect(view.totals).toMatchObject({ home: 13, valueOre: 65_000, negative: 1 });
  });

  it("antal hemma och + Inköp skrivs; läsaren får inte skriva", async () => {
    const viewer = await viewerFor(owner, orgId);
    const counted = await setHomeCountFor(viewer, { titleId: black, counted: 10 });
    expect(counted).toMatchObject({ previous: -3, onHand: 10 });
    const bought = await registerReceiptFor(viewer, { titleId: black, quantity: 24 });
    expect(bought).toMatchObject({ previous: 10, onHand: 34 });
    const kinds = await rows<{ kind: string; performed_by: string }>(
      db(),
      sql`select kind::text, performed_by::text from public.stock_events
          where location_id = ${centralId}::uuid and title_id = ${black}::uuid
            and kind in ('count', 'receipt') order by seq desc limit 2`,
    );
    expect(kinds).toEqual([
      { kind: "receipt", performed_by: owner.id },
      { kind: "count", performed_by: owner.id },
    ]);
    const audit = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${orgId}::uuid and table_name = 'stock_events'
            and actor_id = ${owner.id}::uuid`,
    );
    expect(audit.n).toBeGreaterThanOrEqual(2);
    const view = await loadVartLagerFor(viewer);
    expect(view.rows[0]?.latest?.text).toBe("+24 inköp");

    const reader = await createMember(orgId, "viewer");
    const rv = await viewerFor(reader, orgId);
    expect((await loadVartLagerFor(rv)).canEdit).toBe(false);
    await expect(setHomeCountFor(rv, { titleId: black, counted: 1 })).rejects.toThrow();
    await expect(registerReceiptFor(rv, { titleId: black, quantity: 1 })).rejects.toThrow();
    const refiller = await createMember(orgId, "refiller");
    await expect(loadVartLagerFor(await viewerFor(refiller, orgId))).rejects.toThrow();
  });
  it("synk före Klar: påfyllningen i appen räknas av mot Awish-uttaget", async () => {
    const viewer = await viewerFor(owner, orgId);
    fake.state.products["4"]!.push({ channel: "A2", good: "Prismatic", current: 2, capacity: 8 });
    expect((await run()).stock).toMatchObject({ warehouseOut: 0 });
    const prismatic = await titleId("Prismatic");
    await setHomeCountFor(viewer, { titleId: prismatic, counted: 20 });
    // Påfyllaren fyller 6, synken hinner före Klar.
    setCurrent("4", "Prismatic", 8);
    expect((await run()).stock).toMatchObject({ warehouseOut: 6 });
    expect(await home(prismatic)).toBe(14);
    await registerRefillFor(viewer, {
      machineId: machineB,
      titleId: prismatic,
      quantity: 6,
      fromWarehouse: true,
    });
    expect(await home(prismatic)).toBe(14);
    // Nästa läsning rättar automatens saldo utan nytt uttag.
    expect((await run()).stock).toMatchObject({ warehouseOut: 0 });

    // Inte från vårt lager: det Awish drog läggs tillbaka.
    setCurrent("4", "Prismatic", 12);
    expect((await run()).stock).toMatchObject({ warehouseOut: 4 });
    expect(await home(prismatic)).toBe(10);
    await registerRefillFor(viewer, {
      machineId: machineB,
      titleId: prismatic,
      quantity: 4,
      fromWarehouse: false,
    });
    expect(await home(prismatic)).toBe(14);
    // Uttagen är använda: nästa påfyllning dras som vanligt.
    await registerRefillFor(viewer, {
      machineId: machineB,
      titleId: prismatic,
      quantity: 2,
      fromWarehouse: true,
    });
    expect(await home(prismatic)).toBe(12);
  });
});
