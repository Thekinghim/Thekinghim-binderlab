/**
 * Fyllnadsgrad: kapaciteten per titel från Awish (machine_slot_capacity) mot
 * testdatabasen och låtsas-Awish:
 *
 * - synken skriver en rad per titel med summerad kapacitet och sorterade fack,
 * - två varunamn som pekar på samma titel (alias) slås ihop och kapaciteten summeras,
 * - en titel som tas ur automaten tas bort, och kapacitet 0 ger ingen rad,
 * - querySlotCapacities läser som användaren (RLS) och ignorerar gamla rader,
 * - klientroller kan inte skriva tabellen.
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
import { querySlotCapacities } from "../../src/server/data/core/slot-capacity";

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
    machines: [{ id: "7", name: "Fackautomat", machine_no: "163279xx" }],
    orders: [],
    products: {
      "7": [
        { channel: "A10", good: "Surging Sparks", current: 3, capacity: 8 },
        { channel: "A2", good: "Surging Sparks", current: 2, capacity: 8 },
        // Annat varunamn, samma titel via alias: summeras.
        { channel: "B1", good: "SSP Booster", current: 1, capacity: 6 },
        { channel: "A3", good: "Black Bolt", current: 0, capacity: 10 },
        { channel: "A4", good: "Tomt fack", current: 0, capacity: 0 },
      ],
    },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("kapaciteten från Awish", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineId: string;
  let sparksId: string;
  let now = new Date("2026-11-04T09:00:00Z");

  const run = () =>
    syncAwishSource(
      { db: db(), connect, now: () => now },
      { dataSourceId: sourceId, trigger: "manual" },
    );
  const capacityRows = () =>
    rows<{ name: string; capacity: number; channels: string[]; synced_at: Date }>(
      db(),
      sql`select t.name, c.capacity, c.channels, c.synced_at
          from public.machine_slot_capacity c join public.titles t on t.id = c.title_id
          where c.machine_id = ${machineId}::uuid order by t.name`,
    );

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    const [machine] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-007",
          name: "Fackautomat",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    machineId = machine!.id;
    sparksId = (
      await one<{ id: string }>(
        db(),
        sql`insert into public.titles (organization_id, name) values (${orgId}::uuid, 'Surging Sparks')
            returning id`,
      )
    ).id;
    await db().execute(
      sql`insert into public.title_aliases (organization_id, title_id, alias)
          values (${orgId}::uuid, ${sparksId}::uuid, 'Surging Sparks'),
                 (${orgId}::uuid, ${sparksId}::uuid, 'SSP Booster')`,
    );
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
    await run();
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '7'`,
    );
  });

  it("en rad per titel: alias summeras, facken sorteras, kapacitet 0 ger ingen rad", async () => {
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.stock).toMatchObject({ read: 1, failed: 0 });
    const got = await capacityRows();
    expect(got.map(({ name, capacity, channels }) => ({ name, capacity, channels }))).toEqual([
      { name: "Black Bolt", capacity: 10, channels: ["A3"] },
      { name: "Surging Sparks", capacity: 22, channels: ["A2", "A10", "B1"] },
    ]);
    expect(got.every((g) => new Date(g.synced_at).toISOString() === now.toISOString())).toBe(true);
  });

  it("ny läsning uppdaterar raden; en titel som tas ur automaten tas bort", async () => {
    fake.state.products["7"] = fake.state.products["7"]!.filter((p) => p.good !== "Black Bolt");
    fake.state.products["7"]!.push({
      channel: "A5",
      good: "Surging Sparks",
      current: 4,
      capacity: 8,
    });
    now = new Date("2026-11-04T09:10:00Z");
    const r = await run();
    expect(r.ok, r.message ?? "").toBe(true);
    const got = await capacityRows();
    expect(got.map(({ name, capacity, channels }) => ({ name, capacity, channels }))).toEqual([
      { name: "Surging Sparks", capacity: 30, channels: ["A2", "A5", "A10", "B1"] },
    ]);
    expect(new Date(got[0]!.synced_at).toISOString()).toBe(now.toISOString());
  });

  it("querySlotCapacities: som användaren, gamla rader räknas inte", async () => {
    const viewer = await createMember(orgId, "viewer");
    const fresh = await asUser(viewer, (tx) =>
      querySlotCapacities(tx, orgId, new Date("2026-11-05T09:00:00Z")),
    );
    expect(fresh).toEqual([
      {
        machineId,
        titleId: sparksId,
        capacity: 30,
        channels: ["A2", "A5", "A10", "B1"],
        syncedAt: "2026-11-04T09:10:00.000Z",
      },
    ]);
    const stale = await asUser(viewer, (tx) =>
      querySlotCapacities(tx, orgId, new Date("2026-11-12T09:10:01Z")),
    );
    expect(stale).toEqual([]);
    // En annan organisation ser inget.
    const other = await createUser();
    const otherOrg = await createOrg(other);
    const foreign = await asUser(other, (tx) => querySlotCapacities(tx, orgId, now));
    expect(foreign).toEqual([]);
    expect(otherOrg).not.toBe(orgId);
  });

  it("klientroller kan inte skriva kapaciteten", async () => {
    const forged = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.machine_slot_capacity (organization_id, machine_id, title_id, capacity, synced_at)
              values (${orgId}::uuid, ${machineId}::uuid, ${sparksId}::uuid, 99, now())`,
        ),
      ),
    );
    expect(forged.code).toBe("42501");
    const updated = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.machine_slot_capacity set capacity = 1 where organization_id = ${orgId}::uuid`,
        ),
      ),
    );
    expect(updated.code).toBe("42501");
  });
});
