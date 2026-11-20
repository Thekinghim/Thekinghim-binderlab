/**
 * Butikens strömtider (stores.power_on_time/power_off_time, 20261222000000_butik_stromtider)
 * mot testdatabasen och låtsas-Awish:
 *
 * - ägare och admin sparar tiderna (Butiker → butiken), läsaren och påfyllaren läser dem men
 *   kan inte ändra, en annan organisation ser dem inte; kontrollerna avvisar fel värden,
 * - offline medan strömmen är av enligt tiderna: inget larm, ingen notis, Awish-cronen väcker
 *   inte larmjobbet, och statusen är "strömmen av"; tillbaka inom marginalen: inget alls,
 * - inte tillbaka efter marginalen: larmet "offline sedan 10:00", som stängs när automaten är
 *   tillbaka; offline mitt på dagen larmar som förut och larmet ligger kvar på natten,
 * - ett offlinelarm från natten (innan tiderna fanns) stängs när tiderna sparas och kommer
 *   inte tillbaka på morgonen,
 * - Fyll på vet vilka automater som står i en butik med strömtider (påminnelsen om omstart).
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { connectivityView } from "../../src/analytics/health";
import { setStorePowerHoursFor } from "../../src/app/(app)/butiker/_lib/service";
import { loadFillDataFor } from "../../src/app/fyll-pa/_lib/data";
import { needsRestartReminder } from "../../src/app/fyll-pa/_lib/model";
import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { evaluateOrganization } from "../../src/server/alerts/evaluate";
import { healthOf, loadHealthData } from "../../src/server/alerts/inputs";
import { orgsNeedingOfflineEvaluation } from "../../src/server/awish/offline-alerts";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import {
  saveAwishCredentialsFor,
  saveAwishWebCredentialsFor,
  setAwishWebPushFor,
} from "../../src/server/awish/manage";
import { summariseAwishPush } from "../../src/server/awish/push-status";
import { startFakeAwishWeb } from "../../src/server/awish/testing/fake-web-server";
import { createAwishWebClient } from "../../src/server/awish/web-client";
import { pushMachinesToAwish } from "../../src/server/awish/web-service";
import { syncAwishSource } from "../../src/server/awish/sync";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";

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

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeAwish;
const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
  createAwishClient(creds, { address: fake.address, tls: false, sleep: async () => {} });

/** Lokal tid i Stockholm (vintertid, +01:00) dag `day` i november 2026. */
const L = (day: number, hhmm: string) =>
  new Date(`2026-11-${String(day).padStart(2, "0")}T${hhmm}:00+01:00`);

let owner: TestUser;
let admin: TestUser;
let refiller: TestUser;
let reader: TestUser;
let orgId: string;
let sourceId: string;
/** Automat i butiken som stänger av strömmen (21:00–10:00). */
let m1: string;
/** Automat i butiken med ström dygnet runt. */
let m2: string;
let nightStore: string;
let dayStore: string;

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [
      { id: "11", name: "Natt", machine_no: "500001xx", is_online: true },
      { id: "12", name: "Dygnet runt", machine_no: "500002xx", is_online: true },
    ],
  });
  owner = await createUser();
  orgId = await createOrg(owner);
  admin = await createMember(orgId, "admin");
  refiller = await createMember(orgId, "refiller");
  reader = await createMember(orgId, "viewer");
  const machines = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Natt", activeFrom: "2026-10-01" },
        { organizationId: orgId, code: "BL-002", name: "Dygnet runt", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  m1 = machines.find((m) => m.code === "BL-001")!.id;
  m2 = machines.find((m) => m.code === "BL-002")!.id;
  const stores = await asUser(owner, (tx) =>
    tx
      .insert(s.stores)
      .values([
        { organizationId: orgId, name: "Testbutik Kvällsstängd" },
        { organizationId: orgId, name: "Testbutik Dygnet Runt" },
      ])
      .returning({ id: s.stores.id, name: s.stores.name }),
  );
  nightStore = stores.find((x) => x.name === "Testbutik Kvällsstängd")!.id;
  dayStore = stores.find((x) => x.name === "Testbutik Dygnet Runt")!.id;
  await asUser(owner, (tx) =>
    tx.insert(s.machinePlacements).values([
      { organizationId: orgId, machineId: m1, storeId: nightStore, validFrom: "2026-10-01" },
      { organizationId: orgId, machineId: m2, storeId: dayStore, validFrom: "2026-10-01" },
    ]),
  );
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  }));
  await asUser(owner, (tx) =>
    tx
      .insert(s.alertSubscriptions)
      .values({ organizationId: orgId, userId: owner.id, channels: ["push"] })
      .onConflictDoUpdate({
        target: [s.alertSubscriptions.organizationId, s.alertSubscriptions.userId],
        set: { channels: ["push"], active: true },
      }),
  );
  // Första synken (båda online) och kopplingen till Binderlabs automater.
  await syncAt(L(18, "12:00"), true, true);
  await db().execute(sql`
    update public.source_machines set machine_id = case external_id
      when '11' then ${m1}::uuid when '12' then ${m2}::uuid end
    where data_source_id = ${sourceId}::uuid and external_id in ('11', '12')`);
});
afterAll(async () => {
  await fake.stop();
});

