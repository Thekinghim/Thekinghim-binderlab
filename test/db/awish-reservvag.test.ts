/**
 * Om Awish krånglar: reservvägarna mot testdatabasen, låtsas-Awish (gRPC) och låtsas-panelen
 * (webb). Aldrig riktiga Awish.
 *
 * (a) Products svarar internt fel (13) men Orders fungerar: facken läses via webbpanelen med
 *     samma kapacitet som Open API, hälsan stock = webbpanelen och orders = open_api.
 * (b) Machines svarar inte: order, fack och slutdag körs ändå, machines = senast_kanda och
 *     anslutningen (awish_seen_at) ändras inte (inga falska offlinelarm).
 * (c) Orders internt fel: fack och slutdag körs, läget (sidorna) flyttas inte fram, och nästa
 *     körning hämtar det som missades.
 * (d) Open API svarar inte i tid vid Uppdatera i Fyll på: reserven hinns med inom 8 s.
 * (e) Brytaren: nästa körning hoppar över Open API, efter 15 minuter provas det en gång.
 * (f) Webbpanelen nekar inloggningen: hälsan auth, brytaren öppen i 6 timmar, ingen ny
 *     inloggning under tiden.
 * (g) Tomt svar för en automat som hade fack: inget skrivs över.
 * (h) Slutdagen via webbpanelens Profile; misslyckas båda sparas inte tidpunkten, och nästa
 *     försök görs efter en timme.
 * (i) Gratis-pack via webbpanelen: spärrat utan id-kontroll, tillåtet med den.
 * (j) En uppladdad Awish-CSV efter API-orderna: samma försäljning räknas inte två gånger.
 * (k) Brytaren "Skicka till Awish" är av men inloggningen sparad: reserven fungerar ändå.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as grpc from "@grpc/grpc-js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { refreshFillStockFor } from "../../src/server/awish/fill-read";
import { createAwishClient, type AwishCredentials } from "../../src/server/awish/grpc-client";
import { loadAwishHealth } from "../../src/server/awish/health";
import {
  saveAwishCredentialsFor,
  saveAwishWebCredentialsFor,
  testWebFallbackFor,
} from "../../src/server/awish/manage";
import { parseState, syncAwishSource, type AwishConnectOptions } from "../../src/server/awish/sync";
import {
  fakeOrder,
  startFakeAwish,
  type FakeAwish,
} from "../../src/server/awish/testing/fake-server";
import {
  startFakeAwishWeb,
  type FakeWeb,
  type FakeWebProduct,
} from "../../src/server/awish/testing/fake-web-server";
import {
  createAwishWebClient,
  type AwishWebClientOptions,
} from "../../src/server/awish/web-client";
import type { Viewer } from "../../src/server/data/core/loaders";
import {
  createFreePacksFor,
  freePackChoicesFor,
  FREE_PACKS_DOWN,
} from "../../src/server/free-packs/service";
import { LocalFileStore } from "../../src/import/file-store";
import { runImport } from "../../src/import/run-import";

import { asUser, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeAwish;
let web: FakeWeb;

const connect = (creds: AwishCredentials, options: AwishConnectOptions = {}) =>
  createAwishClient(creds, {
    address: fake.address,
    tls: false,
    sleep: async () => {},
    ...options,
  });
const makeWebClient = (o: AwishWebClientOptions) =>
  createAwishWebClient({ ...o, baseUrl: web.baseUrl, sleep: async () => {} });

/** Facken i Awish: Open API:s kapacitet (inventory) 8; panelens kanal rymmer 10. */
const GRPC_SLOTS = [
  { channel: "A1", good: "Surging Sparks", current: 3, capacity: 8 },
  { channel: "A2", good: "Black Bolt", current: 5, capacity: 8 },
];
const webSlots = (): FakeWebProduct[] => [
  {
    id: 1,
    goodId: 501,
    goodName: "Surging Sparks",
    status: true,
    currentInventory: 3,
    capacity: 10,
    inventory: 8,
    channelName: "A1",
  },
  {
    id: 2,
    goodId: 502,
    goodName: "Black Bolt",
    status: true,
    currentInventory: 5,
    capacity: 10,
    inventory: 8,
    channelName: "A2",
  },
];

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [
      { id: "2", name: "Sega gubben", machine_no: "163271xx" },
      { id: "3", name: "Kontoret", machine_no: "163272xx" },
    ],
    orders: [fakeOrder(7001, { payTime: "2026-11-24 09:00:00" })],
    products: { "2": [...GRPC_SLOTS], "3": [...GRPC_SLOTS] },
  });
  web = await startFakeAwishWeb({
    machines: [
      { id: 2, machineNo: "163271xx", name: "Sega gubben" },
      { id: 3, machineNo: "163272xx", name: "Kontoret" },
    ],
    products: { "2": webSlots(), "3": webSlots() },
  });
});
afterAll(async () => {
  await fake.stop();
  await web.stop();
});
beforeEach(() => {
  fake.state.failWith = {};
  fake.state.failTimes = {};
  fake.state.delayByMethod = {};
  fake.state.products = { "2": [...GRPC_SLOTS], "3": [...GRPC_SLOTS] };
  fake.state.orders = [fakeOrder(7001, { payTime: "2026-11-24 09:00:00" })];
  web.state.authFail = false;
  web.state.failTimes = {};
  web.state.delayMs = 0;
  web.state.products = { "2": webSlots(), "3": webSlots() };
  web.state.merchantExpiredAt = "2027-04-18 23:48:54";
});

