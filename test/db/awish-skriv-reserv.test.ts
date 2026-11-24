/**
 * Om Awish krånglar, skrivningar (WP2) mot testdatabasen och lokala låtsas-Awish (webbpanelen
 * och gRPC). Testet når aldrig riktiga Awish.
 *
 *  - 503 två gånger och sedan OK: påfyllningen når Awish utan att något väntar,
 *  - 503 hela tiden: automaten väntar, den automatiska körningen försöker igen efter
 *    väntetiden (5, sedan 10 min) och kön töms när Awish svarar igen,
 *  - nekad inloggning: ett enda försök, brytaren öppen 6 h, ingen loop,
 *  - en automat felar och en går fram: bara den som felade väntar,
 *  - CreateGood som tappar svaret efter att varan skapats: ingen dubblett,
 *  - kampanj där listan före CreateBanner inte går att läsa: failed och inget CreateBanner,
 *  - automatiska nya försök med kampanjer: 5, 15, 60 min och högst 3.
 */

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";

import { asPostgres, asUser, createOrg, createUser, db, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

const { saveAwishCredentialsFor, saveAwishWebCredentialsFor, setAwishWebPushFor } =
  await import("../../src/server/awish/manage");
const { startFakeAwishWeb } = await import("../../src/server/awish/testing/fake-web-server");
type FakeWeb = Awaited<ReturnType<typeof startFakeAwishWeb>>;
const { startFakeAwish } = await import("../../src/server/awish/testing/fake-server");
type FakeGrpc = Awaited<ReturnType<typeof startFakeAwish>>;
const { createAwishWebClient } = await import("../../src/server/awish/web-client");
const { AwishApiError, createAwishClient } = await import("../../src/server/awish/grpc-client");
const ws = await import("../../src/server/awish/web-service");
const np = await import("../../src/server/awish/new-product");
const { checkGoodImage } = await import("../../src/server/awish/goods");
const IMG = () =>
  checkGoodImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]), "Testbild");
const { breakerOpen } = await import("../../src/server/awish/health");
const { pendingAwishPushes } = await import("../../src/server/varde/log");
const { createCampaignFor, publishAllDueCampaigns, retryCampaignFor } =
  await import("../../src/server/campaigns/service");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const CLOCK = 1_762_250_000_000;
const noSleep = async () => {};
let fake: FakeWeb;
const makeClient = (o: Parameters<typeof createAwishWebClient>[0] = {}) =>
  createAwishWebClient({ ...o, baseUrl: fake.baseUrl, now: () => CLOCK });
const pushDeps = () => ({ serviceDb: db(), makeClient, sleep: noSleep });
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

let owner: TestUser;
let orgId: string;
let sourceId: string;
const machines: Record<string, { id: string; location: string }> = {};

async function setLevel(code: string, titleName: string, quantity: number): Promise<void> {
  await asPostgres(async (tx) => {
    const existing = Array.from(
      await tx.execute(
        sql`select id from public.titles where organization_id = ${orgId}::uuid and lower(name) = lower(${titleName})`,
      ),
    ) as Array<{ id: string }>;
    let titleId = existing[0]?.id;
    if (!titleId) {
      titleId = (
        Array.from(
          await tx.execute(
            sql`insert into public.titles (organization_id, name) values (${orgId}::uuid, ${titleName}) returning id`,
          ),
        )[0] as { id: string }
      ).id;
    }
    await tx.execute(sql`
      insert into public.stock_events
        (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      values (${orgId}::uuid, ${machines[code]!.location}::uuid, ${titleId}::uuid, 'count',
              ${quantity}, now(), 'test')`);
  });
}

async function pending(): Promise<string[]> {
  return [...(await pendingAwishPushes(db(), orgId)).keys()];
}

