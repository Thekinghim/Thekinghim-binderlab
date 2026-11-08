/**
 * Mystery packs genom hela kedjan mot testdatabasen (ägarens regel: ett mystery-fack fylls
 * bara på när det är tomt, med exakt en omgång). Mystery Pack Plus (egen produkt, innehåll
 * med 14 per omgång) och en vanlig titel säljer 1 pack per dag i BL-201, larmgräns 5.
 *
 * - 3 kvar (den vanliga titeln 1): inget förslag på Fyll på, ingen punkt i Att göra, inget larm; ett antal ger den
 *   lugna varningen. Den vanliga titeln får förslag, punkt och larm som förut.
 * - 0 kvar: förslaget är exakt 14, punkten och larmet säger "fyll på en hel omgång (14 st)",
 *   och pushen till Awish fyller bara det tomma facket med 14.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "@/db/schema";
import { listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";

import {
  asPostgres,
  asUser,
  createOrg,
  createUser,
  db,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { collectCandidates } = await import("@/server/alerts/evaluate");
const { loadRankedTodoStateFor } = await import("@/server/data/todos");
const { setSlotAlertFor } = await import("@/server/data/core/slot-alerts");
const { loadFillDataFor } = await import("@/app/fyll-pa/_lib/data");
const { mysteryNote } = await import("@/app/fyll-pa/_lib/model");
const { saveAwishCredentialsFor, saveAwishWebCredentialsFor, setAwishWebPushFor } =
  await import("@/server/awish/manage");
const { startFakeAwishWeb } = await import("@/server/awish/testing/fake-web-server");
const { createAwishWebClient } = await import("@/server/awish/web-client");
const { pushMachinesToAwish } = await import("@/server/awish/web-service");

/** Onsdag 4 nov. 2026 10:00 svensk tid. */
const NOW = new Date("2026-11-04T09:00:00Z");
const TZ = "Europe/Stockholm";

let owner: TestUser;
let viewer: Viewer;
let orgId: string;
let machineId: string;
let locationId: string;
let mp: string;
let plain: string;
let fake: Awaited<ReturnType<typeof startFakeAwishWeb>> | null = null;