interface Org {
  owner: TestUser;
  orgId: string;
  sourceId: string;
  machineIds: string[];
  now: () => Date;
  setNow(d: Date): void;
  sync(): ReturnType<typeof syncAwishSource>;
  health(path: string): Promise<Record<string, unknown> | undefined>;
  calls(method: string): number;
}

/** En organisation med Awish API, webbinloggning (push av) och två kopplade automater. */
async function setupOrg(options: { beforeFirstSync?: () => void } = {}): Promise<Org> {
  const owner = await createUser();
  const orgId = await createOrg(owner);
  let current = new Date("2026-11-24T10:00:00Z");
  const now = () => current;
  const machineIds: string[] = [];
  for (const code of ["BL-002", "BL-003"]) {
    const [m] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({ organizationId: orgId, code, name: `Automat ${code}`, activeFrom: "2026-10-01" })
        .returning(),
    );
    machineIds.push(m!.id);
  }
  const viewer = await viewerFor(owner, orgId);
  const { dataSourceId: sourceId } = await saveAwishCredentialsFor(viewer, {
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  });
  await saveAwishWebCredentialsFor(viewer, {
    email: web.state.email,
    password: web.state.password,
  });
  const sync = () =>
    syncAwishSource(
      { db: db(), connect, now, makeWebClient },
      { dataSourceId: sourceId, trigger: "manual" },
    );
  // Första synken skapar källautomaterna (facken läses inte: inget är kopplat än).
  options.beforeFirstSync?.();
  const first = await sync();
  expect(first.ok, first.message ?? "").toBe(true);
  for (const [i, ext] of ["2", "3"].entries()) {
    await db().execute(
      sql`update public.source_machines set machine_id = ${machineIds[i]!}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = ${ext}`,
    );
  }
  return {
    owner,
    orgId,
    sourceId,
    machineIds,
    now,
    setNow(d) {
      current = d;
    },
    sync,
    async health(p) {
      const [row] = await rows(
        db(),
        sql`select * from public.awish_path_health
            where data_source_id = ${sourceId}::uuid and path = ${p}`,
      );
      return row;
    },
    calls: (method) => fake.state.calls.filter((c) => c.method === method).length,
  };
}

const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

async function fillOf(machineId: string) {
  return one<{ fill: { units: number; capacity: number }[] | null; at: Date | null }>(
    db(),
    sql`select awish_fill as fill, awish_synced_at as at from public.stock_locations
        where machine_id = ${machineId}::uuid`,
  );
}

