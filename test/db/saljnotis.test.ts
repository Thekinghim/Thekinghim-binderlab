/**
 * Notis vid varje försäljning (src/server/sales-push) mot testdatabasen och en låtsas-Awish
 * (riktig gRPC-server på 127.0.0.1). Inga riktiga push: en låtsasadapter minns utskicken.
 *
 *   1. Källans första import (första hämtningen, historiken) blir ingen notis.
 *   2. Nya köp i en senare synk: en notis per person och körning, till dem som har knappen
 *      på och en telefon. Ägare, admin och läsare med belopp, påfyllaren utan kronor,
 *      butiksanvändaren och den som inte har slagit på aldrig. Testköp och sena köp (äldre än
 *      ett dygn) aldrig. Bara köp sparade efter att personen slog på knappen.
 *   3. En gång: en andra körning, två samtidiga körningar och omförsök skickar inget mer.
 *   4. Fler än 20 nya köp: en sammanfattning. Tyst på natten. Enheter som push-tjänsten inte
 *      känner igen stängs av.
 *   5. En adapter som kastar stoppar inte jobbet, och nästa synk går som vanligt.
 *   6. RLS: knappen i den egna profilen; sale_notifications syns bara för ägare och admin och
 *      skrivs aldrig av en klientroll.
 */

import { randomUUID } from "node:crypto";

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
import type {
  PushOutcome,
  PushPayload,
  PushSender,
  PushTarget,
} from "../../src/server/notify/push";
import { runSaleNotifications } from "../../src/server/sales-push/job";
import { loadSalePushPref, saveSalePushPref } from "../../src/server/sales-push/prefs";

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

const NBSP = "\u00a0";
const SOURCE_TZ = "Asia/Shanghai";
const BASE = "https://app.example.se";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** Awish betaltid ("ÅÅÅÅ-MM-DD hh:mm:ss" i källans tidszon). */
function payTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: SOURCE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return parts.replace(",", "");
}

/** En order betald för `minutesAgo` minuter sedan. */
function order(id: number, minutesAgo: number, over: Parameters<typeof fakeOrder>[1] = {}) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const pt = payTime(at);
  return fakeOrder(id, { payTime: pt, date: pt.slice(0, 10), ...over });
}