async function pushHealth() {
  const [row] = await rows<{
    active_route: string;
    last_error_kind: string | null;
    consecutive_failures: number;
    breaker_open_until: Date | null;
  }>(
    db(),
    sql`select active_route, last_error_kind, consecutive_failures, breaker_open_until
        from public.awish_path_health
        where data_source_id = ${sourceId}::uuid and path = 'push'`,
  );
  return row;
}

const signins = () => fake.state.calls.filter((c) => c.operationName === "Signin").length;
const productWrites = () =>
  fake.state.calls.filter((c) => c.operationName === "UpdateProduct").length;

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  const inserted = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Sega gubben", activeFrom: "2026-10-01" },
        { organizationId: orgId, code: "BL-002", name: "Centrum", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  for (const m of inserted) {
    const [loc] = await rows<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where machine_id = ${m.id}::uuid`,
    );
    machines[m.code!] = { id: m.id, location: loc!.id };
  }
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: "app",
    appSecret: "secret",
    appKey: "key",
  }));
  await db().execute(sql`
    insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
    values (${orgId}::uuid, ${sourceId}::uuid, '1001', 'Sega gubben', ${machines["BL-001"]!.id}::uuid),
           (${orgId}::uuid, ${sourceId}::uuid, '1002', 'Centrum', ${machines["BL-002"]!.id}::uuid)`);
});

beforeEach(async () => {
  fake = await startFakeAwishWeb({
    now: () => CLOCK,
    products: {
      "1001": [
        {
          id: 11,
          goodId: 5,
          goodName: "30th Celebration",
          status: true,
          currentInventory: 2,
          capacity: 10,
          channelName: "A1",
        },
      ],
      "1002": [
        {
          id: 21,
          goodId: 5,
          goodName: "30th Celebration",
          status: true,
          currentInventory: 1,
          capacity: 10,
          channelName: "A1",
        },
      ],
    },
  });
  const viewer = await viewerFor(owner, orgId);
  await saveAwishWebCredentialsFor(viewer, {
    email: fake.state.email,
    password: fake.state.password,
  });
  await setAwishWebPushFor(viewer, true);
});

afterEach(async () => {
  await fake.stop();
});

describe("påfyllning till Awish när webbpanelen krånglar", () => {
  it("503 två gånger och sedan OK: når Awish direkt, inget väntar", async () => {
    await setLevel("BL-001", "30th Celebration", 6);
    fake.state.failNext = 2;
    const r = await ws.pushMachinesToAwish(orgId, [machines["BL-001"]!.id], pushDeps());
    expect(r.machines[0]).toMatchObject({ status: "pushed", slotsUpdated: 1 });
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(6);
    expect(await pending()).toEqual([]);
    expect(await pushHealth()).toMatchObject({ active_route: "webbpanelen" });
  });

  it("503 hela tiden: väntar, försöks igen efter väntetiden och kön töms när Awish svarar", async () => {
    await setLevel("BL-001", "30th Celebration", 8);
    fake.state.failNext = 100_000;
    const r = await ws.pushMachinesToAwish(orgId, [machines["BL-001"]!.id], pushDeps());
    expect(r.machines[0]).toMatchObject({ status: "error", errorKind: "unavailable" });
    expect(await pending()).toEqual([machines["BL-001"]!.id]);
    expect(await pushHealth()).toMatchObject({
      active_route: "ingen",
      last_error_kind: "unavailable",
    });

    const all = (now: Date) =>
      ws.retryPendingAwishPushesForAll(db(), {
        deadline: Date.now() + 30_000,
        now: () => now,
        makeClient,
        sleep: noSleep,
        organizationIds: [orgId],
      });
    // Efter 1 min: väntetiden (5 min) har inte gått.
    expect(await all(minutes(1))).toMatchObject({ organizations: 1, waiting: 1, tried: 0 });
    // Efter 6 min: ett försök, Awish är fortfarande nere.
    expect(await all(minutes(6))).toMatchObject({ tried: 1, cleared: 0 });
    expect(await pending()).toEqual([machines["BL-001"]!.id]);
    // 5 min efter försöket: nästa väntan är 10 min.
    expect(await all(minutes(11))).toMatchObject({ waiting: 1, tried: 0 });
    // Awish svarar igen: nästa försök tömmer kön.
    fake.state.failNext = 0;
    expect(await all(minutes(17))).toMatchObject({ tried: 1, cleared: 1 });
    expect(await pending()).toEqual([]);
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(8);
    expect(await pushHealth()).toMatchObject({
      active_route: "webbpanelen",
      consecutive_failures: 0,
    });
    // Inget väntar längre: inga fler försök.
    expect(await all(minutes(200))).toMatchObject({ organizations: 0, tried: 0 });
  });

  it("nekad inloggning: ett försök, brytaren öppen 6 h och ingen loop", async () => {
    await setLevel("BL-001", "30th Celebration", 9);
    const right = fake.state.password;
    fake.state.password = "ett-annat-losenord";
    const r = await ws.pushMachinesToAwish(orgId, [machines["BL-001"]!.id], pushDeps());
    expect(r.machines[0]).toMatchObject({ status: "error", errorKind: "auth" });
    expect(signins()).toBe(1);
    expect(await pending()).toEqual([machines["BL-001"]!.id]);
    const health = await pushHealth();
    expect(health?.last_error_kind).toBe("auth");
    const until = new Date(health!.breaker_open_until!).getTime();
    expect(until - Date.now()).toBeGreaterThan(5.9 * 3_600_000);
    expect(await breakerOpen(db(), sourceId, "push", "webbpanelen")).toBe(true);

    // Den automatiska körningen loggar inte in igen medan brytaren är öppen.
    const out = await ws.retryPendingAwishPushesForAll(db(), {
      deadline: Date.now() + 30_000,
      now: () => minutes(300),
      makeClient,
      sleep: noSleep,
      organizationIds: [orgId],
    });
    expect(out).toMatchObject({ breaker: 1, tried: 0 });
    expect(signins()).toBe(1);

    // Ägaren rättar lösenordet och trycker Försök igen: går fram och stänger brytaren.
    fake.state.password = right;
    const retry = await ws.retryPendingAwishPushes(orgId, null, pushDeps());
    expect(retry.pending).toEqual([]);
    expect(await breakerOpen(db(), sourceId, "push", "webbpanelen")).toBe(false);
  });

  it("en automat felar, en går fram: bara den som felade väntar", async () => {
    await setLevel("BL-001", "30th Celebration", 7);
    await setLevel("BL-002", "30th Celebration", 7);
    // Första läsningen av facken (BL-001) får ett fel från Awish; BL-002 går fram.
    fake.state.failOn = { Products: { message: "internal error" } };
    const r = await ws.pushMachinesToAwish(
      orgId,
      [machines["BL-001"]!.id, machines["BL-002"]!.id],
      pushDeps(),
    );
    expect(r.machines.map((m) => m.status)).toEqual(["error", "pushed"]);
    expect(await pending()).toEqual([machines["BL-001"]!.id]);
    expect(fake.state.products["1002"]![0]!.currentInventory).toBe(7);
    // Försök igen: den som väntade går fram, den andra skrivs inte om.
    const writesBefore = productWrites();
    const retry = await ws.retryPendingAwishPushes(orgId, null, pushDeps());
    expect(retry.pending).toEqual([]);
    expect(productWrites() - writesBefore).toBe(1);
  });
});

describe("påfyllning till Awish: tidsgräns, väntande före sändningen och 429", () => {
  it("webbpanelen hänger: sändningen håller sin tid och automaten väntar", async () => {
    await setLevel("BL-001", "30th Celebration", 5);
    fake.state.now = () => Date.now();
    fake.state.delayMs = 6_000;
    const started = Date.now();
    const r = await ws.pushMachinesToAwish(orgId, [machines["BL-001"]!.id], {
      serviceDb: db(),
      makeClient: (o) => createAwishWebClient({ ...o, baseUrl: fake.baseUrl }),
      sleep: noSleep,
      deadlineAt: Date.now() + 2_500,
    });
    // Klientens egen tidsgräns: inget anrop går förbi sändningens tid (aldrig 15 s × 3).
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(r.machines[0]).toMatchObject({ status: "error" });
    expect(await pending()).toEqual([machines["BL-001"]!.id]);
    fake.state.delayMs = 0;
  }, 20_000);

  it("automaten står som väntande medan sändningen pågår (ett avbrott tappar inget)", async () => {
    await setLevel("BL-001", "30th Celebration", 4);
    let during: string[] | null = null;
    const spy = (o: Parameters<typeof createAwishWebClient>[0] = {}) => {
      const real = makeClient(o);
      return {
        ...real,
        async products(id: number) {
          during = await pending();
          return real.products(id);
        },
      };
    };
    const r = await ws.pushMachinesToAwish(orgId, [machines["BL-001"]!.id], {
      ...pushDeps(),
      makeClient: spy,
    });
    expect(r.machines[0]).toMatchObject({ status: "pushed" });
    expect(during).toEqual([machines["BL-001"]!.id]);
    expect(await pending()).toEqual([]);
  });

  it("429: ett enda anrop, inget nytt försök, brytaren pausar de automatiska försöken", async () => {
    await setLevel("BL-001", "30th Celebration", 9);
    fake.state.rateLimit = 1;
    const r = await ws.pushMachinesToAwish(orgId, [machines["BL-001"]!.id], pushDeps());
    expect(r.machines[0]).toMatchObject({ status: "error", errorKind: "rate_limited" });
    expect(signins()).toBe(1);
    expect(await pending()).toEqual([machines["BL-001"]!.id]);
    expect(await breakerOpen(db(), sourceId, "push", "webbpanelen")).toBe(true);
    const out = await ws.retryPendingAwishPushesForAll(db(), {
      deadline: Date.now() + 30_000,
      now: () => minutes(2),
      makeClient,
      sleep: noSleep,
      organizationIds: [orgId],
    });
    // Inget nytt anrop inom de första minuterna (väntetiden och brytaren).
    expect(out).toMatchObject({ tried: 0 });
    expect(signins()).toBe(1);
    // Brytaren gäller fem minuter: senare görs försöket och går fram (långt fram, så att
    // väntetiden efter de andra testernas försök i organisationen också har gått).
    const later = await ws.retryPendingAwishPushesForAll(db(), {
      deadline: Date.now() + 30_000,
      now: () => minutes(600),
      makeClient,
      sleep: noSleep,
      organizationIds: [orgId],
    });
    expect(later).toMatchObject({ tried: 1, cleared: 1 });
    expect(await pending()).toEqual([]);
  });

  it("ett nytt försök lägger inte tillbaka ett pack som såldes efter att det första gick fram", async () => {
    await setLevel("BL-002", "30th Celebration", 6);
    fake.state.products["1002"]![0]!.currentInventory = 1;
    const landedThenLost = (o: Parameters<typeof createAwishWebClient>[0] = {}) => {
      const real = makeClient(o);
      let first = true;
      return {
        ...real,
        async setProductInventory(
          id: number,
          input: Parameters<typeof real.setProductInventory>[1],
        ) {
          await real.setProductInventory(id, input);
          if (first) {
            first = false;
            // Ett köp direkt efter, och svaret på skrivningen går förlorat.
            fake.state.products["1002"]![0]!.currentInventory -= 1;
            throw new AwishApiError("timeout", "Awish svarade inte inom 15 s.");
          }
        },
      };
    };
    const before = productWrites();
    const r = await ws.pushMachinesToAwish(orgId, [machines["BL-002"]!.id], {
      ...pushDeps(),
      makeClient: landedThenLost,
    });
    expect(r.machines[0]).toMatchObject({ status: "pushed" });
    expect(productWrites() - before).toBe(1);
    expect(fake.state.products["1002"]![0]!.currentInventory).toBe(5);
  });

  it("sändningar som felade för mer än ett dygn sedan försöks inte igen automatiskt", async () => {
    // Inget annat väntar (de andra testerna i organisationen).
    await ws.retryPendingAwishPushes(orgId, null, pushDeps());
    expect(await pending()).toEqual([]);
    const [old] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({ organizationId: orgId, code: "BL-009", name: "Gammal", activeFrom: "2026-10-01" })
        .returning(),
    );
    await db().execute(
      sql`insert into public.automation_log (organization_id, kind, machine_id, units, occurred_at)
          values (${orgId}::uuid, 'awish_push_failed', ${old!.id}::uuid, 0,
                  now() - interval '25 hours')`,
    );
    expect(await pending()).toContain(old!.id);
    const writes = productWrites();
    const out = await ws.retryPendingAwishPushesForAll(db(), {
      deadline: Date.now() + 30_000,
      makeClient,
      sleep: noSleep,
      organizationIds: [orgId],
    });
    expect(out).toMatchObject({ organizations: 0, tried: 0 });
    expect(productWrites()).toBe(writes);
    // Den väntar kvar för Försök igen i Fyll på.
    expect(await pending()).toContain(old!.id);
  });
});

describe("Ny produkt: CreateGood som tappar svaret", () => {
  const input = (name: string) => ({
    name,
    salePrice: "79",
    purchasePrice: "30",
    ownProduct: false,
  });

  /** Klient där createGood når Awish men svaret går förlorat (tidsgräns). */
  const lostReply =
    (mode: "after" | "before") =>
    (o: Parameters<typeof createAwishWebClient>[0] = {}) => {
      const real = makeClient(o);
      let first = true;
      return {
        ...real,
        async createGood(goodInput: Parameters<typeof real.createGood>[0]) {
          if (first) {
            first = false;
            if (mode === "after") await real.createGood(goodInput);
            throw new AwishApiError("timeout", "Awish svarade inte inom 15 s.");
          }
          return real.createGood(goodInput);
        },
      };
    };

  it("varan skapades trots tidsgränsen: inget nytt CreateGood, ingen dubblett", async () => {
    const v = await viewerFor(owner, orgId);
    const deps = { serviceDb: db(), makeWebClient: lostReply("after"), sleep: noSleep };
    const preview = await np.previewNewProductFor(v, input("Reserv Pack"), IMG(), deps);
    const r = await np.createNewProductFor(
      v,
      input("Reserv Pack"),
      IMG(),
      preview.fingerprint,
      deps,
    );
    expect(r.status).toBe("created");
    expect(fake.state.goods.filter((g) => g.name === "Reserv Pack")).toHaveLength(1);
    expect(fake.state.calls.filter((c) => c.operationName === "CreateGood")).toHaveLength(1);
  });

  it("varan skapades inte: ett enda nytt försök", async () => {
    const v = await viewerFor(owner, orgId);
    const deps = { serviceDb: db(), makeWebClient: lostReply("before"), sleep: noSleep };
    const preview = await np.previewNewProductFor(v, input("Reserv Pack 2"), IMG(), deps);
    const r = await np.createNewProductFor(
      v,
      input("Reserv Pack 2"),
      IMG(),
      preview.fingerprint,
      deps,
    );
    expect(r.status).toBe("created");
    expect(fake.state.goods.filter((g) => g.name === "Reserv Pack 2")).toHaveLength(1);
  });
});

describe("kampanjer när Open API krånglar", () => {
  let grpc: FakeGrpc;
  let campOwner: TestUser;
  let campOrg: string;
  let failBanners = 0;
  const NOW = new Date("2026-11-03T09:00:00Z");
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
  const connect = (creds: { appId: string; appSecret: string; appKey: string }) => {
    const api = createAwishClient(creds, { address: grpc.address, tls: false, sleep: noSleep });
    return {
      products: (id: string) => api.products(id),
      banners: async (id: string) => {
        if (failBanners > 0) {
          failBanners -= 1;
          throw new AwishApiError("unavailable", "Awish svarar inte just nu.", 14);
        }
        return api.banners(id);
      },
      createBanner: (i: Parameters<typeof api.createBanner>[0]) => api.createBanner(i),
      updateBanner: (i: Parameters<typeof api.updateBanner>[0]) => api.updateBanner(i),
      pickupCodes: (id: string) => api.pickupCodes(id),
      createPickupCodes: (i: Parameters<typeof api.createPickupCodes>[0]) =>
        api.createPickupCodes(i),
      close: () => api.close(),
    };
  };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const store = { put: async () => {} } as never;
  const env = { CAMPAIGN_STORAGE: "local", APP_URL: "https://app.test" };
  const createBanners = () =>
    grpc.state.calls.filter((c) => c.method === "CreateBanner" && c.request.machine_id === "71");
  const row = async () =>
    (
      await rows<{ status: string; retry_count: number; next_retry_at: Date | null }>(
        db(),
        sql`select status, retry_count, next_retry_at from public.campaign_machines
            where organization_id = ${campOrg}::uuid`,
      )
    )[0]!;

  beforeAll(async () => {
    grpc = await startFakeAwish({
      machines: [{ id: "71", name: "Reserv", machine_no: "71" }],
    });
    campOwner = await createUser();
    campOrg = await createOrg(campOwner);
    const [m] = await asUser(campOwner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: campOrg,
          code: "BL-071",
          name: "Reserv",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    const { dataSourceId } = await saveAwishCredentialsFor(await viewerFor(campOwner, campOrg), {
      appId: grpc.state.appId,
      appSecret: grpc.state.appSecret,
      appKey: grpc.state.appKey,
    });
    await db().execute(
      sql`insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
          values (${campOrg}::uuid, ${dataSourceId}::uuid, '71', 'Reserv', ${m!.id}::uuid)`,
    );
  });
  afterAll(async () => {
    await grpc.stop();
  });

  it("listan före CreateBanner går inte att läsa: failed, inget CreateBanner", async () => {
    failBanners = 1;
    const r = await createCampaignFor(
      await viewerFor(campOwner, campOrg),
      {
        title: "Reservkampanj",
        machineIds: [],
        startsOn: null,
        endsOn: "2026-11-16",
        titleId: null,
        reuseImageFrom: null,
      },
      PNG,
      { connect, store, env, now: () => NOW },
    );
    expect(r).toMatchObject({ shown: 0, failed: 1 });
    expect(createBanners()).toHaveLength(0);
    const cm = await row();
    expect(cm.status).toBe("failed");
    expect(cm.retry_count).toBe(0);
    expect(new Date(cm.next_retry_at!).getTime()).toBe(at(5).getTime());
  });

  it("nya försök automatiskt efter 5, 15 och 60 min, högst 3", async () => {
    failBanners = 1_000;
    await publishAllDueCampaigns({ db: db(), connect, now: at(4) });
    expect(await row()).toMatchObject({ status: "failed", retry_count: 0 });
    await publishAllDueCampaigns({ db: db(), connect, now: at(5) });
    let cm = await row();
    expect(cm).toMatchObject({ status: "failed", retry_count: 1 });
    expect(new Date(cm.next_retry_at!).getTime()).toBe(at(20).getTime());
    await publishAllDueCampaigns({ db: db(), connect, now: at(20) });
    cm = await row();
    expect(cm.retry_count).toBe(2);
    expect(new Date(cm.next_retry_at!).getTime()).toBe(at(80).getTime());
    await publishAllDueCampaigns({ db: db(), connect, now: at(80) });
    cm = await row();
    expect(cm).toMatchObject({ status: "failed", retry_count: 3, next_retry_at: null });
    await publishAllDueCampaigns({ db: db(), connect, now: at(500) });
    expect((await row()).retry_count).toBe(3);
    expect(createBanners()).toHaveLength(0);

    // Awish svarar igen: Försök igen går fram, en gång.
    failBanners = 0;
    const [c] = await rows<{ campaign_id: string }>(
      db(),
      sql`select campaign_id from public.campaign_machines where organization_id = ${campOrg}::uuid`,
    );
    const r = await retryCampaignFor(await viewerFor(campOwner, campOrg), c!.campaign_id, {
      connect,
      now: () => at(501),
    });
    expect(r).toMatchObject({ shown: 1, failed: 0 });
    expect(createBanners()).toHaveLength(1);
  });

  it("CreateBanner gick fram men svaret och listan försvann: nytt försök ger ingen dubblett", async () => {
    const lost = (creds: { appId: string; appSecret: string; appKey: string }) => {
      const api = connect(creds);
      return {
        ...api,
        createBanner: async (i: Parameters<typeof api.createBanner>[0]) => {
          await api.createBanner(i);
          failBanners = 1; // Kontrollen efteråt går inte heller att läsa.
          throw new AwishApiError("timeout", "Awish svarade inte inom 10 s.", 4);
        },
      };
    };
    const created = await createCampaignFor(
      await viewerFor(campOwner, campOrg),
      {
        title: "Dubblettskydd",
        machineIds: [],
        startsOn: null,
        endsOn: "2026-11-16",
        titleId: null,
        reuseImageFrom: null,
      },
      PNG,
      { connect: lost, store, env, now: () => NOW },
    );
    expect(created).toMatchObject({ shown: 0, failed: 1 });
    const mine = () =>
      createBanners().filter((c) => (c.request as { title?: string }).title === "Dubblettskydd");
    expect(mine()).toHaveLength(1);
    // Det automatiska försöket ser att kampanjen redan finns: visad, inget nytt CreateBanner.
    failBanners = 0;
    await publishAllDueCampaigns({ db: db(), connect, now: at(6) });
    const [cm] = await rows<{ status: string; awish_banner_id: string | null }>(
      db(),
      sql`select cm.status, cm.awish_banner_id from public.campaign_machines cm
          join public.campaigns c on c.organization_id = cm.organization_id and c.id = cm.campaign_id
          where cm.organization_id = ${campOrg}::uuid and c.title = 'Dubblettskydd'`,
    );
    expect(cm).toMatchObject({ status: "shown" });
    expect(cm?.awish_banner_id).not.toBeNull();
    expect(mine()).toHaveLength(1);
  });

  it("en rad som fastnade som 'skickas' (funktionen stoppades) försöks igen", async () => {
    const [c] = await rows<{ id: string }>(
      db(),
      sql`select cm.id from public.campaign_machines cm
          join public.campaigns c on c.organization_id = cm.organization_id and c.id = cm.campaign_id
          where cm.organization_id = ${campOrg}::uuid and c.title = 'Dubblettskydd'`,
    );
    await db().execute(
      sql`update public.campaign_machines set status = 'sending' where id = ${c!.id}::uuid`,
    );
    // Tio minuter senare (räknat från radens ändring) blir den misslyckad med ett nytt försök.
    await publishAllDueCampaigns({ db: db(), connect, now: new Date(Date.now() + 11 * 60_000) });
    const [after] = await rows<{ status: string; next_retry_at: Date | null }>(
      db(),
      sql`select status, next_retry_at from public.campaign_machines where id = ${c!.id}::uuid`,
    );
    expect(after?.status).toBe("failed");
    expect(after?.next_retry_at).not.toBeNull();
  });
});
