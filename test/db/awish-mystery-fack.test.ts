/**
 * Händelsen med BL-001 (Fyll på, Mystery Pack i A2) mot testdatabasen och låtsas-panelen:
 *
 *  - Mystery Pack (egen produkt med innehåll, omgång 14) låg 1 i A2, som rymmer 14. Fyll på
 *    lät ägaren lägga i 14 till (15). Awish fick de andra facken, men inte mystery-facket
 *    (det fylls bara på när det är tomt): beskedet ska säga vad, och att resten skickades.
 *  - Ägaren räknade om facket till 14 i Binderlab. Nästa försök ska skicka just det antalet
 *    (en räkning är inte en påfyllning) och automaten ska sluta vänta.
 *  - Rättar man i stället antalet i Awish ska nästa försök se att Awish redan stämmer och
 *    sluta vänta ('awish_push_cleared').
 *  - Ett vanligt fack med fler pack än det rymmer: det som fick plats skickas, resten sägs.
 *
 * Testet når aldrig riktiga Awish: webb-klienten pekas mot låtsas-panelen.
 */

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";

import { asPostgres, asUser, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

const { saveAwishCredentialsFor, saveAwishWebCredentialsFor, setAwishWebPushFor } =
  await import("../../src/server/awish/manage");
const { startFakeAwishWeb } = await import("../../src/server/awish/testing/fake-web-server");
type FakeWeb = Awaited<ReturnType<typeof startFakeAwishWeb>>;
const { createAwishWebClient } = await import("../../src/server/awish/web-client");
const { pushMachinesToAwish, retryPendingAwishPushes } =
  await import("../../src/server/awish/web-service");
const { summariseAwishPush } = await import("../../src/server/awish/push-status");
const { pendingAwishPushes } = await import("../../src/server/varde/log");

const NOW = 1_762_250_000_000;

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeWeb;
let owner: TestUser;
let orgId: string;
let machineId: string;
let locationId: string;
const titleIds = new Map<string, string>();

const deps = () => ({
  serviceDb: db(),
  makeClient: (o: Parameters<typeof createAwishWebClient>[0] = {}) =>
    createAwishWebClient({ ...o, baseUrl: fake.baseUrl, now: () => NOW }),
  clientOptions: { baseUrl: fake.baseUrl, now: () => NOW },
});

const slot = (id: number) => fake.state.products["1001"]!.find((p) => p.id === id)!;

/** En händelse i automaten: count (räkning av en person), refill eller count från Awish. */
async function event(
  title: string,
  kind: "count" | "refill",
  quantity: number,
  minutesAgo: number,
  source: "awish" | null = null,
): Promise<void> {
  const titleId = titleIds.get(title)!;
  await asPostgres((tx) =>
    tx.execute(sql`
      insert into public.stock_events
        (organization_id, location_id, title_id, kind, quantity, occurred_at, note, source)
      values (${orgId}::uuid, ${locationId}::uuid, ${titleId}::uuid, ${kind}, ${quantity},
              now() - make_interval(mins => ${minutesAgo}), 'test', ${source})`),
  );
}

async function logKinds(): Promise<string[]> {
  const r = await rows<{ kind: string }>(
    db(),
    sql`select kind from public.automation_log
        where organization_id = ${orgId}::uuid and machine_id = ${machineId}::uuid
        order by occurred_at, created_at, id`,
  );
  return r.map((x) => x.kind);
}

const pending = async () => [...(await pendingAwishPushes(db(), orgId, [machineId])).keys()];

beforeEach(async () => {
  fake = await startFakeAwishWeb({
    now: () => NOW,
    products: {
      "1001": [
        {
          id: 11,
          goodId: 5,
          goodName: "30th Celebration",
          status: true,
          currentInventory: 8,
          capacity: 14,
          channelName: "A1",
        },
        {
          id: 12,
          goodId: 6,
          goodName: "Mystery Pack",
          status: true,
          currentInventory: 1,
          capacity: 14,
          channelName: "A2",
        },
        {
          id: 13,
          goodId: 7,
          goodName: "Surging Sparks",
          status: true,
          currentInventory: 1,
          capacity: 14,
          channelName: "A3",
        },
      ],
    },
  });
  // Egen organisation per test: automation_log (väntar/klart) delas inte mellan testerna.
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
  await asUser(owner, async (tx) => {
    const titles = await tx
      .insert(s.titles)
      .values([
        { organizationId: orgId, name: "30th Celebration" },
        { organizationId: orgId, name: "Mystery Pack", ownProduct: true },
        { organizationId: orgId, name: "Surging Sparks" },
      ])
      .returning();
    for (const t of titles) titleIds.set(t.name, t.id);
    await tx.execute(
      sql`select public.save_mystery_recipe(${orgId}::uuid, ${titleIds.get("Mystery Pack")!}::uuid, 14,
            ${JSON.stringify([{ titleId: titleIds.get("30th Celebration")!, quantity: 14, hit: true }])}::jsonb)`,
    );
  });
  const viewer = await viewerFor(owner, orgId);
  const { dataSourceId } = await saveAwishCredentialsFor(viewer, {
    appId: "app",
    appSecret: "secret",
    appKey: "key",
  });
  await db().execute(sql`
    insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
    values (${orgId}::uuid, ${dataSourceId}::uuid, '1001', 'Sega gubben', ${machineId}::uuid)`);
  await saveAwishWebCredentialsFor(viewer, {
    email: fake.state.email,
    password: fake.state.password,
  });
  await setAwishWebPushFor(viewer, true);
  // Saldot före påfyllningen (Awish-läsningen): samma som Awish.
  await event("30th Celebration", "count", 8, 60, "awish");
  await event("Mystery Pack", "count", 1, 60, "awish");
  await event("Surging Sparks", "count", 1, 60, "awish");
});

afterEach(async () => {
  await fake.stop();
});

describe("BL-001: mystery-facket A2 som inte var tomt", () => {
  it("påfyllningen: de andra facken skickas, beskedet säger vad som inte gick och att resten gick", async () => {
    // Fyll på: 30th Celebration +6 (8 → 14), Mystery Pack +14 (1 → 15).
    await event("30th Celebration", "refill", 6, 2);
    await event("Mystery Pack", "refill", 14, 2);
    const result = await pushMachinesToAwish(orgId, [machineId], deps());
    const m = result.machines[0]!;
    // Inte "capacity": mystery-facket hade 1 pack kvar och fylls bara på när det är tomt.
    expect(m.status).toBe("pushed");
    expect(m.slotsUpdated).toBe(1);
    expect(m.notSent).toEqual([
      { titleName: "Mystery Pack", left: 14, reason: "mystery_not_empty" },
    ]);
    expect(slot(11).currentInventory).toBe(14);
    expect(slot(12).currentInventory).toBe(1);
    // Väntar: markeringen före sändningen, sändningen av de andra facken, och väntan.
    expect(await logKinds()).toEqual(["awish_push_failed", "awish_push", "awish_push_failed"]);
    const status = summariseAwishPush(result, [machineId])!;
    expect(status.kind).toBe("notSent");
    expect(status.notSent?.[0]).toMatchObject({ machineId, reason: "mystery_not_empty" });
    expect(status.message).toBe(
      "Sparat i Binderlab. 1 fack skickades till Awish. Awish tog inte emot allt: 14 Mystery Pack skickades inte till BL-001: mystery-facket är inte tomt. Räkna om facket här, så skickar appen rätt antal.",
    );
  });

  it("efter Räkna om till 14 skickar nästa försök 14 och automaten slutar vänta", async () => {
    await event("30th Celebration", "refill", 6, 3);
    await event("Mystery Pack", "refill", 14, 3);
    await pushMachinesToAwish(orgId, [machineId], deps());
    expect(await pending()).toEqual([machineId]);

    // Ägaren räknar facket i Binderlab: 14 (en person, ingen källa).
    await event("Mystery Pack", "count", 14, 1);
    const r = await retryPendingAwishPushes(orgId, [machineId], deps());
    expect(r.push?.machines[0]?.notSent).toBeUndefined();
    expect(slot(12).currentInventory).toBe(14);
    expect(r.pending).toEqual([]);
    expect((await logKinds()).at(-1)).toBe("awish_push");
    expect(summariseAwishPush(r.push!)?.kind).toBe("sent");
  });

  it("en påfyllning efter räkningen följer mystery-regeln igen", async () => {
    await event("Mystery Pack", "count", 1, 5);
    await event("Mystery Pack", "refill", 5, 2);
    const result = await pushMachinesToAwish(orgId, [machineId], deps());
    expect(result.machines[0]?.notSent).toEqual([
      { titleName: "Mystery Pack", left: 5, reason: "mystery_not_empty" },
    ]);
    expect(slot(12).currentInventory).toBe(1);
  });

  it("rättat i Awish: nästa försök ser att Awish stämmer och automaten slutar vänta", async () => {
    await event("Mystery Pack", "refill", 14, 3);
    await pushMachinesToAwish(orgId, [machineId], deps());
    await event("Mystery Pack", "count", 14, 1);
    // Ägaren skriver 14 i Awishs egen panel innan appen hinner försöka igen.
    slot(12).currentInventory = 14;
    const before = fake.state.calls.filter((c) => c.operationName === "UpdateProduct").length;
    const r = await retryPendingAwishPushes(orgId, [machineId], deps());
    expect(r.pending).toEqual([]);
    expect((await logKinds()).at(-1)).toBe("awish_push_cleared");
    // Inget skickades (Awish hade redan rätt), och beskedet säger det.
    expect(fake.state.calls.filter((c) => c.operationName === "UpdateProduct").length).toBe(before);
    expect(summariseAwishPush(r.push!)?.kind).toBe("alreadyRight");
  });
});

describe("vanligt fack med fler pack än det rymmer", () => {
  it("det som får plats skickas, resten sägs, och efter Räkna om slutar automaten vänta", async () => {
    // Surging Sparks: 1 i facket, +14 → 15, facket rymmer 14. 30th Celebration +6 går fram.
    await event("Surging Sparks", "refill", 14, 3);
    await event("30th Celebration", "refill", 6, 3);
    const result = await pushMachinesToAwish(orgId, [machineId], deps());
    expect(result.machines[0]?.notSent).toEqual([
      { titleName: "Surging Sparks", left: 1, reason: "capacity" },
    ]);
    expect(slot(13).currentInventory).toBe(14);
    expect(slot(11).currentInventory).toBe(14);
    const status = summariseAwishPush(result, [machineId])!;
    expect(status.message).toBe(
      "Sparat i Binderlab. 2 fack skickades till Awish. Awish tog inte emot allt: 1 Surging Sparks fick inte plats i BL-001. Räkna om facket här, så skickar appen rätt antal.",
    );
    expect(await pending()).toEqual([machineId]);

    await event("Surging Sparks", "count", 14, 1);
    const r = await retryPendingAwishPushes(orgId, [machineId], deps());
    expect(r.pending).toEqual([]);
    expect((await logKinds()).at(-1)).toBe("awish_push_cleared");
  });
});
