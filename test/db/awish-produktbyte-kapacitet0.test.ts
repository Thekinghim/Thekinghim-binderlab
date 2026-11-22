/**
 * Produktbyte när Awish rapporterar kapacitet 0 för facken (src/server/awish/stock.ts,
 * stock_locations.awish_channels) mot testdatabasen och låtsas-Awish:
 *
 * - machine_slot_capacity får inga rader (kapaciteten är okänd: inget "fyll till kapacitet"),
 * - men facken per kanal sparas ändå, så att ett byte (A ut, B in) i nästa läsning hittas:
 *   A tillbaka till lagret, B ur lagret, bytet loggat,
 * - en automat som lästes innan kolumnen fanns (awish_channels null) använder
 *   machine_slot_capacity som förut,
 * - användare kan inte skriva awish_channels.
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

import { asUser, attempt, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

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
      { id: "8", name: "Nollan", machine_no: "163280xx" },
      { id: "9", name: "Gammal", machine_no: "163281xx" },
    ],
    orders: [],
    products: {
      // Awish visar kapacitet 0 för alla fack.
      "8": [
        { channel: "A1", good: "Surging Sparks", current: 3, capacity: 0 },
        { channel: "A2", good: "Surging Sparks", current: 4, capacity: 0 },
        { channel: "A3", good: "Black Bolt", current: 5, capacity: 0 },
      ],
      "9": [
        { channel: "B1", good: "Surging Sparks", current: 2, capacity: 6 },
        { channel: "B2", good: "Black Bolt", current: 2, capacity: 6 },
      ],
    },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("produktbyte med kapacitet 0 i Awish", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineId: string;
  let oldMachineId: string;
  let locationId: string;
  let oldLocationId: string;
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
  const swapsFor = (machine: string) =>
    rows<{ channel: string; from_name: string; to_name: string; returned: number; taken: number }>(
      db(),
      sql`select w.channel, f.name as from_name, t.name as to_name,
                 w.returned_units as returned, w.taken_units as taken
          from public.product_swaps w
          join public.titles f on f.id = w.from_title_id
          join public.titles t on t.id = w.to_title_id
          where w.machine_id = ${machine}::uuid order by w.channel`,
    );
  const capacityRows = async (machine: string) =>
    (
      await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.machine_slot_capacity
            where machine_id = ${machine}::uuid`,
      )
    ).n;

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    const inserted = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values([
          { organizationId: orgId, code: "BL-008", name: "Nollan", activeFrom: "2026-10-01" },
          { organizationId: orgId, code: "BL-009", name: "Gammal", activeFrom: "2026-10-01" },
        ])
        .returning(),
    );
    machineId = inserted.find((m) => m.code === "BL-008")!.id;
    oldMachineId = inserted.find((m) => m.code === "BL-009")!.id;
    const loc = async (m: string) =>
      (
        await one<{ id: string }>(
          db(),
          sql`select id from public.stock_locations where machine_id = ${m}::uuid`,
        )
      ).id;
    locationId = await loc(machineId);
    oldLocationId = await loc(oldMachineId);
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
    now = new Date("2026-11-10T08:55:00Z");
    await run();
    now = new Date("2026-11-10T09:00:00Z");
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '8'`,
    );
    await db().execute(
      sql`update public.source_machines set machine_id = ${oldMachineId}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '9'`,
    );
  });

  it("första läsningen: inga kapacitetsrader, men facken per kanal sparas", async () => {
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(await levelsAt(locationId)).toEqual({ "Black Bolt": 5, "Surging Sparks": 7 });
    expect(await capacityRows(machineId)).toBe(0);
    const ss = await titleId("Surging Sparks");
    const bb = await titleId("Black Bolt");
    const loc = await one<{ channels: Record<string, string> | null }>(
      db(),
      sql`select awish_channels as channels from public.stock_locations where id = ${locationId}::uuid`,
    );
    expect(loc.channels).toEqual({ A1: ss, A2: ss, A3: bb });
    expect(await swapsFor(machineId)).toEqual([]);

    // Hemma: 20 Paradox Rift och 10 Surging Sparks, med alias för Awish-namnet.
    await db().execute(
      sql`insert into public.titles (organization_id, name) values (${orgId}::uuid, 'Paradox Rift')`,
    );
    const pr = await titleId("Paradox Rift");
    await db().execute(
      sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
          values (${orgId}::uuid, ${homeId}::uuid, ${pr}::uuid, 'count', 20, '2026-11-10T09:10:00Z'),
                 (${orgId}::uuid, ${homeId}::uuid, ${ss}::uuid, 'count', 10, '2026-11-10T09:10:00Z')`,
    );
    await db().execute(
      sql`insert into public.title_aliases (organization_id, title_id, alias)
          values (${orgId}::uuid, ${pr}::uuid, 'Paradox Rift') on conflict do nothing`,
    );
  });

  it("A2 byts från Surging Sparks till Paradox Rift (kapacitet 0): bytet hittas", async () => {
    fake.state.products["8"]![1] = { channel: "A2", good: "Paradox Rift", current: 6, capacity: 0 };
    now = new Date("2026-11-10T10:00:00Z");
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);

    expect(await swapsFor(machineId)).toEqual([
      {
        channel: "A2",
        from_name: "Surging Sparks",
        to_name: "Paradox Rift",
        returned: 4,
        taken: 6,
      },
    ]);
    expect(await levelsAt(locationId)).toEqual({
      "Black Bolt": 5,
      "Paradox Rift": 6,
      "Surging Sparks": 3,
    });
    expect(await levelsAt(homeId)).toMatchObject({ "Paradox Rift": 14, "Surging Sparks": 14 });
    // Kapaciteten är fortfarande okänd (inga rader med kapacitet 0).
    expect(await capacityRows(machineId)).toBe(0);
    const loc = await one<{ channels: Record<string, string> | null }>(
      db(),
      sql`select awish_channels as channels from public.stock_locations where id = ${locationId}::uuid`,
    );
    expect(loc.channels?.A2).toBe(await titleId("Paradox Rift"));

    // En andra läsning ger inget nytt byte.
    now = new Date("2026-11-10T10:05:00Z");
    const again = await run();
    expect(again.ok, again.message ?? "").toBe(true);
    expect(await swapsFor(machineId)).toHaveLength(1);
  });

  it("en automat utan sparade kanaler (äldre läsning) använder machine_slot_capacity", async () => {
    // Som en automat som lästes innan awish_channels fanns.
    await db().execute(
      sql`update public.stock_locations set awish_channels = null where id = ${oldLocationId}::uuid`,
    );
    expect(await capacityRows(oldMachineId)).toBe(2);
    fake.state.products["9"]![1] = { channel: "B2", good: "Paradox Rift", current: 3, capacity: 6 };
    now = new Date("2026-11-10T10:10:00Z");
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(await swapsFor(oldMachineId)).toEqual([
      { channel: "B2", from_name: "Black Bolt", to_name: "Paradox Rift", returned: 2, taken: 3 },
    ]);
    const loc = await one<{ channels: Record<string, string> | null }>(
      db(),
      sql`select awish_channels as channels from public.stock_locations where id = ${oldLocationId}::uuid`,
    );
    expect(loc.channels).toEqual({
      B1: await titleId("Surging Sparks"),
      B2: await titleId("Paradox Rift"),
    });
  });

  it("användare kan inte skriva awish_channels", async () => {
    const forged = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.stock_locations set awish_channels = '{"A9": "x"}'::jsonb
              where id = ${locationId}::uuid`,
        ),
      ),
    );
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("42501");
  });
});