async function syncAt(now: Date, nightOnline: boolean, dayOnline = true) {
  fake.state.machines[0]!.is_online = nightOnline;
  fake.state.machines[1]!.is_online = dayOnline;
  const r = await syncAwishSource(
    { db: db(), connect, now: () => now },
    { dataSourceId: sourceId },
  );
  expect(r.ok, r.message ?? "").toBe(true);
}

/** Synkar var tionde minut från `from` till `to` (lokal tid samma dag). */
async function syncEvery(day: number, from: string, to: string, nightOnline: boolean) {
  for (let t = L(day, from).getTime(); t <= L(day, to).getTime(); t += 10 * 60_000) {
    await syncAt(new Date(t), nightOnline);
  }
}

async function offlineAlerts() {
  return rows<{ status: string; title: string; machine_id: string; notify_count: number }>(
    db(),
    sql`select status, title, machine_id, notify_count from public.alerts
        where organization_id = ${orgId}::uuid and kind = 'machine_offline'
        order by triggered_at`,
  );
}

async function deliveries(): Promise<number> {
  return (
    await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.alert_deliveries where organization_id = ${orgId}::uuid`,
    )
  ).n;
}

async function healthAt(now: Date) {
  return asUser(owner, async (tx) => {
    const data = await loadHealthData(tx, orgId, now.toISOString().slice(0, 10) as never, now);
    return { data, health: healthOf(data, "Europe/Stockholm", now) };
  });
}

describe("larm innan strömtiderna finns (som förut)", () => {
  it("offline på natten larmar; när tiderna sparas stängs larmet", async () => {
    await syncEvery(18, "20:50", "20:50", true);
    await syncEvery(18, "21:05", "21:35", false);
    await evaluateOrganization(db(), orgId, L(18, "21:35"));
    let alerts = await offlineAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: "open", machine_id: m1 });

    const res = await setStorePowerHoursFor(await viewerFor(owner, orgId), {
      storeId: nightStore,
      hours: { on: "10:00", off: "21:00" },
    });
    expect(res.ok).toBe(true);
    await syncEvery(18, "21:45", "23:00", false);
    await evaluateOrganization(db(), orgId, L(18, "23:00"));
    alerts = await offlineAlerts();
    expect(alerts.map((a) => a.status)).toEqual(["closed"]);
  });

  it("tillbaka inom marginalen på morgonen: larmet kommer inte tillbaka", async () => {
    const before = await deliveries();
    await syncEvery(19, "09:30", "09:50", false);
    await evaluateOrganization(db(), orgId, L(19, "09:50"));
    await syncEvery(19, "10:05", "10:40", true);
    await evaluateOrganization(db(), orgId, L(19, "10:40"));
    expect((await offlineAlerts()).map((a) => a.status)).toEqual(["closed"]);
    // Bara notisen från första natten (innan tiderna fanns), ingen ny.
    expect(await deliveries()).toBe(before);
  });
});

describe("strömtiderna: RLS och kontroller", () => {
  it("läsaren och påfyllaren läser tiderna", async () => {
    for (const u of [reader, refiller]) {
      const r = await asUser(u, (tx) =>
        one<{ on: string; off: string }>(
          tx,
          sql`select power_on_time as on, power_off_time as off from public.stores
              where id = ${nightStore}::uuid`,
        ),
      );
      expect(r).toEqual({ on: "10:00", off: "21:00" });
    }
  });

  it("bara ägare och admin ändrar", async () => {
    for (const u of [reader, refiller]) {
      const res = await setStorePowerHoursFor(await viewerFor(u, orgId), {
        storeId: nightStore,
        hours: null,
      });
      expect(res.ok).toBe(false);
      const raw = await asUser(u, (tx) =>
        rows(
          tx,
          sql`update public.stores set power_on_time = null, power_off_time = null
              where id = ${nightStore}::uuid returning id`,
        ),
      );
      expect(raw).toHaveLength(0);
    }
    const ok = await setStorePowerHoursFor(await viewerFor(admin, orgId), {
      storeId: nightStore,
      hours: { on: "10:00", off: "21:00" },
    });
    expect(ok.ok).toBe(true);
  });

  it("en annan organisation ser inte tiderna och kan inte ändra dem", async () => {
    const stranger = await createUser();
    const otherOrg = await createOrg(stranger);
    const seen = await asUser(stranger, (tx) =>
      rows(tx, sql`select power_on_time from public.stores where id = ${nightStore}::uuid`),
    );
    expect(seen).toHaveLength(0);
    const res = await setStorePowerHoursFor(await viewerFor(stranger, otherOrg), {
      storeId: nightStore,
      hours: null,
    });
    expect(res).toEqual({ ok: false, error: "Butiken finns inte." });
  });

  it("kontrollerna: båda eller ingen, olika tider, TT:MM", async () => {
    for (const q of [
      sql`update public.stores set power_on_time = '10:00', power_off_time = null where id = ${dayStore}::uuid`,
      sql`update public.stores set power_on_time = '10:00', power_off_time = '10:00' where id = ${dayStore}::uuid`,
      sql`update public.stores set power_on_time = '25:00', power_off_time = '21:00' where id = ${dayStore}::uuid`,
    ]) {
      const r = await asUser(owner, (tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(r.code).toBe("23514");
    }
    const bad = await setStorePowerHoursFor(await viewerFor(owner, orgId), {
      storeId: dayStore,
      hours: { on: "21:00", off: "21:00" },
    });
    expect(bad.ok).toBe(false);
  });
});

describe("offline medan strömmen är av", () => {
  it("natten: inget larm, ingen notis, statusen är strömmen av", async () => {
    const before = await deliveries();
    await syncEvery(19, "20:50", "20:50", true);
    await syncEvery(19, "21:05", "23:55", false);
    await evaluateOrganization(db(), orgId, L(19, "23:55"));
    expect(await orgsNeedingOfflineEvaluation(db(), [orgId], L(19, "23:55"))).toEqual([]);
    expect((await offlineAlerts()).filter((a) => a.status === "open")).toEqual([]);
    expect(await deliveries()).toBe(before);

    const { data, health } = await healthAt(L(19, "23:55"));
    const h1 = health.find((h) => h.machineId === m1)!;
    expect(h1.status).not.toBe("offline");
    expect(h1.powerOff).toEqual({
      since: expect.any(String),
      until: L(20, "10:00").toISOString(),
    });
    expect(h1.title).toBe("Strömmen av (enligt butikens tider)");
    const view = connectivityView(
      data.connectivity.find((c) => c.machineId === m1),
      L(19, "23:55"),
    );
    expect(view.state).toBe("power_off");
    // Automaten med ström dygnet runt berörs inte.
    expect(health.find((h) => h.machineId === m2)!.powerOff).toBeUndefined();
  });

  it("inte tillbaka 10:30: larmet 'offline sedan 10:00'; tillbaka: stängs", async () => {
    await syncEvery(20, "09:30", "10:20", false);
    await evaluateOrganization(db(), orgId, L(20, "10:20"));
    expect((await offlineAlerts()).filter((a) => a.status === "open")).toEqual([]);
    await syncEvery(20, "10:30", "10:35", false);
    expect(await orgsNeedingOfflineEvaluation(db(), [orgId], L(20, "10:35"))).toEqual([orgId]);
    await evaluateOrganization(db(), orgId, L(20, "10:35"));
    const open = (await offlineAlerts()).filter((a) => a.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ machine_id: m1, title: "BL-001 är offline sedan 10:00" });

    await syncEvery(20, "10:45", "11:15", true);
    await evaluateOrganization(db(), orgId, L(20, "11:15"));
    expect((await offlineAlerts()).filter((a) => a.status === "open")).toEqual([]);
  });

  it("offline mitt på dagen larmar som förut, och larmet ligger kvar på natten", async () => {
    await syncEvery(20, "13:00", "13:00", false);
    await syncEvery(20, "13:10", "13:30", false);
    await evaluateOrganization(db(), orgId, L(20, "13:30"));
    let open = (await offlineAlerts()).filter((a) => a.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe("BL-001 är offline sedan 13:00");
    await syncEvery(20, "13:40", "22:30", false);
    await evaluateOrganization(db(), orgId, L(20, "22:30"));
    open = (await offlineAlerts()).filter((a) => a.status === "open");
    expect(open).toHaveLength(1);
    const { health } = await healthAt(L(20, "22:30"));
    expect(health.find((h) => h.machineId === m1)!.status).toBe("offline");
    // Tillbaka nästa morgon: stängs.
    await syncEvery(21, "10:05", "10:40", true);
    await evaluateOrganization(db(), orgId, L(21, "10:40"));
    expect((await offlineAlerts()).filter((a) => a.status === "open")).toEqual([]);
  });
});

describe("Fyll på", () => {
  it("vet vilka automater som står i en butik med strömtider", async () => {
    const data = await loadFillDataFor(await viewerFor(refiller, orgId), L(21, "12:00"));
    expect(data.restartAfterPush).toEqual([m1]);
  });

  it("utan strömtider: ingen påminnelse", async () => {
    await setStorePowerHoursFor(await viewerFor(owner, orgId), {
      storeId: nightStore,
      hours: null,
    });
    const data = await loadFillDataFor(await viewerFor(owner, orgId), L(21, "12:00"));
    expect(data.restartAfterPush).toEqual([]);
  });
});

describe("Fyll på mot låtsas-Awish: påminnelsen efter en sändning", () => {
  it("Awish fick nya antal: påminnelse för automaten i butiken med strömtider, inte för den andra", async () => {
    const owner_ = await viewerFor(owner, orgId);
    await setStorePowerHoursFor(owner_, {
      storeId: nightStore,
      hours: { on: "10:00", off: "21:00" },
    });
    const now = 1_762_250_000_000;
    const fakeWeb = await startFakeAwishWeb({
      now: () => now,
      products: {
        "11": [
          {
            id: 1,
            goodId: 5,
            goodName: "Testtitel Blå",
            status: true,
            currentInventory: 2,
            capacity: 8,
            channelName: "A1",
          },
        ],
        "12": [
          {
            id: 2,
            goodId: 5,
            goodName: "Testtitel Blå",
            status: true,
            currentInventory: 2,
            capacity: 8,
            channelName: "A1",
          },
        ],
      },
    });
    try {
      await saveAwishWebCredentialsFor(owner_, {
        email: fakeWeb.state.email,
        password: fakeWeb.state.password,
      });
      await setAwishWebPushFor(owner_, true);
      // Binderlab efter påfyllningen: 8 pack i båda automaterna (Awish har 2).
      await asPostgres(async (tx) => {
        const [t] = Array.from(
          await tx.execute(
            sql`insert into public.titles (organization_id, name)
                values (${orgId}::uuid, 'Testtitel Blå') returning id`,
          ),
        ) as { id: string }[];
        await tx.execute(sql`
          insert into public.stock_events
            (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
          select ${orgId}::uuid, l.id, ${t!.id}::uuid, 'count', 8, now(), 'test'
          from public.stock_locations l
          where l.organization_id = ${orgId}::uuid and l.machine_id in (${m1}::uuid, ${m2}::uuid)`);
      });
      const deps = {
        serviceDb: db(),
        makeClient: (o: Parameters<typeof createAwishWebClient>[0] = {}) =>
          createAwishWebClient({ ...o, baseUrl: fakeWeb.baseUrl, now: () => now }),
        clientOptions: { baseUrl: fakeWeb.baseUrl, now: () => now },
      };
      const data = await loadFillDataFor(await viewerFor(refiller, orgId), L(21, "12:00"));
      const night = summariseAwishPush(await pushMachinesToAwish(orgId, [m1], deps), [m1]);
      expect(night).toMatchObject({ state: "sent", kind: "sent", slots: 1 });
      expect(fakeWeb.state.products["11"]![0]!.currentInventory).toBe(8);
      expect(needsRestartReminder(night, [m1], data.restartAfterPush)).toBe(true);
      const day = summariseAwishPush(await pushMachinesToAwish(orgId, [m2], deps), [m2]);
      expect(day).toMatchObject({ state: "sent", kind: "sent", slots: 1 });
      expect(needsRestartReminder(day, [m2], data.restartAfterPush)).toBe(false);
      // Awish hade redan rätt antal: inget skickades, ingen påminnelse.
      const again = summariseAwishPush(await pushMachinesToAwish(orgId, [m1], deps), [m1]);
      expect(again).toMatchObject({ kind: "alreadyRight" });
      expect(needsRestartReminder(again, [m1], data.restartAfterPush)).toBe(false);
    } finally {
      await fakeWeb.stop();
    }
  });
});
