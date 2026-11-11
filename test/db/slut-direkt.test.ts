/**
 * "Slut i automat" direkt (runda 2, T4-1) mot testdatabasen och låtsas-Awish:
 *
 * - synken jämför saldot före och efter läsningen: 3 → 0 ger `stockDropped` en gång, nästa
 *   synk med facket fortfarande på 0 ger ingenting,
 * - Awish-cronens larmsteg (runOfflineAlerts) utvärderar bara organisationen då,
 * - larmet kl. 02 väntar till de tysta timmarna är slut och skickas då av nästa körning,
 *   utan att larmjobbet (en gång om dygnet) behöver gå,
 * - notisen är en per automat: namn, butik, antal och länk till Fyll på,
 * - Uppdatera i Fyll på larmar inte själv men flaggar för nästa synk.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AlertDelivery } from "../../src/analytics/alerts";
import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { saveNoticeChange } from "../../src/server/alerts/notice-service";
import { runOfflineAlerts } from "../../src/server/awish/offline-alerts";
import { parseState, readFillStock, syncAwishSource } from "../../src/server/awish/sync";
import {
  fakeOrder,
  startFakeAwish,
  type FakeAwish,
} from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";
import { pushPayloads, type PushContext } from "../../src/server/notify/content";
import type { PushPayload } from "../../src/server/notify/push";

import { asUser, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

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

const products = (sparks: number, bolt: number) => [
  { channel: "A1", good: "Surging Sparks", current: sparks, capacity: 8 },
  { channel: "A2", good: "Black Bolt", current: bolt, capacity: 8 },
];

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [{ id: "2", name: "Sega gubben", machine_no: "163271xx" }],
    // Båda titlarna säljer varje dag: de har en takt, så slut ger larm.
    orders: [5, 6, 7, 8, 9, 10].flatMap((day, i) => [
      fakeOrder(7000 + i, {
        date: `2026-11-${String(day).padStart(2, "0")}`,
        payTime: `2026-11-${String(day).padStart(2, "0")} 12:00:00`,
        title: "Surging Sparks",
      }),
      fakeOrder(7100 + i, {
        date: `2026-11-${String(day).padStart(2, "0")}`,
        payTime: `2026-11-${String(day).padStart(2, "0")} 13:00:00`,
        title: "Black Bolt",
      }),
    ]),
    products: { "2": products(3, 4) },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("slut i automat kommer direkt", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;
  let machineId: string;
  let now = new Date("2026-11-11T10:00:00Z");

  const sync = (trigger: "schedule" | "manual" = "schedule") =>
    syncAwishSource({ db: db(), connect, now: () => now }, { dataSourceId: sourceId, trigger });

  const sent: { userId: string; push: PushPayload[] }[] = [];
  const alerts = (stockOrgIds: string[]) =>
    runOfflineAlerts(db(), [orgId], {
      now,
      baseUrl: "http://test",
      stockOrgIds,
      dispatch: async (delivery: AlertDelivery, recipient, options) => {
        // Utskicken är gemensamma för alla organisationer i testdatabasen: andra testfilers
        // väntande utskick går också ut här. Bara den här ägarens räknas.
        if (recipient.userId !== owner.id) {
          return { results: [], goneDevices: [], okDevices: [], status: "sent" };
        }
        sent.push({
          userId: recipient.userId,
          push: pushPayloads(delivery, (options as { push?: PushContext }).push),
        });
        return {
          results: [{ channel: "push", status: "sent", detail: "test" }],
          goneDevices: [],
          okDevices: [],
          status: "sent",
        };
      },
    });
  const lowAlerts = () =>
    rows<{ title: string; severity: string; status: string }>(
      db(),
      sql`select title, severity::text as severity, status::text as status from public.alerts
          where organization_id = ${orgId}::uuid and kind = 'low_stock' order by title`,
    );
  const pending = () =>
    rows<{ send_at: Date; deferred: boolean }>(
      db(),
      sql`select send_at, deferred from public.alert_deliveries
          where organization_id = ${orgId}::uuid and status = 'pending'`,
    );
  const state = async () =>
    parseState(
      (
        await one<{ cursor: string }>(
          db(),
          sql`select cursor from public.data_sources where id = ${sourceId}::uuid`,
        )
      ).cursor,
    );

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    const [machine] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-003",
          name: "Automat 3",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    machineId = machine!.id;
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
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
    // Ägaren slår på Notiser (standard: tysta timmar 22–07).
    await asUser(owner, (tx) =>
      saveNoticeChange(tx, { orgId, userId: owner.id, role: "owner" }, { on: true }),
    );
    // Första synken hittar automaten; sedan kopplas den.
    const first = await sync("manual");
    expect(first.ok, first.message ?? "").toBe(true);
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '2'`,
    );
  }, 120_000);

  it("första läsningen (saldot blir känt) och vanlig försäljning räknas inte som 'just slut'", async () => {
    now = new Date("2026-11-11T10:05:00Z");
    const r = await sync("manual");
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.stock).toMatchObject({ read: 1 });
    expect(r.stockDropped).toEqual([]);

    fake.state.products["2"] = products(2, 4);
    now = new Date("2026-11-11T10:10:00Z");
    expect((await sync()).stockDropped).toEqual([]);
    // Inget nytt slut: larmen utvärderas inte.
    expect((await alerts([])).organizations).toEqual([]);
    expect(await lowAlerts()).toEqual([]);
  });

  it("2 → 0 kl. 02: stockDropped en gång, larmet skapas direkt men väntar till kl. 07", async () => {
    fake.state.products["2"] = products(0, 4);
    now = new Date("2026-11-12T01:00:00Z"); // 02:00 svensk tid
    const r = await sync();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.stockDropped).toEqual([machineId]);

    const run = await alerts((r.stockDropped ?? []).length > 0 ? [orgId] : []);
    expect(run.organizations.map((o) => [o.organizationId, o.status])).toEqual([[orgId, "ok"]]);
    expect(await lowAlerts()).toEqual([
      { title: "Surging Sparks är slut i Automat 3", severity: "critical", status: "open" },
    ]);
    // Tysta timmar (22–07 som standard): inget skickas nu.
    expect(sent).toEqual([]);
    const queue = await pending();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.deferred).toBe(true);
    expect(new Date(queue[0]!.send_at).toISOString()).toBe("2026-11-12T06:00:00.000Z");
  });

  it("nästa synk med facket fortfarande på 0 startar ingen ny kontroll", async () => {
    now = new Date("2026-11-12T01:05:00Z");
    const r = await sync();
    expect(r.stock).toMatchObject({ read: 1, counts: 0 });
    expect(r.stockDropped).toEqual([]);
    const run = await alerts((r.stockDropped ?? []).length > 0 ? [orgId] : []);
    expect(run.organizations).toEqual([]);
    expect(sent).toEqual([]);
    expect(await pending()).toHaveLength(1);
  });

  it("kl. 07 skickar nästa körning notisen: en per automat, till Fyll på", async () => {
    now = new Date("2026-11-12T06:01:00Z"); // 07:01 svensk tid
    const run = await alerts([]);
    expect(run.organizations).toEqual([]);
    expect(run.deliveries?.sent).toBeGreaterThanOrEqual(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.userId).toBe(owner.id);
    // Påfyllningen är en egen notis, först. (Testets hopp i tiden ger också ett larm om
    // hämtningen: det kommer som en andra notis, som förut.)
    expect(sent[0]!.push[0]).toEqual({
      title: "BL-003 Automat 3 Sega gubben",
      body: "Surging Sparks är slut. Tryck för att fylla på.",
      url: `/fyll-pa/${machineId}`,
      tag: `fyll-${machineId}`,
      severity: "critical",
    });
    expect(sent[0]!.push.slice(1).every((p) => !p.url.startsWith("/fyll-pa"))).toBe(true);
    expect(await pending()).toEqual([]);
  });

  it("på dagen går notisen direkt och säger automatens hela läge", async () => {
    sent.length = 0;
    fake.state.products["2"] = products(0, 0);
    now = new Date("2026-11-12T11:00:00Z");
    const r = await sync();
    expect(r.stockDropped).toEqual([machineId]);
    const run = await alerts((r.stockDropped ?? []).length > 0 ? [orgId] : []);
    expect(run.deliveries?.sent).toBeGreaterThanOrEqual(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.push[0]).toEqual({
      title: "BL-003 Automat 3 Sega gubben",
      body: "2\u00a0slut. Tryck för att fylla på.",
      url: `/fyll-pa/${machineId}`,
      tag: `fyll-${machineId}`,
      severity: "critical",
    });
  });

  it("Uppdatera i Fyll på larmar inte själv: nästa synk tar med det en gång", async () => {
    // Påfyllt och sedan slutsålt igen, sett av Uppdatera i Fyll på.
    fake.state.products["2"] = products(5, 5);
    now = new Date("2026-11-12T11:05:00Z");
    expect((await sync()).stockDropped).toEqual([]);
    expect((await state()).alertCheckDue).toBeUndefined();

    fake.state.products["2"] = products(0, 5);
    now = new Date("2026-11-12T11:07:00Z");
    const read = await readFillStock(
      { db: db(), connect, now: () => now },
      { dataSourceId: sourceId, minIntervalMs: 0 },
    );
    expect(read.status).toBe("read");
    expect((await state()).alertCheckDue).toBe(true);

    now = new Date("2026-11-12T11:10:00Z");
    const next = await sync();
    expect(next.stockDropped).toEqual([]);
    expect(next.alertCheckDue).toBe(true);
    expect((await state()).alertCheckDue).toBeUndefined();
    now = new Date("2026-11-12T11:15:00Z");
    expect((await sync()).alertCheckDue).toBeUndefined();
  });

  it("larmgränsen: saldot når gränsen räknas, en gång", async () => {
    const title = await one<{ id: string }>(
      db(),
      sql`select id from public.titles
          where organization_id = ${orgId}::uuid and name = 'Black Bolt'`,
    );
    await asUser(owner, (tx) =>
      tx.insert(s.slotAlerts).values({
        organizationId: orgId,
        machineId,
        titleId: title.id,
        alertAtUnits: 3,
      }),
    );
    fake.state.products["2"] = products(0, 3);
    now = new Date("2026-11-12T11:20:00Z");
    expect((await sync()).stockDropped).toEqual([machineId]);
    fake.state.products["2"] = products(0, 2);
    now = new Date("2026-11-12T11:25:00Z");
    expect((await sync()).stockDropped).toEqual([]);
  });

  it("sista packet säljs (ordern drar saldot till 0 före läsningen av facken): räknas ändå", async () => {
    // Påfyllt till 1 pack. Sedan säljs det: ordern och det tomma facket kommer i samma synk.
    fake.state.products["2"] = products(1, 6);
    now = new Date("2026-11-12T11:30:00Z");
    expect((await sync()).stockDropped).toEqual([]);
    fake.state.orders.push(
      fakeOrder(7900, {
        date: "2026-11-12",
        // Awish skriver tiden i Asia/Shanghai: 19:32 där = 11:32Z, efter läsningen 11:30Z.
        payTime: "2026-11-12 19:32:00",
        title: "Surging Sparks",
      }),
    );
    fake.state.products["2"] = products(0, 6);
    now = new Date("2026-11-12T11:35:00Z");
    const r = await sync();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.summary?.new).toBe(1);
    // Facken stämmer redan med saldot (ordern drog packet): ingen inventering behövdes.
    expect(r.stock).toMatchObject({ read: 1, counts: 0 });
    expect(r.stockDropped).toEqual([machineId]);
    now = new Date("2026-11-12T11:40:00Z");
    expect((await sync()).stockDropped).toEqual([]);
  });

  it("Synka nu larmar inte själv: det som blev slut sparas till nästa schemalagda synk", async () => {
    fake.state.products["2"] = products(4, 6);
    now = new Date("2026-11-12T11:45:00Z");
    await sync();
    fake.state.products["2"] = products(0, 6);
    now = new Date("2026-11-12T11:47:00Z");
    const manual = await sync("manual");
    expect(manual.stockDropped).toEqual([machineId]);
    expect(manual.alertCheckDue).toBeUndefined();
    expect((await state()).alertCheckDue).toBe(true);
    now = new Date("2026-11-12T11:50:00Z");
    const next = await sync();
    expect(next.stockDropped).toEqual([]);
    expect(next.alertCheckDue).toBe(true);
    expect((await state()).alertCheckDue).toBeUndefined();
  });

  it("den som har engelska i profilen får notisen på engelska", async () => {
    // Påfyllt: larmen stängs. Sedan slut igen.
    fake.state.products["2"] = products(6, 6);
    now = new Date("2026-11-12T12:00:00Z");
    await sync();
    await alerts([orgId]);
    expect((await lowAlerts()).every((a) => a.status !== "open")).toBe(true);
    await db().execute(
      sql`update public.profiles set locale = 'en'
          where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`,
    );
    sent.length = 0;
    fake.state.products["2"] = products(0, 6);
    // Mer än två timmar senare: annars räknas det som fladder (samma incident, ingen ny notis).
    now = new Date("2026-11-12T15:00:00Z");
    expect((await sync()).stockDropped).toEqual([machineId]);
    await alerts([orgId]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.push[0]).toMatchObject({
      title: "BL-003 Automat 3 Sega gubben",
      body: "1\u00a0empty. Tap to refill.",
      url: `/fyll-pa/${machineId}`,
      lang: "en",
    });
  });
});
