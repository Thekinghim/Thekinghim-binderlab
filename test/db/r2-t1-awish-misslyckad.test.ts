/**
 * Runda 2, T1-3: en misslyckad sändning till Awish sparas, syns och försöks igen.
 * Mot testdatabasen, med en låtsas-Awish (webbpanelen) och en klient som inte når Awish
 * (127.0.0.1:1, aldrig riktiga Awish).
 *
 * - En push som inte går fram sparas per automat ('awish_push_failed'), syns för påfyllaren
 *   (public.awish_push_pending och Fyll på-laddaren) och ger ingen sparad tid på Värde.
 * - Medan automaten väntar skriver läsningen av facken ingen inventering som tar bort
 *   påfyllningen: saldot ligger kvar på det påfyllda antalet.
 * - "Försök igen" med en fungerande Awish skickar antalen, och automaten slutar vänta.
 *   Därefter gäller läsningen som vanligt igen.
 * - Nästa sparade påfyllning tar med automater som väntar (nytt försök utan ett tryck).
 * - Roller och organisationer: läsaren får inte försöka igen, och en annan organisations
 *   automat skickas aldrig.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  settle,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { loadFillDataFor } = await import("../../src/app/fyll-pa/_lib/data");
const { saveAwishCredentialsFor, saveAwishWebCredentialsFor, setAwishWebPushFor } =
  await import("../../src/server/awish/manage");
const { startFakeAwishWeb } = await import("../../src/server/awish/testing/fake-web-server");
const { createAwishWebClient } = await import("../../src/server/awish/web-client");
const { pushMachinesToAwish, recordAwishPushFailure } =
  await import("../../src/server/awish/web-service");
const { retryAwishPushFor } = await import("../../src/server/awish/push-retry");
const { summariseAwishPush } = await import("../../src/server/awish/push-status");
const { applyMachineStock } = await import("../../src/server/awish/stock");
const { syncRefillsFor } = await import("../../src/server/data/field-refills");
const { pendingAwishPushes } = await import("../../src/server/varde/log");

type FakeWeb = Awaited<ReturnType<typeof startFakeAwishWeb>>;

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let owner: TestUser;
let refiller: TestUser;
let reader: TestUser;
let orgId: string;
let m1: string; // BL-001 (Awish 1001)
let m2: string; // BL-002 (Awish 1002)
let loc1: string;
let centralId: string;
let sourceId: string;
let titleId: string;
let fake: FakeWeb;

const NOW = 1_762_250_000_000;
/** En klient mot låtsas-Awish. */
const working = () => ({
  serviceDb: db(),
  makeClient: (o = {}) => createAwishWebClient({ ...o, baseUrl: fake.baseUrl, now: () => NOW }),
  clientOptions: { baseUrl: fake.baseUrl, now: () => NOW },
});
/** En klient som inte når Awish alls (ingen lyssnar på porten). */
const broken = () => ({
  serviceDb: db(),
  makeClient: (o = {}) =>
    createAwishWebClient({ ...o, baseUrl: "http://127.0.0.1:1", now: () => NOW }),
  clientOptions: { baseUrl: "http://127.0.0.1:1", now: () => NOW },
});

const locationOf = async (machineId: string) =>
  (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
    )
  ).id;

async function level(location: string): Promise<number> {
  const row = await one<{ q: number }>(
    db(),
    sql`select coalesce((select quantity from public.stock_levels
          where organization_id = ${orgId}::uuid and location_id = ${location}::uuid
            and title_id = ${titleId}::uuid), 0)::int as q`,
  );
  return Number(row.q);
}

const logKinds = async (machineId: string) =>
  (
    await rows<{ kind: string }>(
      db(),
      sql`select kind from public.automation_log
          where organization_id = ${orgId}::uuid and machine_id = ${machineId}::uuid
          order by occurred_at, created_at`,
    )
  ).map((r) => r.kind);

