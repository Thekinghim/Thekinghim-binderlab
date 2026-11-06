/**
 * Saldot i automaterna från Awish (Products, src/server/awish/stock.ts) mot testdatabasen
 * och låtsas-Awish:
 *
 * - en kopplad automat får inventeringar (source 'awish') per titel, sortimentet
 *   (machine_slots) och awish_synced_at; okänd vara blir en ny titel med alias,
 *   känd vara matchas som orderimporten,
 * - samma antal igen ger ingen ny händelse; ändrat antal ger en,
 * - en titel som Awish inte listar blir 0 och räknas som utgången,
 * - en tom lista ändrar inget; en okopplad automat läses inte,
 * - cron läser saldot högst var 30:e minut, "Synka nu" alltid,
 * - klientroller kan inte skriva source 'awish' eller awish_synced_at.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { syncAwishSource } from "../../src/server/awish/sync";
import {
  fakeOrder,
  startFakeAwish,
  type FakeAwish,
} from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asPostgres,
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
    machines: [
      { id: "2", name: "Sega gubben", machine_no: "163271xx" },
      { id: "3", name: "Okopplad", machine_no: "163272xx" },
    ],
    orders: [
      fakeOrder(5001, { payTime: "2026-11-02 10:00:00", title: "Surging Sparks" }),
      fakeOrder(5002, { payTime: "2026-11-02 11:00:00", title: "Surging Sparks" }),
      fakeOrder(5003, { payTime: "2026-11-02 12:00:00", title: "Paradox Rift" }),
    ],
    products: {
      "2": [
        { channel: "A1", good: "Surging Sparks", current: 3, capacity: 8 },
        { channel: "A2", good: "surging  sparks", current: 2, capacity: 8 },
        { channel: "A3", good: "Black Bolt", current: 5, capacity: 8 },
        { channel: "A4", good: null, current: 0, capacity: 8 },
      ],
      "3": [{ channel: "A1", good: "Black Bolt", current: 9, capacity: 9 }],
    },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("saldot från Awish", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineId: string;
  let locationId: string;
  let now = new Date("2026-11-02T15:30:00Z");

  const run = (trigger: "schedule" | "manual" = "manual") =>
    syncAwishSource({ db: db(), connect, now: () => now }, { dataSourceId: sourceId, trigger });
  const levels = async () =>
    Object.fromEntries(
      (
        await rows<{ name: string; quantity: number }>(
          db(),
          sql`select t.name, sl.quantity from public.stock_levels sl
              join public.titles t on t.id = sl.title_id
              where sl.location_id = ${locationId}::uuid order by t.name`,
        )
      ).map((r) => [r.name, r.quantity]),
    );
  const awishCounts = async () =>
    (
      await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.stock_events
            where location_id = ${locationId}::uuid and kind = 'count' and source = 'awish'`,
      )
    ).n;

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    const [machine] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-001",
          name: "Sega gubben",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    machineId = machine!.id;
    locationId = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
      )
    ).id;
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
  });

  it("okopplade automater läses inte", async () => {
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.stock).toMatchObject({ machines: 0, read: 0 });
    expect(fake.state.calls.some((c) => c.method === "Products")).toBe(false);
  });

  it("kopplad automat: inventering per titel, sortiment och tidpunkt", async () => {
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '2'`,
    );
    // Försäljningen följer med kopplingen (−2 Surging Sparks, −1 Paradox Rift).
    expect(await levels()).toEqual({ "Paradox Rift": -1, "Surging Sparks": -2 });

    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.stock).toMatchObject({ machines: 1, read: 1, counts: 3, titlesCreated: 1, failed: 0 });
    expect(
      fake.state.calls.filter((c) => c.method === "Products").map((c) => c.request.machine_id),
    ).toEqual(["2"]);
    // Awish är facit: 3 + 2 i två fack, Black Bolt är ny, Paradox Rift finns inte i automaten.
    expect(await levels()).toEqual({ "Black Bolt": 5, "Paradox Rift": 0, "Surging Sparks": 5 });

    const titles = await rows<{ name: string }>(
      db(),
      sql`select name from public.titles where organization_id = ${orgId}::uuid order by name`,
    );
    expect(titles.map((t) => t.name)).toEqual(["Black Bolt", "Paradox Rift", "Surging Sparks"]);
    const alias = await rows<{ alias: string }>(
      db(),
      sql`select a.alias from public.title_aliases a join public.titles t on t.id = a.title_id
          where t.organization_id = ${orgId}::uuid and t.name = 'Black Bolt'`,
    );
    expect(alias.map((a) => a.alias)).toEqual(["Black Bolt"]);

    const events = await rows<{ performed_by: string | null; occurred_at: Date }>(
      db(),
      sql`select performed_by, occurred_at from public.stock_events
          where location_id = ${locationId}::uuid and source = 'awish'`,
    );
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.performed_by === null)).toBe(true);
    expect(new Date(events[0]!.occurred_at).toISOString()).toBe(now.toISOString());

    const slots = await rows<{
      name: string;
      slots: number;
      valid_from: string;
      valid_to: string | null;
      note: string;
    }>(
      db(),
      sql`select t.name, ms.slots, ms.valid_from::text as valid_from, ms.valid_to::text as valid_to, ms.note
          from public.machine_slots ms join public.titles t on t.id = ms.title_id
          where ms.machine_id = ${machineId}::uuid order by t.name`,
    );
    expect(slots).toEqual([
      { name: "Black Bolt", slots: 1, valid_from: "2026-11-02", valid_to: null, note: "Awish: A3" },
      // Såld i automaten men inte i Awish: avslutad i går = utgången, inte tom.
      {
        name: "Paradox Rift",
        slots: 1,
        valid_from: "2026-11-01",
        valid_to: "2026-11-01",
        note: "Awish: inte i automaten",
      },
      {
        name: "Surging Sparks",
        slots: 2,
        valid_from: "2026-11-02",
        valid_to: null,
        note: "Awish: A1, A2",
      },
    ]);

    const loc = await one<{ at: Date }>(
      db(),
      sql`select awish_synced_at as at from public.stock_locations where id = ${locationId}::uuid`,
    );
    expect(new Date(loc.at).toISOString()).toBe(now.toISOString());
    const state = await one<{ cursor: string }>(
      db(),
      sql`select cursor from public.data_sources where id = ${sourceId}::uuid`,
    );
    expect(JSON.parse(state.cursor)).toMatchObject({
      stockSyncedAt: now.toISOString(),
      lastRun: { stock: { machines: 1, read: 1, counts: 3 } },
    });
  });

  it("samma antal ger ingen ny händelse; ändrat antal en", async () => {
    now = new Date("2026-11-02T15:40:00Z");
    const same = await run();
    expect(same.stock).toMatchObject({ read: 1, counts: 0 });
    expect(await awishCounts()).toBe(3);

    fake.state.products["2"]![0]!.current = 1;
    now = new Date("2026-11-02T15:50:00Z");
    const changed = await run();
    expect(changed.stock).toMatchObject({ read: 1, counts: 1 });
    expect(await awishCounts()).toBe(4);
    expect((await levels())["Surging Sparks"]).toBe(3);
    // Sortimentet är oförändrat (samma fack): inga nya perioder.
    const n = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.machine_slots where machine_id = ${machineId}::uuid`,
    );
    expect(n.n).toBe(3);
  });

  it("cron läser saldot var femte minut, men inte strax efter Synka nu", async () => {
    const products = () => fake.state.calls.filter((c) => c.method === "Products").length;
    const before = products();
    // Synka nu 15:50; en körning två minuter senare läser inte om facken.
    now = new Date("2026-11-02T15:52:00Z");
    const early = await run("schedule");
    expect(early.stock ?? null).toBeNull();
    expect(products()).toBe(before);
    // Varje tick var femte minut läser facken.
    for (const at of ["15:55:00", "16:00:10", "16:05:00", "16:10:20"]) {
      now = new Date(`2026-11-02T${at}Z`);
      const due = await run("schedule");
      expect(due.stock).toMatchObject({ read: 1 });
    }
    expect(products()).toBe(before + 4);
  });

  it("titel som tas ur automaten blir 0 och utgången; tom lista ändrar inget", async () => {
    fake.state.products["2"] = fake.state.products["2"]!.filter((p) => p.good !== "Black Bolt");
    now = new Date("2026-11-02T16:30:00Z");
    const r = await run();
    expect(r.stock).toMatchObject({ read: 1, counts: 1 });
    expect((await levels())["Black Bolt"]).toBe(0);
    const bb = await rows<{ valid_from: string; valid_to: string | null }>(
      db(),
      sql`select ms.valid_from::text as valid_from, ms.valid_to::text as valid_to
          from public.machine_slots ms join public.titles t on t.id = ms.title_id
          where ms.machine_id = ${machineId}::uuid and t.name = 'Black Bolt'`,
    );
    expect(bb).toEqual([{ valid_from: "2026-11-01", valid_to: "2026-11-01" }]);

    fake.state.products["2"] = [];
    now = new Date("2026-11-02T16:40:00Z");
    const empty = await run();
    expect(empty.stock).toMatchObject({ read: 0, counts: 0 });
    expect(await levels()).toMatchObject({ "Surging Sparks": 3 });
  });

  it("klientroller kan inte skriva en Awish-inventering eller awish_synced_at", async () => {
    const titleId = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.titles where organization_id = ${orgId}::uuid and name = 'Surging Sparks'`,
      )
    ).id;
    const refiller = await createMember(orgId, "refiller");
    const forged = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, performed_by, source)
              values (${orgId}::uuid, ${locationId}::uuid, ${titleId}::uuid, 'count', 9, ${refiller.id}::uuid, 'awish')`,
        ),
      ),
    );
    expect(forged.code).toBe("42501");
    const manual = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, performed_by)
              values (${orgId}::uuid, ${locationId}::uuid, ${titleId}::uuid, 'count', 9, ${refiller.id}::uuid)`,
        ),
      ),
    );
    expect(manual.code).toBeUndefined();
    const touched = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.stock_locations set awish_synced_at = now() where id = ${locationId}::uuid`,
        ),
      ),
    );
    expect(touched.code).toBe("42501");
    // Ägaren kan fortfarande byta namn på lagerplatsen.
    const renamed = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.stock_locations set name = 'BL-001 Sega' where id = ${locationId}::uuid`,
        ),
      ),
    );
    expect(renamed.code).toBeUndefined();
    // En källa på något annat än en inventering avvisas även för systemrollen.
    const wrongKind = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, source)
              values (${orgId}::uuid, ${locationId}::uuid, ${titleId}::uuid, 'refill', 1, 'awish')`,
        ),
      ),
    );
    expect(wrongKind.code).toBe("23514");
  });
});