describe("(a, k, e) Products internt fel, Orders fungerar", () => {
  let org: Org;
  beforeAll(async () => {
    org = await setupOrg();
  });

  it("(k) push är av men inloggningen sparad", async () => {
    const [src] = await rows<{ enabled: boolean | null }>(
      db(),
      sql`select (config -> 'awishWeb' ->> 'enabled')::boolean as enabled
          from public.data_sources where id = ${org.sourceId}::uuid`,
    );
    expect(src?.enabled ?? false).toBe(false);
  });

  it("(a) facken läses via webbpanelen med samma kapacitet som Open API", async () => {
    // Först med Open API: kapaciteten enligt Awish.
    const ok = await org.sync();
    expect(ok.stock?.read).toBe(2);
    const viaApi = await fillOf(org.machineIds[0]!);
    expect((await org.health("stock"))?.active_route).toBe("open_api");

    fake.state.failWith = { Products: grpc.status.INTERNAL };
    const productsBefore = org.calls("Products");
    org.setNow(minutes(org.now(), 5));
    const r = await org.sync();
    expect(r.ok).toBe(true);
    expect(r.stock).toMatchObject({ read: 2, failed: 0, viaWeb: 2 });
    // In-run-brytaren: Open API provades en gång (inget nytt försök), sedan bara panelen.
    expect(org.calls("Products") - productsBefore).toBe(1);
    const viaWeb = await fillOf(org.machineIds[0]!);
    expect(viaWeb.fill).toEqual(viaApi.fill);
    expect(iso(viaWeb.at)).toBe(org.now().toISOString());

    const stock = await org.health("stock");
    expect(stock).toMatchObject({ active_route: "webbpanelen", last_error_code: 13 });
    expect(stock?.failing_since).toBeNull();
    expect(stock?.breaker_route).toBe("open_api");
    expect((await org.health("orders"))?.active_route).toBe("open_api");
    const state = parseState(
      (
        await one<{ cursor: string }>(
          db(),
          sql`select cursor from public.data_sources where id = ${org.sourceId}::uuid`,
        )
      ).cursor,
    );
    expect(state.lastRun?.steps).toMatchObject({
      machines: { ok: true, via: "open_api" },
      orders: { ok: true, via: "open_api" },
      stock: { ok: true, via: "webbpanelen" },
    });
    // Ägaren och läsaren ser hälsan (RLS), servern läser den.
    const health = await loadAwishHealth(db(), org.orgId);
    expect(health.map((h) => h.path)).toEqual(expect.arrayContaining(["orders", "stock"]));
  });

  it("(e) brytaren: nästa körning hoppar över Open API; efter 15 min provas det en gång", async () => {
    fake.state.failWith = { Products: grpc.status.INTERNAL };
    const before = org.calls("Products");
    org.setNow(minutes(org.now(), 5));
    const r = await org.sync();
    expect(r.stock).toMatchObject({ read: 2, viaWeb: 2 });
    expect(org.calls("Products")).toBe(before);

    // Efter 16 minuter: en provning (fortfarande fel), brytaren öppnas igen.
    org.setNow(minutes(org.now(), 16));
    await org.sync();
    expect(org.calls("Products")).toBe(before + 1);
    const reopened = await org.health("stock");
    expect(iso(reopened?.breaker_open_until)).toBe(minutes(org.now(), 15).toISOString());

    // Open API fungerar igen: provningen lyckas, brytaren stängs.
    fake.state.failWith = {};
    org.setNow(minutes(org.now(), 16));
    const back = await org.sync();
    expect(back.stock).toMatchObject({ read: 2, failed: 0 });
    expect(back.stock?.viaWeb).toBeUndefined();
    const closed = await org.health("stock");
    expect(closed).toMatchObject({ active_route: "open_api", breaker_route: null });
  });
});

describe("(b) Machines svarar inte", () => {
  it("order, fack och slutdag körs ändå; automaterna = senast kända, anslutningen orörd", async () => {
    const org = await setupOrg();
    await org.sync();
    const seen = await rows<{ external_id: string; seen: Date | null }>(
      db(),
      sql`select external_id, awish_seen_at as seen from public.source_machines
          where data_source_id = ${org.sourceId}::uuid order by external_id`,
    );
    fake.state.failWith = { Machines: grpc.status.UNAVAILABLE };
    fake.state.orders = [
      fakeOrder(7001, { payTime: "2026-11-24 09:00:00" }),
      fakeOrder(7002, { payTime: "2026-11-24 09:30:00" }),
    ];
    org.setNow(minutes(org.now(), 30));
    const r = await org.sync();
    expect(r.ok, r.message ?? "").toBe(true);
    expect(r.summary?.new).toBe(1);
    expect(r.stock?.read).toBe(2);
    const machines = await org.health("machines");
    expect(machines).toMatchObject({
      active_route: "senast_kanda",
      last_error_kind: "unavailable",
    });
    expect(machines?.failing_since).not.toBeNull();
    const after = await rows<{ external_id: string; seen: Date | null }>(
      db(),
      sql`select external_id, awish_seen_at as seen from public.source_machines
          where data_source_id = ${org.sourceId}::uuid order by external_id`,
    );
    expect(after.map((x) => iso(x.seen))).toEqual(seen.map((x) => iso(x.seen)));
  });
});