/** Klockan i Stockholm i dag (för tyst på natten, oberoende av när testet körs). */
function stockholmToday(hour: number): Date {
  const day = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  // Vintertid (+01:00) eller sommartid (+02:00): prova båda och välj den som blir rätt timme.
  for (const offset of ["+01:00", "+02:00"]) {
    const d = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00${offset}`);
    const h = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Stockholm",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(d);
    if (Number(h) === hour) return d;
  }
  throw new Error("Tidszonen");
}
const NOON = () => stockholmToday(12);

interface Sent {
  readonly endpoint: string;
  readonly payload: PushPayload;
}

/** Push-adapter som minns vad som skickades. */
function fakeSender(
  options: { fail?: (endpoint: string) => "gone" | "error" | "throw" | null } = {},
) {
  const sent: Sent[] = [];
  const sender: PushSender = {
    kind: "outbox",
    async send(target: PushTarget, payload: PushPayload): Promise<PushOutcome> {
      const failure = options.fail?.(target.endpoint) ?? null;
      if (failure === "throw") throw new Error("push-tjänsten kastade");
      if (failure) return { ok: false, gone: failure === "gone", detail: failure };
      sent.push({ endpoint: target.endpoint, payload });
      return { ok: true, detail: "test" };
    },
  };
  return { sender, sent };
}

async function addDevice(orgId: string, user: TestUser): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  await asPostgres((tx) =>
    tx.insert(s.pushSubscriptions).values({
      organizationId: orgId,
      userId: user.id,
      endpoint,
      p256dh: "p".repeat(40),
      authSecret: "a".repeat(16),
    }),
  );
  return endpoint;
}

const turnOn = (orgId: string, user: TestUser, change: { on?: boolean; quiet?: boolean }) =>
  asUser(user, (tx) => saveSalePushPref(tx, { orgId, userId: user.id, email: user.email }, change));

let fake: FakeAwish;
const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
  createAwishClient(creds, { address: fake.address, tls: false, sleep: async () => {} });

let orgId: string;
let sourceId: string;
let owner: TestUser;
let admin: TestUser;
let viewer: TestUser;
let refiller: TestUser;
let storeUser: TestUser;
let offUser: TestUser;
const device: Record<string, string> = {};
let nextId = 9_100_000;
const id = () => (nextId += 1);

async function sync() {
  const r = await syncAwishSource({ db: db(), connect }, { dataSourceId: sourceId });
  expect(r.ok).toBe(true);
  return r;
}

const run = (sender: PushSender, now: Date = NOON()) =>
  runSaleNotifications(db(), { now, baseUrl: BASE, only: [orgId], sender });

const claimed = () =>
  rows<{ external_id: string }>(
    db(),
    sql`select o.external_id from public.sale_notifications n
        join public.orders o on o.organization_id = n.organization_id and o.id = n.order_id
        where n.organization_id = ${orgId}::uuid order by o.ordered_at`,
  );

const to = (sent: readonly Sent[], user: TestUser) =>
  sent.filter((x) => x.endpoint === device[user.id]).map((x) => x.payload);

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [{ id: "2", name: "BL-001 Centrum", machine_no: "163271xx" }],
  });
  owner = await createUser();
  orgId = await createOrg(owner, "Säljnotis AB");
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  }));
  admin = await createMember(orgId, "admin");
  viewer = await createMember(orgId, "viewer");
  refiller = await createMember(orgId, "refiller");
  offUser = await createMember(orgId, "admin");
  // Butiksportalens användare: role = store med en butik (inga kontaktuppgifter).
  storeUser = await createUser();
  await asPostgres(async (tx) => {
    const [store] = await tx
      .insert(s.stores)
      .values({ organizationId: orgId, name: "Butik Ett" })
      .returning({ id: s.stores.id });
    await tx
      .insert(s.memberships)
      .values({ organizationId: orgId, userId: storeUser.id, role: "store", storeId: store!.id });
    // Knappen kan inte slås på från portalen; här sätts den direkt för att visa att jobbet
    // ändå aldrig skickar till butiken.
    await tx.insert(s.profiles).values({
      organizationId: orgId,
      userId: storeUser.id,
      displayName: "butik",
      salePushSince: new Date(Date.now() - 3600_000),
    });
  });
  for (const u of [owner, admin, viewer, refiller, storeUser, offUser]) {
    device[u.id] = await addDevice(orgId, u);
  }
});

afterAll(async () => {
  await fake.stop();
});

describe("vem och vilka köp", () => {
  it("knappen är av som standard", async () => {
    const pref = await asUser(owner, (tx) => loadSalePushPref(tx, orgId, owner.id));
    expect(pref.on).toBe(false);
    expect(pref.quiet).toBe(false);
  });

  it("källans första import (historik och dagens köp) blir ingen notis", async () => {
    for (const u of [owner, admin, viewer, refiller]) await turnOn(orgId, u, { on: true });
    fake.state.orders = [order(id(), 3 * 24 * 60), order(id(), 30), order(id(), 20)];
    const first = await sync();
    expect(first.summary?.new).toBe(3);
    const { sender, sent } = fakeSender();
    const res = await run(sender);
    expect(sent).toEqual([]);
    expect(await claimed()).toEqual([]);
    expect(res.organizations.find((o) => o.organizationId === orgId)?.orders ?? 0).toBe(0);
  });

  it("nya köp: ägare, admin och läsare med belopp, påfyllaren utan, aldrig butiken eller den som inte slagit på", async () => {
    const a = id();
    const b = id();
    const testkop = id();
    const late = id();
    fake.state.orders.push(
      order(a, 6, { amount: "170.00" }),
      order(b, 4, { amount: "129.00", title: "One Piece OP-13 Booster EN" }),
      order(testkop, 3),
      // Sen: köpt för två dygn sedan, hämtas först nu.
      order(late, 2 * 24 * 60),
    );
    await sync();
    // Testköpet markeras innan jobbet hinner köra (samma som i appen: set_test_purchase).
    await asUser(owner, async (tx) => {
      const [row] = Array.from(
        await tx.execute(
          sql`select id::text as id from public.orders
              where organization_id = ${orgId}::uuid and external_id = ${String(testkop)}`,
        ),
      ) as { id: string }[];
      await tx.execute(
        sql`select public.set_test_purchase(${orgId}::uuid, ${row!.id}::uuid, true)`,
      );
    });

    const { sender, sent } = fakeSender();
    const res = await run(sender);
    expect((await claimed()).map((r) => r.external_id)).toEqual([String(a), String(b)]);
    expect(res.organizations[0]).toMatchObject({ orders: 2, sent: 4, failed: 0 });

    for (const u of [owner, admin, viewer]) {
      const [p, ...more] = to(sent, u);
      expect(more).toEqual([]);
      expect(p!.title).toBe(`2 sålda · 299${NBSP}kr`);
      expect(p!.body).toBe("One Piece OP-13 Booster EN, Pokémon TCG: Surging Sparks Booster");
      expect(p!.url).toBe("/?period=idag");
      expect(p!.icon).toBe(`${BASE}/icons/icon-192.png`);
    }
    const [r, ...rest] = to(sent, refiller);
    expect(rest).toEqual([]);
    expect(r!.title).toBe("2 sålda");
    expect(JSON.stringify(r)).not.toMatch(/kr\b|299|170|129/);
    expect(to(sent, storeUser)).toEqual([]);
    expect(to(sent, offUser)).toEqual([]);
  });

  it("ett köp: titel, automat, belopp och tid, packbilden som ikon", async () => {
    fake.state.orders.push(order(id(), 1, { amount: "170.00" }));
    await sync();
    const { sender, sent } = fakeSender();
    await run(sender);
    const [p] = to(sent, owner);
    expect(p!.title).toBe("Sålt: Pokémon TCG: Surging Sparks Booster");
    expect(p!.body).toContain(`170${NBSP}kr`);
    expect(p!.body).toMatch(/\d\d:\d\d$/);
    expect(p!.icon).toBe(`${BASE}/packs/surging-sparks.webp`);
    const [r] = to(sent, refiller);
    expect(r!.title).toBe("Sålt: Pokémon TCG: Surging Sparks Booster");
    expect(r!.body).not.toContain("kr");
  });

  it("bara köp sparade efter att personen slog på knappen", async () => {
    fake.state.orders.push(order(id(), 1));
    await sync();
    // Slår på efter att köpet sparades, före jobbet.
    await turnOn(orgId, offUser, { on: true });
    const { sender, sent } = fakeSender();
    await run(sender);
    expect(to(sent, owner)).toHaveLength(1);
    expect(to(sent, offUser)).toEqual([]);
    await turnOn(orgId, offUser, { on: false });
  });
});

describe("en gång", () => {
  it("en andra körning skickar ingenting", async () => {
    const { sender, sent } = fakeSender();
    const res = await run(sender);
    expect(sent).toEqual([]);
    expect(res.organizations[0]).toMatchObject({ orders: 0, sent: 0 });
  });

  it("två samtidiga körningar skickar en notis per person", async () => {
    fake.state.orders.push(order(id(), 1), order(id(), 1));
    await sync();
    const { sender, sent } = fakeSender();
    await Promise.all([run(sender), run(sender), run(sender)]);
    expect(to(sent, owner)).toHaveLength(1);
    expect(to(sent, owner)[0]!.title).toMatch(/^2 sålda/);
    expect(to(sent, refiller)).toHaveLength(1);
  });

  it("ett utskick som kastar stoppar inte jobbet och provas inte igen; nästa synk går som vanligt", async () => {
    fake.state.orders.push(order(id(), 1));
    await sync();
    const throwing = fakeSender({ fail: () => "throw" });
    const res = await run(throwing.sender);
    expect(res.organizations[0]).toMatchObject({ orders: 1, sent: 0, failed: 4 });
    // Ingen enhet stängdes av för ett kast (bara 404/410 gör det).
    const disabled = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.push_subscriptions
          where organization_id = ${orgId}::uuid and disabled_at is not null`,
    );
    expect(disabled[0]!.n).toBe(0);
    const again = fakeSender();
    await run(again.sender);
    expect(again.sent).toEqual([]);
    // Synken påverkas inte.
    fake.state.orders.push(order(id(), 1));
    const next = await sync();
    expect(next.summary?.new).toBe(1);
    const after = fakeSender();
    await run(after.sender);
    expect(to(after.sent, owner)).toHaveLength(1);
  });
});