/** Awish läser facken (som synken var femte minut): ett fack A1 med `units` pack. */
const awishRead = (machineId: string, units: number) =>
  applyMachineStock(db(), {
    organizationId: orgId,
    dataSourceId: sourceId,
    machineId,
    at: new Date(),
    products: [
      {
        id: `p-${machineId}`,
        machineId: "x",
        channel: "A1",
        goodId: "7",
        goodName: "Surging Sparks",
        currentInventory: units,
        capacity: 20,
      },
    ],
  });

const refill = (machineId: string, quantity: number) => ({
  clientId: randomUUID(),
  machineId,
  titleId,
  quantity,
  fromWarehouse: true,
  fromLocationId: centralId,
  occurredAt: new Date().toISOString(),
  note: "Fyll på",
});

const product = (id: number, units: number) => ({
  id,
  goodId: 7,
  goodName: "Surging Sparks",
  status: true,
  currentInventory: units,
  capacity: 20,
  channelName: "A1",
});

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  refiller = await createMember(orgId, "refiller");
  reader = await createMember(orgId, "viewer");
  const machines = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Automat 1", activeFrom: "2026-10-01" },
        { organizationId: orgId, code: "BL-002", name: "Automat 2", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  m1 = machines.find((m) => m.code === "BL-001")!.id;
  m2 = machines.find((m) => m.code === "BL-002")!.id;
  loc1 = await locationOf(m1);
  centralId = (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where organization_id = ${orgId}::uuid and is_central`,
    )
  ).id;
  const [t] = await asUser(owner, (tx) =>
    tx.insert(s.titles).values({ organizationId: orgId, name: "Surging Sparks" }).returning(),
  );
  titleId = t!.id;

  fake = await startFakeAwishWeb({
    products: { "1001": [product(21, 3)], "1002": [product(31, 4)] },
  });
  const viewer = await viewerFor(owner, orgId);
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(viewer, {
    appId: "app",
    appSecret: "secret",
    appKey: "key",
  }));
  for (const [ext, id] of [
    ["1001", m1],
    ["1002", m2],
  ] as const) {
    await db().execute(sql`
      insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
      values (${orgId}::uuid, ${sourceId}::uuid, ${ext}, 'Automat', ${id}::uuid)
      on conflict (organization_id, data_source_id, external_id)
      do update set machine_id = ${id}::uuid`);
  }
  await saveAwishWebCredentialsFor(viewer, {
    email: fake.state.email,
    password: fake.state.password,
  });
  await setAwishWebPushFor(viewer, true);

  // 40 pack i lagret. Första läsningen av facken: 3 pack i BL-001 och 4 i BL-002.
  await db().execute(sql`
    insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
    values (${orgId}::uuid, ${centralId}::uuid, ${titleId}::uuid, 'count', 40, 'test')`);
  await awishRead(m1, 3);
  await awishRead(m2, 4);
});

afterAll(async () => {
  await fake?.stop();
});

describe("sändningen går inte fram", () => {
  it("påfyllningen sparas, felet sparas per automat och syns för påfyllaren", async () => {
    const viewer = await viewerFor(refiller, orgId);
    const saved = await syncRefillsFor(viewer, [refill(m1, 5)]);
    expect(saved.results.map((r) => r.status)).toEqual(["saved"]);
    expect(await level(loc1)).toBe(8);

    const pushed = await pushMachinesToAwish(orgId, saved.savedMachineIds, {
      ...broken(),
      withPending: true,
    });
    expect(pushed.status).toBe("done");
    expect(pushed.machines).toHaveLength(1);
    expect(pushed.machines[0]).toMatchObject({ machineId: m1, status: "error", slotsUpdated: 0 });
    const status = summariseAwishPush(pushed);
    expect(status).toMatchObject({ state: "partial", kind: "partial", failedMachineIds: [m1] });

    expect(await logKinds(m1)).toEqual(["awish_push_failed"]);
    // Påfyllaren läser inte loggen själv, men ser vilka automater som väntar.
    const pending = await asUser(refiller, (tx) =>
      rows<{ machine_id: string }>(
        tx,
        sql`select machine_id::text as machine_id from public.awish_push_pending(${orgId}::uuid)`,
      ),
    );
    expect(pending.map((p) => p.machine_id)).toEqual([m1]);
    const data = await loadFillDataFor(viewer);
    expect(Object.keys(data.awishPending)).toEqual([m1]);
    expect(Date.parse(data.awishPending[m1]!)).toBeGreaterThan(Date.now() - 60_000);
    // Awish har kvar det gamla antalet.
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(3);
  });

  it("ett misslyckat försök till ger ingen ny rad (automaten väntar redan)", async () => {
    const again = await retryAwishPushFor(
      await viewerFor(refiller, orgId),
      { machineId: m1 },
      broken(),
    );
    expect(again.cleared).toBe(false);
    expect(again.pending).toEqual([m1]);
    expect(again.awish).toMatchObject({ state: "partial", failedMachineIds: [m1] });
    expect(await logKinds(m1)).toEqual(["awish_push_failed"]);
  });

  it("Värde räknar ingen sparad tid för en misslyckad sändning", async () => {
    const counts = await asUser(owner, (tx) =>
      rows<{ kind: string; n: number }>(
        tx,
        sql`select kind, n from public.varde_automation_counts(${orgId}::uuid,
              (now() - interval '40 days')::date, (now() + interval '2 days')::date)`,
      ),
    );
    expect(counts.filter((c) => c.kind === "awish_push")).toEqual([]);
  });

  it("läsningen av facken tar inte bort påfyllningen medan automaten väntar", async () => {
    const before = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events
          where organization_id = ${orgId}::uuid and location_id = ${loc1}::uuid and kind = 'count'`,
    );
    // Awish visar fortfarande 3 (det gamla antalet).
    const read = await awishRead(m1, 3);
    expect(read).toMatchObject({ counts: 0, heldBack: 1, warehouseOut: 0 });
    expect(await level(loc1)).toBe(8);
    const after = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events
          where organization_id = ${orgId}::uuid and location_id = ${loc1}::uuid and kind = 'count'`,
    );
    expect(Number(after.n)).toBe(Number(before.n));
    // Lagret hemma är draget en gång (40 − 5), inte två.
    expect(await level(centralId)).toBe(35);
  });

  it("en annan automat som inte väntar läses som vanligt (saldot sänks till Awish antal)", async () => {
    const loc2 = await locationOf(m2);
    const read = await awishRead(m2, 2);
    expect(read.counts).toBe(1);
    expect(read.heldBack).toBeUndefined();
    expect(await level(loc2)).toBe(2);
  });
});

describe("Försök igen", () => {
  it("läsaren får inte försöka igen", async () => {
    await expect(
      retryAwishPushFor(await viewerFor(reader, orgId), { machineId: m1 }, working()),
    ).rejects.toThrow("Du har inte behörighet");
    expect(await logKinds(m1)).toEqual(["awish_push_failed"]);
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(3);
  });

  it("en annan organisations automat skickas aldrig", async () => {
    const stranger = await createUser();
    const otherOrg = await createOrg(stranger);
    const out = await retryAwishPushFor(
      await viewerFor(stranger, otherOrg),
      { machineId: m1 },
      working(),
    );
    expect(out.awish).toBeUndefined();
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(3);
    expect(await logKinds(m1)).toEqual(["awish_push_failed"]);
  });

  it("med en fungerande Awish skickas antalet, och automaten slutar vänta", async () => {
    const viewer = await viewerFor(refiller, orgId);
    const out = await retryAwishPushFor(viewer, { machineId: m1 }, working());
    expect(out).toMatchObject({ cleared: true, pending: [] });
    expect(out.awish).toMatchObject({ state: "sent", kind: "sent", slots: 1 });
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(8);
    expect(await logKinds(m1)).toEqual(["awish_push_failed", "awish_push"]);
    expect((await loadFillDataFor(viewer)).awishPending).toEqual({});
    expect([...(await pendingAwishPushes(db(), orgId)).keys()]).toEqual([]);
  });

  it("inget väntar: ett försök till gör ingenting", async () => {
    const calls = fake.state.calls.length;
    const out = await retryAwishPushFor(await viewerFor(refiller, orgId), undefined, working());
    expect(out).toEqual({ pending: [], cleared: true });
    expect(fake.state.calls.length).toBe(calls);
  });

  it("efteråt gäller läsningen igen: Awish antal blir saldot", async () => {
    // Två pack sålda enligt Awish (8 → 6).
    const read = await awishRead(m1, 6);
    expect(read.counts).toBe(1);
    expect(read.heldBack).toBeUndefined();
    expect(await level(loc1)).toBe(6);
  });
});

describe("nytt försök utan ett tryck", () => {
  it("nästa sparade påfyllning tar med automaten som väntar", async () => {
    const viewer = await viewerFor(refiller, orgId);
    // BL-001: påfyllning vars sändning inte går fram.
    const first = await syncRefillsFor(viewer, [refill(m1, 4)]);
    await pushMachinesToAwish(orgId, first.savedMachineIds, { ...broken(), withPending: true });
    expect([...(await pendingAwishPushes(db(), orgId)).keys()]).toEqual([m1]);
    expect(await level(loc1)).toBe(10);

    // BL-002 fylls på när Awish svarar igen: båda automaterna skickas.
    const second = await syncRefillsFor(viewer, [refill(m2, 3)]);
    expect(second.savedMachineIds).toEqual([m2]);
    const pushed = await pushMachinesToAwish(orgId, second.savedMachineIds, {
      ...working(),
      withPending: true,
    });
    expect(pushed.machines.map((m) => [m.machineId, m.status]).sort()).toEqual(
      [
        [m1, "pushed"],
        [m2, "pushed"],
      ].sort(),
    );
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(10);
    expect(fake.state.products["1002"]![0]!.currentInventory).toBe(5);
    expect([...(await pendingAwishPushes(db(), orgId)).keys()]).toEqual([]);
  });

  it("ett fel innan sändningen ens börjar sparas också (recordAwishPushFailure)", async () => {
    await recordAwishPushFailure(orgId, [m2], { serviceDb: db() });
    expect([...(await pendingAwishPushes(db(), orgId)).keys()]).toEqual([m2]);
    // Push avstängd: inget att skicka, automaten slutar vänta.
    await setAwishWebPushFor(await viewerFor(owner, orgId), false);
    const out = await retryAwishPushFor(await viewerFor(owner, orgId), {}, working());
    expect(out).toMatchObject({ cleared: true, pending: [] });
    expect((await logKinds(m2)).at(-1)).toBe("awish_push_cleared");
    await setAwishWebPushFor(await viewerFor(owner, orgId), true);
  });
});

describe("behörighet i databasen", () => {
  it("läsaren och en utomstående får inte läsa vilka automater som väntar", async () => {
    const stranger = await createUser();
    for (const u of [reader, stranger]) {
      const out = await settle(
        asUser(u, (tx) => tx.execute(sql`select * from public.awish_push_pending(${orgId}::uuid)`)),
      );
      expect(out.ok).toBe(false);
    }
  });

  it("ingen klientroll kan skriva i loggen", async () => {
    for (const u of [owner, refiller]) {
      const out = await settle(
        asUser(u, (tx) =>
          tx.execute(
            sql`insert into public.automation_log (organization_id, kind, machine_id, units)
                values (${orgId}::uuid, 'awish_push_failed', ${m1}::uuid, 0)`,
          ),
        ),
      );
      expect(out.ok).toBe(false);
    }
  });
});