describe("(c) Orders svarar med internt fel", () => {
  it("fack och slutdag körs, läget flyttas inte fram, nästa körning hämtar det som missades", async () => {
    const org = await setupOrg();
    const cursor = async () =>
      parseState(
        (
          await one<{ cursor: string }>(
            db(),
            sql`select cursor from public.data_sources where id = ${org.sourceId}::uuid`,
          )
        ).cursor,
      );
    const before = (await cursor()).paging;
    fake.state.failWith = { Orders: grpc.status.INTERNAL };
    fake.state.orders = [
      fakeOrder(7001, { payTime: "2026-11-24 09:00:00" }),
      fakeOrder(7003, { payTime: "2026-11-24 09:40:00" }),
    ];
    const ordersBefore = org.calls("Orders");
    org.setNow(minutes(org.now(), 10));
    const r = await org.sync();
    expect(r.ok).toBe(false);
    // Internt fel provas en gång till (läsning), sedan felet.
    expect(org.calls("Orders") - ordersBefore).toBe(2);
    expect(r.stock?.read).toBe(2);
    expect((await cursor()).paging).toEqual(before);
    expect(await org.health("orders")).toMatchObject({
      active_route: "senast_kanda",
      last_error_code: 13,
    });

    fake.state.failWith = {};
    org.setNow(minutes(org.now(), 5));
    const again = await org.sync();
    expect(again.ok).toBe(true);
    expect(again.summary?.new).toBe(1);
    expect((await org.health("orders"))?.failing_since).toBeNull();
  });
});