describe("mängd, natt och enheter", () => {
  it("fler än 20 nya köp i en synk: en sammanfattning", async () => {
    for (let i = 0; i < 22; i++) fake.state.orders.push(order(id(), 2, { amount: "100.00" }));
    await sync();
    const { sender, sent } = fakeSender();
    await run(sender);
    const [p, ...more] = to(sent, owner);
    expect(more).toEqual([]);
    expect(p!.title).toBe(`22 sålda · 2${NBSP}200${NBSP}kr`);
    expect(p!.body).toMatch(/^Sedan .*Öppna Hem för listan\.$/);
    expect(to(sent, refiller)[0]!.title).toBe("22 sålda");
  });

  it("tyst på natten: inget 22–07 till den som valt det, köpen kommer inte senare", async () => {
    await turnOn(orgId, admin, { quiet: true });
    expect((await asUser(admin, (tx) => loadSalePushPref(tx, orgId, admin.id))).quiet).toBe(true);
    fake.state.orders.push(order(id(), 1));
    await sync();
    const { sender, sent } = fakeSender();
    const res = await run(sender, stockholmToday(23));
    expect(to(sent, admin)).toEqual([]);
    expect(to(sent, owner)).toHaveLength(1);
    expect(res.organizations[0]).toMatchObject({ quiet: 1 });
    const morning = fakeSender();
    await run(morning.sender);
    expect(morning.sent).toEqual([]);
    await turnOn(orgId, admin, { quiet: false });
  });

  it("en enhet som push-tjänsten inte känner igen (410) stängs av", async () => {
    const extra = await addDevice(orgId, viewer);
    fake.state.orders.push(order(id(), 1));
    await sync();
    const { sender, sent } = fakeSender({ fail: (e) => (e === extra ? "gone" : null) });
    await run(sender);
    expect(to(sent, viewer)).toHaveLength(1);
    const row = await one<{ disabled: boolean }>(
      db(),
      sql`select disabled_at is not null as disabled from public.push_subscriptions
          where endpoint = ${extra}`,
    );
    expect(row.disabled).toBe(true);
  });

  it("utan konfigurerad push: inget läses och inget tas om hand", async () => {
    fake.state.orders.push(order(id(), 1));
    await sync();
    const before = (await claimed()).length;
    const res = await runSaleNotifications(db(), { only: [orgId], sender: null });
    expect(res.skipped).toBe("push_off");
    expect((await claimed()).length).toBe(before);
    // Rensa till nästa test.
    await run(fakeSender().sender);
  });

  it("knappen av: inget skickas", async () => {
    await turnOn(orgId, viewer, { on: false });
    fake.state.orders.push(order(id(), 1));
    await sync();
    const { sender, sent } = fakeSender();
    await run(sender);
    expect(to(sent, viewer)).toEqual([]);
    expect(to(sent, owner)).toHaveLength(1);
  });
});

