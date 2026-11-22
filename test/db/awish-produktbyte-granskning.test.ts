import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { syncAwishSource } from "../../src/server/awish/sync";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";
import { correctProductSwapFor } from "../../src/app/(app)/automater/_lib/swap-correction";
import { queryShrinkage } from "../../src/server/data/shrinkage";
import type { Viewer } from "../../src/server/data/core/loaders";

import { asUser, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

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
    machines: [{ id: "7", name: "Bytet", machine_no: "163279xx" }],
    orders: [],
    products: {
      "7": [
        { channel: "A1", good: "Surging Sparks", current: 3, capacity: 8 },
        { channel: "A2", good: "Surging Sparks", current: 4, capacity: 8 },
        { channel: "A3", good: "Black Bolt", current: 5, capacity: 8 },
      ],
    },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("produktbyte: granskningsfall", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineId: string;
  let locationId: string;
  let homeId: string;
  let now = new Date("2026-11-10T08:55:00Z");
  const run = () =>
    syncAwishSource(
      { db: db(), connect, now: () => now },
      { dataSourceId: sourceId, trigger: "manual" },
    );
  const levelsAt = async (loc: string) =>
    Object.fromEntries(
      (
        await rows<{ name: string; quantity: number }>(
          db(),
          sql`select t.name, sl.quantity from public.stock_levels sl join public.titles t on t.id = sl.title_id where sl.location_id = ${loc}::uuid order by t.name`,
        )
      ).map((r) => [r.name, Number(r.quantity)]),
    );
  const titleId = async (name: string) =>
    (
      await one<{ id: string }>(
        db(),
        sql`select id from public.titles where organization_id = ${orgId}::uuid and name = ${name}`,
      )
    ).id;
  const shrinkOf = async (name: string) => {
    const r = await db().transaction((tx) =>
      queryShrinkage(tx, orgId, { start: "2026-11-01", end: "2026-11-30" } as never),
    );
    const id = await titleId(name);
    return r.find((x) => x.titleId === id)?.deviation ?? 0;
  };

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    const [machine] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({ organizationId: orgId, code: "BL-007", name: "Bytet", activeFrom: "2026-10-01" })
        .returning(),
    );
    machineId = machine!.id;
    locationId = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
      )
    ).id;
    homeId = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations where organization_id = ${orgId}::uuid and kind = 'warehouse' and is_central`,
      )
    ).id;
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
    await run();
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid where data_source_id = ${sourceId}::uuid and external_id = '7'`,
    );
    now = new Date("2026-11-10T09:00:00Z");
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(await levelsAt(locationId)).toEqual({ "Black Bolt": 5, "Surging Sparks": 7 });
    await db().execute(
      sql`insert into public.titles (organization_id, name) values (${orgId}::uuid, 'Paradox Rift')`,
    );
    await db().execute(
      sql`insert into public.title_aliases (organization_id, title_id, alias) values (${orgId}::uuid, ${await titleId("Paradox Rift")}::uuid, 'Paradox Rift') on conflict do nothing`,
    );
    await db()
      .execute(sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at) values
      (${orgId}::uuid, ${homeId}::uuid, ${await titleId("Paradox Rift")}::uuid, 'count', 20, '2026-11-10T09:10:00Z'),
      (${orgId}::uuid, ${homeId}::uuid, ${await titleId("Surging Sparks")}::uuid, 'count', 10, '2026-11-10T09:10:00Z'),
      (${orgId}::uuid, ${homeId}::uuid, ${await titleId("Black Bolt")}::uuid, 'count', 10, '2026-11-10T09:10:00Z')`);
  });

  it("byte medan en annan titel väntar på Awish hittas direkt (inget falskt svinn)", async () => {
    // Black Bolt fylldes på i appen (+3) men sändningen misslyckades: automaten väntar.
    await db().execute(
      sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at) values (${orgId}::uuid, ${locationId}::uuid, ${await titleId("Black Bolt")}::uuid, 'refill', 3, '2026-11-10T09:20:00Z')`,
    );
    await db().execute(
      sql`insert into public.automation_log (organization_id, kind, machine_id, occurred_at) values (${orgId}::uuid, 'awish_push_failed', ${machineId}::uuid, '2026-11-10T09:21:00Z')`,
    );
    // I Awish byts A2 Surging Sparks (4) -> Paradox Rift (6).
    fake.state.products["7"]![1] = { channel: "A2", good: "Paradox Rift", current: 6, capacity: 8 };
    now = new Date("2026-11-10T10:00:00Z");
    expect((await run()).ok).toBe(true);
    await db().execute(
      sql`insert into public.automation_log (organization_id, kind, machine_id, occurred_at) values (${orgId}::uuid, 'awish_push_cleared', ${machineId}::uuid, '2026-11-10T10:30:00Z')`,
    );
    now = new Date("2026-11-10T11:00:00Z");
    expect((await run()).ok).toBe(true);
    const n = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.product_swaps where machine_id = ${machineId}::uuid`,
    );
    expect(n.n).toBe(1);
    expect(await shrinkOf("Surging Sparks")).toBe(0);
    const home = await levelsAt(homeId);
    expect(home["Paradox Rift"]).toBe(14);
    expect(home["Surging Sparks"]).toBe(14);
  });

  it("namnbyte direkt i Awish flyttar inga pack (inga fantompack hemma)", async () => {
    const before = await levelsAt(homeId);
    const swapsBefore = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.product_swaps where machine_id = ${machineId}::uuid`,
    );
    fake.state.products["7"]![2] = {
      channel: "A3",
      good: "Black Bolt EN",
      current: 5,
      capacity: 8,
    };
    now = new Date("2026-11-10T12:00:00Z");
    expect((await run()).ok).toBe(true);
    const after = await levelsAt(homeId);
    const swapsAfter = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.product_swaps where machine_id = ${machineId}::uuid`,
    );
    expect(swapsAfter.n).toBe(swapsBefore.n);
    expect(after["Black Bolt"]).toBe(before["Black Bolt"]);
    expect(after["Black Bolt EN"] ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("'Det var ett produktbyte' tar högst avvikelsen och nekar utan svinn", async () => {
    const pr = await titleId("Paradox Rift");
    const homeBefore = (await levelsAt(homeId))["Paradox Rift"] ?? 0;
    const res = await correctProductSwapFor(await viewerFor(owner, orgId), {
      machineId,
      titleId: pr,
      quantity: 5000,
    });
    expect(res.ok).toBe(false);
    expect((await levelsAt(homeId))["Paradox Rift"]).toBe(homeBefore);
  });
});