describe("(d) Uppdatera i Fyll på när Open API inte svarar i tid", () => {
  it("reservvägen hinns med inom 8 s", async () => {
    const org = await setupOrg();
    fake.state.delayByMethod = { Products: 9_000 };
    const viewer = await viewerFor(org.owner, org.orgId);
    org.setNow(minutes(org.now(), 2));
    const started = Date.now();
    const r = await refreshFillStockFor(viewer, {
      serviceDb: db(),
      connect,
      now: org.now,
      makeWebClient,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(r).toMatchObject({ status: "read", read: true, via: "webbpanelen" });
    expect((await org.health("stock"))?.active_route).toBe("webbpanelen");
  }, 20_000);
});

describe("(f) Webbpanelen nekar inloggningen i reservvägen", () => {
  it("hälsan auth, brytaren öppen i 6 timmar, ingen ny inloggning under tiden", async () => {
    const org = await setupOrg();
    fake.state.failWith = { Products: grpc.status.INTERNAL };
    web.state.authFail = true;
    const signins = () => web.state.calls.filter((c) => c.operationName === "Signin").length;
    const before = signins();
    org.setNow(minutes(org.now(), 5));
    const r = await org.sync();
    expect(r.stock).toMatchObject({ read: 0, failed: 2 });
    // En inloggning för hela körningen, inte en per automat.
    expect(signins() - before).toBe(1);
    const stock = await org.health("stock");
    expect(stock).toMatchObject({
      active_route: "senast_kanda",
      last_error_kind: "auth",
      breaker_route: "webbpanelen",
    });
    expect(iso(stock?.breaker_open_until)).toBe(minutes(org.now(), 360).toISOString());
    expect(stock?.failing_since).not.toBeNull();

    org.setNow(minutes(org.now(), 60));
    await org.sync();
    expect(signins() - before).toBe(1);

    // Nytt lösenord sparat: brytaren stängs, "Testa reservvägen" fungerar.
    web.state.authFail = false;
    const viewer = await viewerFor(org.owner, org.orgId);
    await saveAwishWebCredentialsFor(viewer, {
      email: web.state.email,
      password: web.state.password,
    });
    expect((await org.health("stock"))?.breaker_route).toBeNull();
    const test = await testWebFallbackFor(viewer, { serviceDb: db(), makeWebClient });
    expect(test).toMatchObject({ ok: true, slots: 2, machine: { code: "BL-002" } });
    expect((await org.health("slots"))?.active_route).toBe("webbpanelen");
  });
});

describe("(g) Tomt svar för en automat som hade fack", () => {
  it("förra läsningen behålls och felet sparas", async () => {
    const org = await setupOrg();
    await org.sync();
    const before = await fillOf(org.machineIds[0]!);
    const levels = await rows(
      db(),
      sql`select title_id, quantity from public.stock_levels sl
          join public.stock_locations l on l.id = sl.location_id
          where l.machine_id = ${org.machineIds[0]!}::uuid order by title_id`,
    );
    fake.state.products = { "2": [], "3": [...GRPC_SLOTS] };
    web.state.products = { "2": [], "3": webSlots() };
    org.setNow(minutes(org.now(), 5));
    const r = await org.sync();
    expect(r.stock).toMatchObject({ read: 1, failed: 1 });
    const after = await fillOf(org.machineIds[0]!);
    expect(after.fill).toEqual(before.fill);
    expect(iso(after.at)).toBe(iso(before.at));
    expect(
      await rows(
        db(),
        sql`select title_id, quantity from public.stock_levels sl
            join public.stock_locations l on l.id = sl.location_id
            where l.machine_id = ${org.machineIds[0]!}::uuid order by title_id`,
      ),
    ).toEqual(levels);
    expect((await org.health("stock"))?.last_error_kind).toBe("invalid_response");

    // Open API tomt men panelen har facken: panelen gäller.
    web.state.products = { "2": webSlots(), "3": webSlots() };
    org.setNow(minutes(org.now(), 5));
    const viaWeb = await org.sync();
    expect(viaWeb.stock).toMatchObject({ read: 2, failed: 0, viaWeb: 1 });
  });
});

describe("(h) Kontots slutdag", () => {
  const checkedAt = async (sourceId: string) =>
    one<{ expires: Date | null; checked: Date | null }>(
      db(),
      sql`select awish_expires_at as expires, awish_merchant_checked_at as checked
          from public.data_sources where id = ${sourceId}::uuid`,
    );

  it("läses via webbpanelens Profile när Merchant felar", async () => {
    const org = await setupOrg({
      beforeFirstSync: () => {
        fake.state.failWith = { Merchant: grpc.status.INTERNAL };
      },
    });
    const src = await checkedAt(org.sourceId);
    // Källans tidszon (Asia/Shanghai): 23:48:54 = 15:48:54 UTC.
    expect(iso(src.expires)).toBe("2027-04-18T15:48:54.000Z");
    expect(src.checked).not.toBeNull();
    expect((await org.health("merchant"))?.active_route).toBe("webbpanelen");
  });

  it("misslyckas båda vägarna sparas inte tidpunkten; nästa försök efter en timme", async () => {
    const org = await setupOrg({
      beforeFirstSync: () => {
        fake.state.failWith = { Merchant: grpc.status.INTERNAL };
        web.state.authFail = true;
      },
    });
    expect((await checkedAt(org.sourceId)).checked).toBeNull();
    expect((await org.health("merchant"))?.failing_since).not.toBeNull();
    const merchantCalls = org.calls("Merchant");
    org.setNow(minutes(org.now(), 30));
    await org.sync();
    expect(org.calls("Merchant")).toBe(merchantCalls);
    fake.state.failWith = {};
    org.setNow(minutes(org.now(), 31));
    await org.sync();
    expect(org.calls("Merchant")).toBeGreaterThan(merchantCalls);
    expect((await checkedAt(org.sourceId)).checked).not.toBeNull();
    expect((await org.health("merchant"))?.failing_since).toBeNull();
  });
});

describe("(i) Gratis-pack via webbpanelen", () => {
  it("spärrat utan id-kontroll, tillåtet när synken har visat att id:na stämmer", async () => {
    const org = await setupOrg();
    const viewer = await viewerFor(org.owner, org.orgId);
    const deps = { db: db(), connect, now: org.now, makeWebClient };
    // Ingen id-kontroll än (Open API har inte läst några kopplade automater).
    await db().execute(
      sql`delete from public.awish_path_health where data_source_id = ${org.sourceId}::uuid`,
    );
    fake.state.failWith = { Products: grpc.status.INTERNAL };
    await expect(freePackChoicesFor(viewer, org.machineIds[0]!, deps)).rejects.toThrow(
      FREE_PACKS_DOWN,
    );

    // Synken med fungerande Open API jämför id:na (en gång per dygn).
    fake.state.failWith = {};
    org.setNow(minutes(org.now(), 5));
    await org.sync();
    expect((await org.health("free_packs"))?.web_ids_verified_at).not.toBeNull();

    fake.state.failWith = { Products: grpc.status.INTERNAL };
    const choices = await freePackChoicesFor(viewer, org.machineIds[0]!, deps);
    expect(choices.map((c) => c.goodName).sort()).toEqual(["Black Bolt", "Surging Sparks"]);
    const pick = choices.find((c) => c.goodName === "Black Bolt")!;
    expect(pick.productId).toBe("2");
    const created = await createFreePacksFor(
      viewer,
      {
        machineId: org.machineIds[0]!,
        productId: pick.productId,
        quantity: 1,
        days: 7,
        reason: "giveaway",
        recipient: null,
        note: null,
      },
      deps,
    );
    expect(created.codes).toHaveLength(1);
    expect((await org.health("free_packs"))?.active_route).toBe("webbpanelen");

    // Id:na skiljer sig (panelen numrerar om): kontrollen tas bort, inga koder via panelen.
    fake.state.failWith = {};
    await db().execute(
      sql`update public.awish_path_health set web_ids_verified_at = now() - interval '2 days'
          where data_source_id = ${org.sourceId}::uuid and path = 'free_packs'`,
    );
    web.state.products = {
      "2": webSlots().map((p) => ({ ...p, id: p.id + 100 })),
      "3": webSlots().map((p) => ({ ...p, id: p.id + 100 })),
    };
    org.setNow(minutes(org.now(), 5));
    await org.sync();
    expect((await org.health("free_packs"))?.web_ids_verified_at).toBeNull();
  });
});

describe("(j) Awish-CSV efter API-orderna", () => {
  it("samma försäljning räknas inte två gånger", async () => {
    const org = await setupOrg();
    const csv = await asUser(org.owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
            values (${org.orgId}::uuid, 'awish_csv', 'Awish CSV', 'Asia/Shanghai') returning id`,
      ),
    );
    // API-ordern 7001 betalades 2026-11-24 09:00:00 (källans tid), 170,00. Orderlistan har ett
    // annat ordernummer för samma köp, och ett köp som API:t inte har hämtat.
    const file = [
      "ID,Date,Name,Order No.,Order Machine,Payment Method,Order Amount,Is Paid,Payment Time,Actions",
      '1,2026-11-24 08:59:40,"Pokémon TCG: Surging Sparks Booster",55001,Sega gubben,WeChat Pay,"Amount: 170.00",Paid Success,2026-11-24 09:00:00,Details',
      '2,2026-11-24 09:10:00,"Pokémon TCG: Surging Sparks Booster",55002,Sega gubben,WeChat Pay,"Amount: 170.00",Paid Success,2026-11-24 09:10:30,Details',
    ].join("\n");
    const result = await runImport(db(), {
      organizationId: org.orgId,
      dataSourceId: csv.id,
      actorUserId: org.owner.id,
      file: { name: "orderlista.csv", content: file },
      dryRun: false,
      fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-reserv-"))),
    });
    expect(result.summary.new).toBe(1);
    const sales = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders
          where organization_id = ${org.orgId}::uuid
            and ordered_at = '2026-11-24T01:00:00Z'`,
    );
    expect(sales[0]?.n).toBe(1);
  });
});

describe("(l) Open API hänger (paketen försvinner, inget fel kommer)", () => {
  it("automaterna och orderna får var sin del av tiden; facken läses via webbpanelen", async () => {
    const org = await setupOrg();
    await org.sync();
    fake.state.delayByMethod = { Machines: 30_000, Orders: 30_000, Products: 30_000 };
    const started = Date.now();
    // Riktig klocka och en kort körning (12 s): automaterna högst 3 s, orderna till 7,5 s,
    // och minst 4,5 s kvar för facken.
    const r = await syncAwishSource(
      { db: db(), connect, now: () => new Date(), makeWebClient, timeBudgetMs: 12_000 },
      { dataSourceId: org.sourceId, trigger: "manual" },
    );
    expect(Date.now() - started).toBeLessThan(14_000);
    expect(r.ok).toBe(false);
    // Automaterna och orderna svarade inte: facken går direkt till webbpanelen.
    expect(r.stock).toMatchObject({ read: 2, viaWeb: 2, deferred: 0 });
    // Inget går tyst: automaterna och lagret har sin hälsa, och brytaren är öppen.
    const machines = await org.health("machines");
    expect(machines).toMatchObject({ active_route: "senast_kanda", last_error_kind: "timeout" });
    expect(machines?.failing_since).not.toBeNull();
    const stock = await org.health("stock");
    expect(stock).toMatchObject({ active_route: "webbpanelen", breaker_route: "open_api" });
    expect(stock?.failing_since).toBeNull();
    expect((await org.health("orders"))?.failing_since).not.toBeNull();
    fake.state.delayByMethod = {};
  }, 30_000);

  it("en enda gång nere byter inte väg: ett snabbt nytt försök, ingen brytare", async () => {
    const org = await setupOrg();
    fake.state.failWith = { Products: grpc.status.UNAVAILABLE };
    fake.state.failTimes = { Products: 1 };
    org.setNow(minutes(org.now(), 5));
    const r = await org.sync();
    expect(r.stock).toMatchObject({ read: 2, failed: 0 });
    expect(r.stock?.viaWeb).toBeUndefined();
    const stock = await org.health("stock");
    expect(stock).toMatchObject({ active_route: "open_api", breaker_route: null });
  });
});

describe("(m) Facken borttagna i Awish (tomt svar som håller i sig)", () => {
  it("båda vägarna tomma i över en timme: saldot rensas, annars behålls det", async () => {
    const org = await setupOrg();
    await org.sync();
    const before = await fillOf(org.machineIds[0]!);
    expect(before.fill?.length ?? 0).toBeGreaterThan(0);
    fake.state.products = { "2": [], "3": [...GRPC_SLOTS] };
    web.state.products = { "2": [], "3": webSlots() };
    org.setNow(minutes(org.now(), 5));
    expect((await org.sync()).stock).toMatchObject({ read: 1, failed: 1 });
    expect((await fillOf(org.machineIds[0]!)).fill).toEqual(before.fill);

    org.setNow(minutes(org.now(), 61));
    const r = await org.sync();
    expect(r.stock).toMatchObject({ read: 2, failed: 0 });
    const after = await fillOf(org.machineIds[0]!);
    expect(after.fill ?? []).toEqual([]);
    expect(iso(after.at)).toBe(org.now().toISOString());
  });
});

describe("(n) Kontots slutdag skrivs aldrig över med inget", () => {
  const expires = async (sourceId: string) =>
    one<{ expires: Date | null; checked: Date | null }>(
      db(),
      sql`select awish_expires_at as expires, awish_merchant_checked_at as checked
          from public.data_sources where id = ${sourceId}::uuid`,
    );

  it("webbpanelen utan slutdag behåller den kända; en oläslig slutdag är ett fel", async () => {
    const org = await setupOrg({
      beforeFirstSync: () => {
        fake.state.failWith = { Merchant: grpc.status.INTERNAL };
      },
    });
    const known = await expires(org.sourceId);
    expect(iso(known.expires)).toBe("2027-04-18T15:48:54.000Z");

    // Ett dygn senare: Open API felar igen, och panelen skickar ingen slutdag.
    web.state.merchantExpiredAt = null;
    org.setNow(minutes(org.now(), 25 * 60));
    await org.sync();
    const kept = await expires(org.sourceId);
    expect(iso(kept.expires)).toBe("2027-04-18T15:48:54.000Z");
    expect(iso(kept.checked)).toBe(org.now().toISOString());

    // Ännu ett dygn: panelen skickar något som inte går att läsa. Slutdagen står kvar, och
    // läsningen räknas som misslyckad (Kontroll vet att den inte är kontrollerad).
    web.state.merchantExpiredAt = "snart";
    org.setNow(minutes(org.now(), 25 * 60));
    await org.sync();
    const after = await expires(org.sourceId);
    expect(iso(after.expires)).toBe("2027-04-18T15:48:54.000Z");
    expect(iso(after.checked)).toBe(iso(kept.checked));
    expect((await org.health("merchant"))?.failing_since).not.toBeNull();
  });
});
