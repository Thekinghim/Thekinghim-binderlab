/**
 * Produktbyte i ett Awish-fack (byggplanen V2 3.3, src/server/awish/product-swap.ts) mot
 * testdatabasen och låtsas-Awish:
 *
 * - ett fack som byter titel (A ut, B in) ger ett byte i product_swaps, A flyttas tillbaka
 *   till automatens "Fylls på från" (standardlagret) och B dras därifrån,
 * - räkningen av A stämmer då med väntat saldo: ingen svinnavvikelse,
 * - en andra synk ändrar inget,
 * - en vanlig påfyllning (samma fack, fler pack) beter sig som förut (Awish-påfyllning),
 * - första läsningen registrerar inget byte,
 * - användare kan inte skriva product_swaps.
 */

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

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  type TestUser,
} from "./helpers";

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

describe("produktbyte i ett Awish-fack", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineId: string;
  let locationId: string;
  let homeId: string;
  let now = new Date("2026-11-10T09:00:00Z");

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
          sql`select t.name, sl.quantity from public.stock_levels sl
              join public.titles t on t.id = sl.title_id
              where sl.location_id = ${loc}::uuid order by t.name`,
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
        sql`select id from public.stock_locations
            where organization_id = ${orgId}::uuid and kind = 'warehouse' and is_central`,
      )
    ).id;
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
    // Första körningen hämtar automaterna i källan (source_machines), sedan kopplas den.
    now = new Date("2026-11-10T08:55:00Z");
    await run();
    now = new Date("2026-11-10T09:00:00Z");
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '7'`,
    );
  });

  it("första läsningen registrerar inget byte", async () => {
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(await levelsAt(locationId)).toEqual({ "Black Bolt": 5, "Surging Sparks": 7 });
    const n = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.product_swaps where machine_id = ${machineId}::uuid`,
    );
    expect(n.n).toBe(0);
    // Hemma: 20 Paradox Rift och 10 Surging Sparks.
    await db().execute(
      sql`insert into public.titles (organization_id, name) values (${orgId}::uuid, 'Paradox Rift')`,
    );
    await db().execute(
      sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
          values (${orgId}::uuid, ${homeId}::uuid, ${await titleId("Paradox Rift")}::uuid, 'count', 20, '2026-11-10T09:10:00Z'),
                 (${orgId}::uuid, ${homeId}::uuid, ${await titleId("Surging Sparks")}::uuid, 'count', 10, '2026-11-10T09:10:00Z')`,
    );
    await db().execute(
      sql`insert into public.title_aliases (organization_id, title_id, alias)
          values (${orgId}::uuid, ${await titleId("Paradox Rift")}::uuid, 'Paradox Rift')
          on conflict do nothing`,
    );
  });

  it("A2 byts från Surging Sparks till Paradox Rift: A tillbaka hem, B ur lagret, inget svinn", async () => {
    fake.state.products["7"]![1] = { channel: "A2", good: "Paradox Rift", current: 6, capacity: 8 };
    now = new Date("2026-11-10T10:00:00Z");
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);

    expect(await levelsAt(locationId)).toEqual({
      "Black Bolt": 5,
      "Paradox Rift": 6,
      "Surging Sparks": 3,
    });
    // Hemma: Surging Sparks +4 tillbaka, Paradox Rift −6 till automaten.
    expect(await levelsAt(homeId)).toMatchObject({ "Paradox Rift": 14, "Surging Sparks": 14 });

    const swaps = await rows<{
      channel: string;
      from_name: string;
      to_name: string;
      returned_units: number;
      taken_units: number;
      source_location_id: string;
      transfer_group_id: string | null;
    }>(
      db(),
      sql`select w.channel, f.name as from_name, t.name as to_name, w.returned_units,
                 w.taken_units, w.source_location_id::text as source_location_id,
                 w.transfer_group_id::text as transfer_group_id
          from public.product_swaps w
          join public.titles f on f.id = w.from_title_id
          join public.titles t on t.id = w.to_title_id
          where w.machine_id = ${machineId}::uuid`,
    );
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({
      channel: "A2",
      from_name: "Surging Sparks",
      to_name: "Paradox Rift",
      returned_units: 4,
      taken_units: 6,
      source_location_id: homeId,
    });
    expect(swaps[0]!.transfer_group_id).not.toBeNull();

    const notes = await rows<{ kind: string; quantity: number; note: string }>(
      db(),
      sql`select kind::text as kind, quantity, note from public.stock_events
          where organization_id = ${orgId}::uuid and note like 'Produktbyte%' order by kind, quantity`,
    );
    expect(notes).toEqual([
      { kind: "adjustment", quantity: -6, note: "Produktbyte A2: Surging Sparks → Paradox Rift" },
      { kind: "transfer_in", quantity: 4, note: "Produktbyte A2: Surging Sparks → Paradox Rift" },
      { kind: "transfer_out", quantity: -4, note: "Produktbyte A2: Surging Sparks → Paradox Rift" },
    ]);

    // Svinnkontrollen: räkningen av Surging Sparks (3) stämmer med väntat saldo.
    const shrink = await db().transaction((tx) =>
      queryShrinkage(tx, orgId, { start: "2026-11-01", end: "2026-11-30" } as never),
    );
    const ss = await titleId("Surging Sparks");
    const row = shrink.find((x) => x.titleId === ss);
    expect(row?.deviation ?? 0).toBe(0);
  });

  it("en andra synk ändrar inget", async () => {
    now = new Date("2026-11-10T10:05:00Z");
    const before = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events where organization_id = ${orgId}::uuid`,
    );
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    const after = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events where organization_id = ${orgId}::uuid`,
    );
    expect(after.n).toBe(before.n);
    const n = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.product_swaps where machine_id = ${machineId}::uuid`,
    );
    expect(n.n).toBe(1);
  });

  it("en vanlig påfyllning (samma fack, fler pack) drar som förut", async () => {
    fake.state.products["7"]![0] = {
      channel: "A1",
      good: "Surging Sparks",
      current: 8,
      capacity: 8,
    };
    now = new Date("2026-11-10T10:10:00Z");
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect((await levelsAt(locationId))["Surging Sparks"]).toBe(8);
    expect((await levelsAt(homeId))["Surging Sparks"]).toBe(9);
    const n = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.product_swaps where machine_id = ${machineId}::uuid`,
    );
    expect(n.n).toBe(1);
  });

  it("användare kan inte skriva product_swaps, men alla roller läser", async () => {
    const refiller = await createMember(orgId, "refiller");
    const ss = await titleId("Surging Sparks");
    const pr = await titleId("Paradox Rift");
    const forged = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.product_swaps
                (organization_id, machine_id, channel, from_title_id, to_title_id, returned_units, taken_units, occurred_at)
              values (${orgId}::uuid, ${machineId}::uuid, 'B1', ${ss}::uuid, ${pr}::uuid, 1, 1, now())`,
        ),
      ),
    );
    expect(forged.ok).toBe(false);
    const seen = await asUser(refiller, (tx) =>
      rows(tx, sql`select id from public.product_swaps where machine_id = ${machineId}::uuid`),
    );
    expect(seen).toHaveLength(1);
  });
  it("Det var ett produktbyte: ett gammalt byte som räknats som svinn rättas en gång", async () => {
    // Före rättningen: Awish visade 2 färre Black Bolt (bytet räknades som svinn).
    const bb = await titleId("Black Bolt");
    await db().execute(
      sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, source)
          values (${orgId}::uuid, ${locationId}::uuid, ${bb}::uuid, 'count', 3, '2026-11-10T11:00:00Z', 'awish')`,
    );
    const deviation = async () => {
      const rows = await db().transaction((tx) =>
        queryShrinkage(tx, orgId, { start: "2026-11-01", end: "2026-11-30" } as never),
      );
      return rows.find((x) => x.titleId === bb)?.deviation ?? 0;
    };
    expect(await deviation()).toBe(-2);
    const homeBefore = (await levelsAt(homeId))["Black Bolt"] ?? 0;

    const viewer = await viewerFor(owner, orgId);
    const refiller = await createMember(orgId, "refiller");
    await expect(
      correctProductSwapFor(await viewerFor(refiller, orgId), {
        machineId,
        titleId: bb,
        quantity: 2,
      }),
    ).rejects.toThrow();
    const res = await correctProductSwapFor(viewer, { machineId, titleId: bb, quantity: 2 });
    expect(res).toEqual({ ok: true, data: { quantity: 2 } });
    expect(await deviation()).toBe(0);
    expect((await levelsAt(homeId))["Black Bolt"] ?? 0).toBe(homeBefore + 2);
    expect((await levelsAt(locationId))["Black Bolt"]).toBe(3);
    const again = await correctProductSwapFor(viewer, { machineId, titleId: bb, quantity: 2 });
    expect(again.ok).toBe(false);
  });
});
