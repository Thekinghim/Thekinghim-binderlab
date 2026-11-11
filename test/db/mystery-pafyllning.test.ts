/**
 * Mystery packs och påfyllning mot testdatabasen: ett mystery-fack fylls bara på när det är
 * tomt, med en hel omgång (ägarens regel). Data som går genom SQL:
 *
 * - stamdatan (queryMasterData och queryTitles) ger omgången för en egen produkt med
 *   innehåll (senaste versionen), null för en egen produkt utan innehåll och vanliga titlar,
 * - Fyll på-laddaren (som påfyllaren, med RLS): förslaget är 0 medan facket har pack och en
 *   hel omgång när det är tomt,
 * - pushen till Awish (låtsas-panelen) fyller bara det tomma facket och rör inte ett
 *   mystery-fack som har pack kvar,
 * - dagliga kontrollen läser saldot före påfyllningen och omgången: en påfyllning före 0 ger
 *   en varning, inget larm.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { queryMasterData, queryTitles } = await import("../../src/server/data/core/queries");
const { loadFillDataFor } = await import("../../src/app/fyll-pa/_lib/data");
const { saveAwishCredentialsFor, saveAwishWebCredentialsFor, setAwishWebPushFor } =
  await import("../../src/server/awish/manage");
const { startFakeAwishWeb } = await import("../../src/server/awish/testing/fake-web-server");
const { createAwishWebClient } = await import("../../src/server/awish/web-client");
const { pushMachinesToAwish } = await import("../../src/server/awish/web-service");
const { queryRefillPushes, queryAwishReads } = await import("../../src/server/self-check/queries");
const { refillPushCheck, awishStockCheck } = await import("../../src/analytics/self-check");

type FakeWeb = Awaited<ReturnType<typeof startFakeAwishWeb>>;

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let owner: TestUser;
let refiller: TestUser;
let orgId: string;
let machineId: string;
let locationId: string;
let centralId: string;
let sourceId: string;
let mp: string; // Mystery Pack Plus (egen produkt med innehåll, 14 per omgång)
let bare: string; // egen produkt utan innehåll
let plain: string; // vanlig titel (en del i innehållet)
let fake: FakeWeb | null = null;

/** Ett event i en plats (som postgres: stock_levels är en vy över händelserna). */
async function event(location: string, titleId: string, kind: string, quantity: number, ago = 0) {
  await asPostgres((tx) =>
    tx.execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      values (${orgId}::uuid, ${location}::uuid, ${titleId}::uuid, ${kind}::public.stock_event_kind,
              ${quantity}, now() - make_interval(mins => ${ago}), 'test')`),
  );
}

/** Awishs fack för automaten (som en läsning just nu). */
async function setFill(units: number, capacity = 20) {
  await db().execute(sql`
    update public.stock_locations
       set awish_synced_at = now(),
           awish_fill = ${JSON.stringify([
             { title_id: mp, units, capacity, channels: 1, empty: units === 0 ? 1 : 0 },
           ])}::jsonb
     where id = ${locationId}::uuid`);
}

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  refiller = await createMember(orgId, "refiller");
  const [m] = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values({
        organizationId: orgId,
        code: "BL-001",
        name: "Automat 1",
        activeFrom: "2026-10-01",
      })
      .returning(),
  );
  machineId = m!.id;
  locationId = (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
    )
  ).id;
  centralId = (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where organization_id = ${orgId}::uuid and is_central`,
    )
  ).id;
  await asUser(owner, async (tx) => {
    const titles = await tx
      .insert(s.titles)
      .values([
        { organizationId: orgId, name: "Mystery Pack Plus", ownProduct: true },
        { organizationId: orgId, name: "Eget utan innehåll", ownProduct: true },
        { organizationId: orgId, name: "Phantasmal Flames" },
      ])
      .returning();
    [mp, bare, plain] = [titles[0]!.id, titles[1]!.id, titles[2]!.id];
    await tx.execute(
      sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 14,
            ${JSON.stringify([{ titleId: plain, quantity: 14, hit: true }])}::jsonb)`,
    );
  });
  // 28 mystery packs hemma (två omgångar).
  await event(centralId, mp, "count", 28, 60);
});

afterAll(async () => {
  await fake?.stop();
});

describe("stamdatan: omgången för mystery packs", () => {
  it("queryMasterData och queryTitles ger omgången bara för en egen produkt med innehåll", async () => {
    const master = await asUser(owner, (tx) => queryMasterData(tx, orgId, "2026-11-08"));
    const titles = await asUser(owner, (tx) => queryTitles(tx, orgId));
    for (const list of [master.titles, titles]) {
      const by = new Map(list.map((t) => [t.id, t.mysteryBatchSize ?? null]));
      expect(by.get(mp)).toBe(14);
      expect(by.get(bare)).toBeNull();
      expect(by.get(plain)).toBeNull();
    }
  });

  it("påfyllaren ser omgången (innehållet läses av alla roller)", async () => {
    const titles = await asUser(refiller, (tx) => queryTitles(tx, orgId));
    expect(titles.find((t) => t.id === mp)?.mysteryBatchSize).toBe(14);
  });
});

describe("Fyll på-laddaren: mystery packs", () => {
  const row = async () => {
    const data = await loadFillDataFor(await viewerFor(refiller, orgId));
    return data.machines.find((x) => x.id === machineId)!.rows.find((r) => r.titleId === mp)!;
  };

  it("facket har pack: förslaget är 0 och raden är inte snart slut", async () => {
    await event(locationId, mp, "count", 3, 30);
    await setFill(3);
    const r = await row();
    expect(r).toMatchObject({ now: 3, capacity: 20, suggested: 0, status: null, batchSize: 14 });
  });

  it("tomt fack: slut och förslaget är exakt en omgång", async () => {
    await event(locationId, mp, "count", 0, 20);
    await setFill(0);
    const r = await row();
    expect(r).toMatchObject({ now: 0, suggested: 14, status: "empty", batchSize: 14 });
  });
});

describe("push till Awish och dagliga kontrollen", () => {
  beforeAll(async () => {
    fake = await startFakeAwishWeb({
      // Samma klocka som klienten: signaturens tidsfönster räknas mot den.
      now: () => 1_762_250_000_000,
      products: {
        "1001": [
          {
            id: 21,
            goodId: 7,
            goodName: "Mystery Pack Plus",
            status: true,
            currentInventory: 3,
            capacity: 20,
            channelName: "A1",
          },
          {
            id: 22,
            goodId: 7,
            goodName: "Mystery Pack Plus",
            status: true,
            currentInventory: 0,
            capacity: 20,
            channelName: "A2",
          },
        ],
      },
    });
    const viewer = await viewerFor(owner, orgId);
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(viewer, {
      appId: "app",
      appSecret: "secret",
      appKey: "key",
    }));
    await db().execute(sql`
      insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
      values (${orgId}::uuid, ${sourceId}::uuid, '1001', 'Automat 1', ${machineId}::uuid)
      on conflict (organization_id, data_source_id, external_id)
      do update set machine_id = ${machineId}::uuid`);
    await saveAwishWebCredentialsFor(viewer, {
      email: fake.state.email,
      password: fake.state.password,
    });
    await setAwishWebPushFor(viewer, true);
  });

  const push = () =>
    pushMachinesToAwish(orgId, [machineId], {
      serviceDb: db(),
      makeClient: (o = {}) =>
        createAwishWebClient({ ...o, baseUrl: fake!.baseUrl, now: () => 1_762_250_000_000 }),
      clientOptions: { baseUrl: fake!.baseUrl, now: () => 1_762_250_000_000 },
    });

  it("pushen fyller bara det tomma facket, inte facket som har pack kvar", async () => {
    // Appen: 3 kvar + en omgång (14) = 17.
    await event(locationId, mp, "count", 3, 10);
    await event(locationId, mp, "refill", 14, 5);
    const result = await push();
    expect(result.status).toBe("done");
    const slots = fake!.state.products["1001"]!;
    expect(slots.find((p) => p.id === 21)?.currentInventory).toBe(3);
    expect(slots.find((p) => p.id === 22)?.currentInventory).toBe(14);
  });

  it("ett mystery-fack med pack kvar och inget tomt fack rörs inte", async () => {
    fake!.state.products["1001"] = [fake!.state.products["1001"]![0]!];
    await event(locationId, mp, "count", 2, 4);
    await event(locationId, mp, "refill", 14, 3);
    await push();
    expect(fake!.state.products["1001"]![0]!.currentInventory).toBe(3);
  });

  it("kontrollen läser saldot före påfyllningen: före 0 ger en varning, inget larm", async () => {
    const now = new Date(Date.now() + 10 * 60_000);
    const data = await queryRefillPushes(db(), orgId, now);
    const mine = data.refills.filter((r) => r.titleName === "Mystery Pack Plus");
    expect(mine.map((r) => [r.quantity, r.before, r.mysteryBatchSize])).toEqual([
      [14, 3, 14],
      [14, 2, 14],
    ]);
    const result = refillPushCheck({ ...data, pushes: [], now });
    expect(result.status).toBe("warn");
    expect(result.findings.every((f) => f.level === "warn")).toBe(true);
  });

  it("Awish = appen: appens högre saldo efter en påfyllning före 0 är en varning", async () => {
    await setFill(2);
    const reads = await queryAwishReads(db(), orgId);
    const t = reads.find((m) => m.machineId === machineId)?.titles.find((x) => x.titleId === mp);
    expect(t?.mysteryBatchSize).toBe(14);
    const result = awishStockCheck({ machines: reads, now: new Date() });
    expect(result.status).toBe("warn");
  });
});