describe("RLS", () => {
  it("var och en ändrar sin egen knapp; påfyllaren kan inte ändra ägarens", async () => {
    await turnOn(orgId, owner, { on: true });
    const before = await one<{ since: string | null }>(
      db(),
      sql`select sale_push_since::text as since from public.profiles
          where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`,
    );
    expect(before.since).not.toBeNull();
    // På igen behåller tidpunkten (inga gamla köp på nytt).
    await turnOn(orgId, owner, { on: true });
    const same = await one<{ since: string | null }>(
      db(),
      sql`select sale_push_since::text as since from public.profiles
          where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`,
    );
    expect(same.since).toBe(before.since);

    // Påfyllaren ser bara sin egen profil (RLS): uppdateringen träffar ingen rad.
    await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.profiles set sale_push_since = null
              where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`,
        ),
      ),
    );
    const still = await one<{ since: string | null }>(
      db(),
      sql`select sale_push_since::text as since from public.profiles
          where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`,
    );
    expect(still.since).not.toBeNull();
  });

  it("sale_notifications syns för ägare och admin, inte för läsare, påfyllare eller butik", async () => {
    const count = (u: TestUser) =>
      asUser(u, (tx) =>
        one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.sale_notifications
              where organization_id = ${orgId}::uuid`,
        ),
      );
    expect((await count(owner)).n).toBeGreaterThan(0);
    expect((await count(admin)).n).toBeGreaterThan(0);
    expect((await count(viewer)).n).toBe(0);
    expect((await count(refiller)).n).toBe(0);
    expect((await count(storeUser)).n).toBe(0);
    const outsider = await createUser();
    await createOrg(outsider);
    expect((await count(outsider)).n).toBe(0);
  });

  it("ingen klientroll skriver sale_notifications", async () => {
    const [row] = await rows<{ order_id: string }>(
      db(),
      sql`select id::text as order_id from public.orders
          where organization_id = ${orgId}::uuid order by ordered_at desc limit 1`,
    );
    for (const u of [owner, admin]) {
      const ins = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`insert into public.sale_notifications (organization_id, order_id)
                values (${orgId}::uuid, ${row!.order_id}::uuid)`,
          ),
        ),
      );
      expect(ins.ok).toBe(false);
      const del = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`delete from public.sale_notifications where organization_id = ${orgId}::uuid`,
          ),
        ),
      );
      expect(del.ok).toBe(false);
    }
  });
});
