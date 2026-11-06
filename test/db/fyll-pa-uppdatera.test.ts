/**
 * Uppdatera i Fyll på (refreshFillStockFor, server action refreshFill) mot testdatabasen
 * och låtsas-Awish:
 *
 * - påfyllaren (och ägaren) läser facken i Awish nu: nytt antal i stock_locations.awish_fill
 *   och awish_synced_at, utan order och utan Machines,
 * - spärr per organisation: ett nytt tryck inom 20 s läser inte Awish (throttled), efter
 *   spärren läses det igen; en pågående synk (låset) ger busy,
 * - Awish som inte svarar ger failed och senaste läsningen, och låset släpps,
 * - läsaren och en utomstående nekas och ändrar inget; en organisation utan Awish-källa
 *   får "none".
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { refreshFillStockFor } from "../../src/server/awish/fill-read";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { parseState, syncAwishSource } from "../../src/server/awish/sync";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";

import { asUser, createMember, createOrg, createUser, db, one, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeAwish;
let down = false;
const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
  createAwishClient(creds, {
    // "Nere": en port där ingen svarar.
    address: down ? "127.0.0.1:1" : fake.address,
    tls: false,
    sleep: async () => {},
    maxAttempts: 1,
    deadlineMs: 2_000,
  });

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [{ id: "9", name: "Sega gubben", machine_no: "163279xx" }],
    orders: [],
    products: {
      "9": [
        { channel: "A1", good: "Surging Sparks", current: 3, capacity: 6 },
        { channel: "A2", good: "Surging Sparks", current: 0, capacity: 6 },
      ],
    },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("Uppdatera i Fyll på", () => {
  let owner: TestUser;
  let refiller: TestUser;
  let viewer: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineId: string;
  let now = new Date("2026-11-06T13:00:00Z");
  const clock = () => now;

  const refresh = (u: TestUser) =>
    viewerFor(u, orgId).then((v) =>
      refreshFillStockFor(v, { serviceDb: db(), connect, now: clock }),
    );
  const fill = async () =>
    one<{ fill: { units: number }[] | null; at: Date | null }>(
      db(),
      sql`select awish_fill as fill, awish_synced_at as at from public.stock_locations
          where machine_id = ${machineId}::uuid`,
    );
  const calls = (method: string) => fake.state.calls.filter((c) => c.method === method).length;
  const state = async () =>
    parseState(
      (
        await one<{ cursor: string | null }>(
          db(),
          sql`select cursor from public.data_sources where id = ${sourceId}::uuid`,
        )
      ).cursor,
    );

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    refiller = await createMember(orgId, "refiller");
    viewer = await createMember(orgId, "viewer");
    const [m] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-009",
          name: "Automat 9",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    machineId = m!.id;
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
    // Första synken skapar källautomaten; den kopplas sedan till automaten.
    const first = await syncAwishSource(
      { db: db(), connect, now: clock },
      { dataSourceId: sourceId, trigger: "manual" },
    );
    expect(first.ok, first.message ?? "").toBe(true);
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '9'`,
    );
  });

  it("påfyllaren läser facken nu: nytt antal och tidpunkt, inga order", async () => {
    now = new Date("2026-11-06T13:10:00Z");
    const orders = calls("Orders");
    const machines = calls("Machines");
    const r = await refresh(refiller);
    expect(r).toEqual({ status: "read", lastReadAt: now.toISOString() });
    const f = await fill();
    expect(f.fill?.reduce((n, e) => n + e.units, 0)).toBe(3);
    expect(new Date(f.at!).toISOString()).toBe(now.toISOString());
    expect(calls("Orders")).toBe(orders);
    expect(calls("Machines")).toBe(machines);
    const st = await state();
    expect(st.leaseUntil).toBeNull();
    expect(st.fillReadAt).toBe(now.toISOString());
    expect(st.stockSyncedAt).toBe(now.toISOString());
  });

  it("inom 20 s läses Awish inte igen (spärr per organisation); efter spärren läses det", async () => {
    fake.state.products["9"]![1]!.current = 4;
    const products = calls("Products");
    now = new Date("2026-11-06T13:10:15Z");
    // Ägaren (en annan person i samma organisation) spärras också.
    expect((await refresh(owner)).status).toBe("throttled");
    expect(calls("Products")).toBe(products);
    expect((await fill()).fill?.reduce((n, e) => n + e.units, 0)).toBe(3);

    now = new Date("2026-11-06T13:10:21Z");
    const r = await refresh(refiller);
    expect(r.status).toBe("read");
    expect(calls("Products")).toBe(products + 1);
    expect((await fill()).fill?.reduce((n, e) => n + e.units, 0)).toBe(7);
  });

  it("två tryck samtidigt ger en läsning", async () => {
    now = new Date("2026-11-06T13:12:00Z");
    const products = calls("Products");
    const both = await Promise.all([refresh(refiller), refresh(owner)]);
    expect(both.filter((r) => r.status === "read")).toHaveLength(1);
    expect(calls("Products")).toBe(products + 1);
  });

  it("en pågående synk (låset) ger busy och läser inte", async () => {
    now = new Date("2026-11-06T13:20:00Z");
    const st = await state();
    await db().execute(
      sql`update public.data_sources
          set cursor = ${JSON.stringify({ ...st, leaseUntil: "2026-11-06T13:21:00.000Z" })}
          where id = ${sourceId}::uuid`,
    );
    const products = calls("Products");
    expect((await refresh(refiller)).status).toBe("busy");
    expect(calls("Products")).toBe(products);
    await db().execute(
      sql`update public.data_sources set cursor = ${JSON.stringify(st)} where id = ${sourceId}::uuid`,
    );
  });

  it("Awish svarar inte: failed med senaste läsningen, och låset släpps", async () => {
    now = new Date("2026-11-06T13:30:00Z");
    const before = await fill();
    down = true;
    try {
      const r = await refresh(refiller);
      expect(r.status).toBe("failed");
      expect(r.lastReadAt).toBe(new Date(before.at!).toISOString());
    } finally {
      down = false;
    }
    expect((await state()).leaseUntil).toBeNull();
    expect(new Date((await fill()).at!).toISOString()).toBe(new Date(before.at!).toISOString());
  });

  it("läsaren nekas och ändrar inget", async () => {
    now = new Date("2026-11-06T13:40:00Z");
    const products = calls("Products");
    const before = JSON.stringify(await state());
    await expect(refresh(viewer)).rejects.toMatchObject({ name: "AuthorizationError" });
    expect(calls("Products")).toBe(products);
    expect(JSON.stringify(await state())).toBe(before);
  });

  it("en utomstående når inte organisationen; utan Awish-källa: none", async () => {
    const outsider = await createUser();
    const otherOrg = await createOrg(outsider);
    // Utomstående med organisationen A:s id: inget medlemskap, nekas.
    await expect(
      refreshFillStockFor(
        {
          user: { userId: outsider.id, email: outsider.email },
          organization: (await viewerFor(owner, orgId)).organization,
        },
        { serviceDb: db(), connect, now: clock },
      ),
    ).rejects.toMatchObject({ name: "AuthorizationError" });
    // I sin egen organisation (utan Awish API-källa) läses inget.
    const products = calls("Products");
    const r = await refreshFillStockFor(await viewerFor(outsider, otherOrg), {
      serviceDb: db(),
      connect,
      now: clock,
    });
    expect(r).toEqual({ status: "none", lastReadAt: null });
    expect(calls("Products")).toBe(products);
  });
});
