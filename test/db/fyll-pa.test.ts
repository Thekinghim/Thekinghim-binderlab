/**
 * Fyll på mot testdatabasen (binderlab_test_feat) och låtsas-Awish:
 *
 * - Awish-synken sparar facken per titel (pack, kapacitet, tomma fack) i
 *   stock_locations.awish_fill; klientroller kan inte skriva den,
 * - laddaren ger påfyllaren automaterna med nu/kapacitet, hemma och förslaget,
 * - Klar (syncRefillsFor, samma väg som server action syncRefills och kön) drar packen ur
 *   vårt lager direkt, och nästa Awish-synk drar inget en gång till (delta 0),
 * - samma klient-id igen blir "duplicate" (kön kan skicka om utan att det blir dubbelt),
 * - fler pack än hemma: resten registreras utan uttag, och Awish drar inte heller dem,
 * - läsaren får varken läsa Fyll på eller registrera.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { syncAwishSource } from "../../src/server/awish/sync";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";
import { syncRefillsFor } from "../../src/server/data/field-refills";
import { loadFillDataFor } from "../../src/app/fyll-pa/_lib/data";
import { setHomeCountFor } from "../../src/app/(app)/vart-lager/_lib/register";

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
    machines: [{ id: "7", name: "Sega gubben", machine_no: "163277xx" }],
    orders: [],
    products: {
      "7": [
        { channel: "A1", good: "Surging Sparks", current: 3, capacity: 6 },
        { channel: "A2", good: "Surging Sparks", current: 0, capacity: 6 },
        { channel: "B1", good: "Black Bolt", current: 2, capacity: 8 },
      ],
    },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("Fyll på: påfyllning vid automaten", () => {
  let owner: TestUser;
  let refiller: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineId: string;
  let centralId: string;
  let surging: string;
  let black: string;

  const run = () =>
    syncAwishSource(
      { db: db(), connect, now: () => new Date() },
      { dataSourceId: sourceId, trigger: "manual" },
    );
  const level = async (location: string, titleId: string) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${location}::uuid and title_id = ${titleId}::uuid`,
      )
    )[0]?.q ?? 0;
  const machineLocation = async () =>
    (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
      )
    ).id;
  const setCurrent = (channel: string, current: number) => {
    fake.state.products["7"]!.find((p) => p.channel === channel)!.current = current;
  };
  const item = (titleId: string, quantity: number, fromWarehouse = true) => ({
    clientId: randomUUID(),
    machineId,
    titleId,
    quantity,
    fromWarehouse,
    occurredAt: new Date().toISOString(),
    note: "Fyll på",
  });

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    refiller = await createMember(orgId, "refiller");
    const [m] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-007",
          name: "Automat 7",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    machineId = m!.id;
    await asUser(owner, async (tx) => {
      const [store] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Sega gubben" })
        .returning();
      await tx.insert(s.machinePlacements).values({
        organizationId: orgId,
        machineId,
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
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
    expect((await run()).ok).toBe(true);
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '7'`,
    );
    const first = await run();
    expect(first.ok, first.message ?? "").toBe(true);
    const title = async (name: string) =>
      (
        await one<{ id: string }>(
          db(),
          sql`select id from public.titles where organization_id = ${orgId}::uuid and name = ${name}`,
        )
      ).id;
    surging = await title("Surging Sparks");
    black = await title("Black Bolt");
    const ov = await viewerFor(owner, orgId);
    await setHomeCountFor(ov, { titleId: surging, counted: 40 });
    await setHomeCountFor(ov, { titleId: black, counted: 2 });
  });

  it("synken sparar facken per titel; klientroller kan inte skriva dem", async () => {
    const { fill } = await one<{ fill: unknown }>(
      db(),
      sql`select awish_fill as fill from public.stock_locations where machine_id = ${machineId}::uuid`,
    );
    expect(
      (fill as { title_id: string }[]).sort((a, b) => (a.title_id < b.title_id ? -1 : 1)),
    ).toEqual(
      [
        { title_id: surging, units: 3, capacity: 12, channels: 2, empty: 1 },
        { title_id: black, units: 2, capacity: 8, channels: 1, empty: 0 },
      ].sort((a, b) => (a.title_id < b.title_id ? -1 : 1)),
    );
    const err = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.stock_locations set awish_fill = '[]'::jsonb
              where machine_id = ${machineId}::uuid`,
        ),
      ),
    );
    expect(err).toMatchObject({ ok: false, code: "42501" });
  });

  it("påfyllaren ser automaten med nu/kapacitet, hemma och förslaget", async () => {
    const data = await loadFillDataFor(await viewerFor(refiller, orgId));
    expect(data.hasWarehouse).toBe(true);
    const [m] = data.machines;
    expect(m).toMatchObject({ code: "BL-007", place: "Sega gubben", emptySlots: 1 });
    expect(m!.fillPct).toBe(25); // 5 av 20
    const byName = new Map(m!.rows.map((r) => [r.name, r]));
    expect(byName.get("Surging Sparks")).toMatchObject({
      now: 3,
      capacity: 12,
      home: 40,
      suggested: 9,
      emptySlots: 1,
    });
    // Förslaget begränsas av packen hemma: 6 plats, 2 hemma.
    expect(byName.get("Black Bolt")).toMatchObject({ now: 2, capacity: 8, home: 2, suggested: 2 });
    expect(data.home[surging]).toBe(40);
  });

  it("Klar drar ur vårt lager direkt, och Awish-synken drar inget en gång till", async () => {
    const rv = await viewerFor(refiller, orgId);
    const refill = item(surging, 9);
    const res = await syncRefillsFor(rv, [refill]);
    expect(res.results).toEqual([{ clientId: refill.clientId, status: "saved" }]);
    const loc = await machineLocation();
    expect(await level(centralId, surging)).toBe(31);
    expect(await level(loc, surging)).toBe(12);

    // Kön skickar samma påfyllning igen (svaret kom aldrig fram): inget nytt.
    const again = await syncRefillsFor(rv, [refill]);
    expect(again.results[0]?.status).toBe("duplicate");
    expect(await level(centralId, surging)).toBe(31);

    // Automaten är full enligt Awish: samma antal som saldot, delta 0.
    setCurrent("A1", 6);
    setCurrent("A2", 6);
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.stock).toMatchObject({ warehouseOut: 0 });
    expect(await level(centralId, surging)).toBe(31);
    expect(await level(loc, surging)).toBe(12);
    const awishOut = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events
          where location_id = ${centralId}::uuid and source = 'awish'`,
    );
    expect(awishOut[0]?.n).toBe(0);

    const data = await loadFillDataFor(rv);
    const row = data.machines[0]!.rows.find((x) => x.titleId === surging)!;
    expect(row).toMatchObject({ now: 12, capacity: 12, home: 31, suggested: 0, emptySlots: 0 });
  });

  it("fler pack än hemma: resten utan uttag, och Awish drar inte heller dem", async () => {
    const rv = await viewerFor(refiller, orgId);
    // 6 Black Bolt i automaten men 2 hemma: 2 från vårt lager, 4 utan uttag (som Fyll på).
    const res = await syncRefillsFor(rv, [item(black, 2, true), item(black, 4, false)]);
    expect(res.results.map((x) => x.status)).toEqual(["saved", "saved"]);
    expect(await level(centralId, black)).toBe(0);
    setCurrent("B1", 8);
    const r = await run();
    expect(r.stock).toMatchObject({ warehouseOut: 0 });
    expect(await level(centralId, black)).toBe(0);
    expect(await level(await machineLocation(), black)).toBe(8);

    // Från vårt lager utan pack hemma avvisas med ett svenskt meddelande.
    const rejected = await syncRefillsFor(rv, [item(black, 1, true)]);
    expect(rejected.results[0]).toMatchObject({ status: "rejected" });
    expect(rejected.results[0]?.error).toMatch(/bara 0 pack/);
  });

  it("läsaren får inte läsa Fyll på eller registrera", async () => {
    const reader = await createMember(orgId, "viewer");
    const v = await viewerFor(reader, orgId);
    await expect(loadFillDataFor(v)).rejects.toThrow();
    await expect(syncRefillsFor(v, [item(surging, 1)])).rejects.toThrow();
    expect(await level(centralId, surging)).toBe(31);
  });
});