async function count(titleId: string, quantity: number, at: string, kind = "count") {
  await asPostgres((tx) =>
    tx.execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      values (${orgId}::uuid, ${locationId}::uuid, ${titleId}::uuid, ${kind}::public.stock_event_kind,
              ${quantity}, ${at}::timestamptz, 'grind')`),
  );
}

const fillRow = async (titleId: string) => {
  const data = await loadFillDataFor(viewer, NOW);
  return data.machines.find((m) => m.id === machineId)!.rows.find((r) => r.titleId === titleId)!;
};
const todos = async () => (await loadRankedTodoStateFor(viewer, NOW)).items;
const lowStock = async () =>
  (await db().transaction((tx) => collectCandidates(tx, orgId, TZ, NOW))).candidates.filter(
    (c) => c.kind === "low_stock",
  );

beforeAll(async () => {
  owner = await createUser(`mystery-grind-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Mystery ${uniqueSuffix()}`);
  await asPostgres(async (tx) => {
    const org = { organizationId: orgId };
    const [m] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-201", name: "Sega gubbens automat", activeFrom: "2026-10-14" })
      .returning({ id: s.machines.id });
    machineId = m!.id;
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Sega gubben" })
      .returning({ id: s.stores.id });
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId, storeId: store!.id, validFrom: "2026-10-14" });
    const titles = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Mystery Pack Plus", ownProduct: true },
        { ...org, name: "30th Celebration" },
      ])
      .returning({ id: s.titles.id });
    mp = titles[0]!.id;
    plain = titles[1]!.id;
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning({ id: s.dataSources.id });
    await tx.execute(sql`
      insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                 ordered_at, amount_ore, machine_id, source_hash)
      select ${orgId}::uuid, ${source!.id}::uuid, x.code || '-' || to_char(g.d, 'YYYYMMDD'),
             x.name, x.title_id, (g.d + time '12:00') at time zone 'Europe/Stockholm', 19900,
             ${machineId}::uuid, 'test'
      from (values (${mp}::uuid, 'Mystery Pack Plus', 'M'),
                   (${plain}::uuid, '30th Celebration', 'T')) as x(title_id, name, code)
      cross join lateral generate_series(date '2026-10-14', date '2026-11-03', interval '1 day') g(d)`);
    locationId = (
      (await tx.execute(
        sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
      )) as unknown as Array<{ id: string }>
    )[0]!.id;
    // 50 av varje hemma.
    await tx.execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      select ${orgId}::uuid, l.id, t.id, 'count', 50, '2026-11-03T18:00:00Z'::timestamptz, 'Hemma'
      from public.stock_locations l cross join (values (${mp}::uuid), (${plain}::uuid)) t(id)
      where l.organization_id = ${orgId}::uuid and l.is_central`);
  });
  await asUser(owner, (tx) =>
    tx.execute(
      sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 14,
            ${JSON.stringify([{ titleId: plain, quantity: 14, hit: true }])}::jsonb)`,
    ),
  );
  const user = { userId: owner.id, email: owner.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId)!;
  viewer = { user, organization };
  for (const titleId of [mp, plain]) {
    await setSlotAlertFor(viewer, { machineId, titleId, alertAtUnits: 5 });
  }
  // 3 mystery packs och 1 av den vanliga titeln i automaten.
  await count(mp, 3, "2026-11-03T20:00:00Z");
  await count(plain, 1, "2026-11-03T20:00:00Z");
});

afterAll(async () => {
  await fake?.stop();
});

describe("3 kvar i mystery-facket", () => {
  it("Fyll på: inget förslag, inte snart slut, och ett antal ger varningen", async () => {
    const r = await fillRow(mp);
    expect(r).toMatchObject({ now: 3, suggested: 0, status: null, emptySlots: 0, batchSize: 14 });
    expect(mysteryNote(r, 14)).toBe("Mystery-facket fylls bara på när det är tomt");
    expect(mysteryNote(r, 0)).toBeNull();
    // Den vanliga titeln som förut.
    const p = await fillRow(plain);
    expect(p.suggested).toBeGreaterThan(0);
    expect(p.status).not.toBeNull();
    expect(mysteryNote(p, 5)).toBeNull();
  });

  it("Att göra och larm: ingenting för mystery-facket, den vanliga titeln som förut", async () => {
    const keys = (await todos()).map((t) => t.key);
    expect(keys).not.toContain(`refill:${machineId}:${mp}`);
    expect(keys).toContain(`refill:${machineId}:${plain}`);
    const low = (await lowStock()).map((c) => c.titleId);
    expect(low).not.toContain(mp);
    expect(low).toContain(plain);
  });
});

describe("tomt mystery-fack", () => {
  beforeAll(async () => {
    await count(mp, 0, "2026-11-04T07:00:00Z");
  });

  it("Fyll på: slut och förslaget är exakt en omgång (14)", async () => {
    const r = await fillRow(mp);
    expect(r).toMatchObject({ now: 0, suggested: 14, status: "empty" });
    expect(mysteryNote(r, 14)).toBeNull();
  });

  it("Att göra och larm: fyll på en hel omgång (14 st)", async () => {
    const item = (await todos()).find((t) => t.key === `refill:${machineId}:${mp}`);
    expect(item).toMatchObject({
      level: "now",
      title: "Mystery Pack Plus är slut i Sega gubbens automat – fyll på en hel omgång (14 st)",
    });
    const alert = (await lowStock()).find((c) => c.titleId === mp);
    expect(alert).toMatchObject({ severity: "critical" });
    expect(alert?.title).toContain("fyll på en hel omgång (14 st)");
  });

  it("push: bara det tomma facket fylls, med 14; den vanliga titeln som förut", async () => {
    fake = await startFakeAwishWeb({
      products: {
        "2001": [
          {
            id: 31,
            goodId: 7,
            goodName: "Mystery Pack Plus",
            status: true,
            currentInventory: 0,
            capacity: 20,
            channelName: "A1",
          },
          {
            id: 32,
            goodId: 8,
            goodName: "30th Celebration",
            status: true,
            currentInventory: 1,
            capacity: 10,
            channelName: "A2",
          },
        ],
      },
    });
    const { dataSourceId } = await saveAwishCredentialsFor(viewer, {
      appId: "app",
      appSecret: "secret",
      appKey: "key",
    });
    await db().execute(sql`
      insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
      values (${orgId}::uuid, ${dataSourceId}::uuid, '2001', 'BL-201', ${machineId}::uuid)
      on conflict (organization_id, data_source_id, external_id) do update set machine_id = ${machineId}::uuid`);
    await saveAwishWebCredentialsFor(viewer, {
      email: fake.state.email,
      password: fake.state.password,
    });
    await setAwishWebPushFor(viewer, true);
    await count(mp, 14, "2026-11-04T08:00:00Z", "refill");
    await count(plain, 5, "2026-11-04T08:00:00Z", "refill");
    const result = await pushMachinesToAwish(orgId, [machineId], {
      serviceDb: db(),
      makeClient: (o = {}) => createAwishWebClient({ ...o, baseUrl: fake!.baseUrl }),
      clientOptions: { baseUrl: fake.baseUrl },
    });
    expect(result.status).toBe("done");
    const slots = fake.state.products["2001"]!;
    expect(slots.find((p) => p.id === 31)?.currentInventory).toBe(14);
    expect(slots.find((p) => p.id === 32)?.currentInventory).toBe(6);
  });
});
