/**
 * Awish: automatens anslutning (Machines.is_online) och kontots slutdag (Merchant.expired_at)
 * mot testdatabasen och låtsas-Awish (src/server/awish/testing/fake-server.ts):
 *
 * - synken sparar online/offline per källautomat; offline i 20 minuter ger larmet
 *   "BL-001 är offline sedan 14:10" (machine_offline) via larmjobbet, som stängs när
 *   automaten är tillbaka; fladder ger samma incident och ingen ny avisering,
 * - en automat som aldrig varit online larmar inte,
 * - public.machine_connectivity: alla roller i organisationen (påfyllaren också), andra nekas,
 * - Merchant läses högst en gång per dygn; slutdagen sparas i källans tidszon,
 * - påminnelsen 30 och 7 dagar före (bara ägare och admin),
 * - klientroller kan inte skriva anslutningen eller slutdagen.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { connectivityView } from "../../src/analytics/health";
import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { evaluateOrganization } from "../../src/server/alerts/evaluate";
import { healthOf, loadHealthData } from "../../src/server/alerts/inputs";
import { loadAwishExpiryFor } from "../../src/server/awish/expiry-notice";
import {
  orgsNeedingOfflineEvaluation,
  runOfflineAlerts,
} from "../../src/server/awish/offline-alerts";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { syncAwishSource } from "../../src/server/awish/sync";
import {
  fakeOrder,
  startFakeAwish,
  type FakeAwish,
} from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";

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

const MIN = 60_000;
/** 14:00 i Stockholm. */
const T0 = Date.parse("2026-11-02T13:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN);
/** Tidpunkt ur en rå SQL-rad (text eller Date) som ISO 8601. */
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString();

let owner: TestUser;
let refiller: TestUser;
let orgId: string;
let sourceId: string;
let m1: string;
let m2: string;

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [
      { id: "2", name: "Centrum", machine_no: "163271xx", is_online: true },
      { id: "3", name: "Aldrig på", machine_no: "163272xx", is_online: false },
    ],
  });
  owner = await createUser();
  orgId = await createOrg(owner);
  refiller = await createMember(orgId, "refiller");
  const machines = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Centrum", activeFrom: "2026-10-01" },
        { organizationId: orgId, code: "BL-002", name: "Aldrig på", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  m1 = machines.find((m) => m.code === "BL-001")!.id;
  m2 = machines.find((m) => m.code === "BL-002")!.id;
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  }));
  // Ägaren prenumererar på alla larm (push), så att aviseringarna räknas.
  await asUser(owner, (tx) =>
    tx
      .insert(s.alertSubscriptions)
      .values({ organizationId: orgId, userId: owner.id, channels: ["push"] }),
  );
});
afterAll(async () => {
  await fake.stop();
});

/** Synkar vid minut `minutes` med automat 2 online eller inte. */
async function syncAt(minutes: number, online: boolean) {
  fake.state.machines[0]!.is_online = online;
  const r = await syncAwishSource(
    { db: db(), connect, now: () => at(minutes) },
    {
      dataSourceId: sourceId,
    },
  );
  expect(r.ok, r.message ?? "").toBe(true);
  return r;
}

async function machineAlerts() {
  return rows<{
    id: string;
    kind: string;
    status: string;
    title: string;
    machine_id: string;
    notify_count: number;
    reopen_count: number;
  }>(
    db(),
    sql`select id, kind, status, title, machine_id, notify_count, reopen_count from public.alerts
        where organization_id = ${orgId}::uuid and incident_key like 'machine:%'
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

async function state(externalId: string) {
  return one<{
    awish_online: boolean | null;
    awish_offline_since: Date | null;
    awish_online_at: Date | null;
    awish_back_online_at: Date | null;
  }>(
    db(),
    sql`select awish_online, awish_offline_since, awish_online_at, awish_back_online_at
        from public.source_machines
        where data_source_id = ${sourceId}::uuid and external_id = ${externalId}`,
  );
}

describe("offlinelarm", () => {
  it("synken sparar läget per källautomat (även innan automaten är kopplad)", async () => {
    await syncAt(0, true);
    const a = await state("2");
    expect(a.awish_online).toBe(true);
    expect(iso(a.awish_online_at)).toBe(at(0).toISOString());
    const b = await state("3");
    expect(b.awish_online).toBe(false);
    expect(b.awish_online_at).toBeNull();
    expect(b.awish_offline_since).toBeNull();
    await db().execute(sql`
      update public.source_machines set machine_id = case external_id
        when '2' then ${m1}::uuid when '3' then ${m2}::uuid end
      where data_source_id = ${sourceId}::uuid and external_id in ('2', '3')`);
  });

  it("offline 10 minuter: inget larm; 20 minuter: 'BL-001 är offline sedan 14:10'", async () => {
    await syncAt(10, false);
    expect(iso((await state("2")).awish_offline_since)).toBe(at(10).toISOString());
    await evaluateOrganization(db(), orgId, at(20));
    await syncAt(20, false);
    await evaluateOrganization(db(), orgId, at(29));
    expect(await machineAlerts()).toEqual([]);

    await syncAt(30, false);
    const summary = await evaluateOrganization(db(), orgId, at(30));
    expect(summary.status).toBe("ok");
    const alerts = await machineAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "machine_offline",
      status: "open",
      title: "BL-001 är offline sedan 14:10",
      machine_id: m1,
      notify_count: 1,
    });
    expect(await deliveries()).toBe(1);
  });

  it("en automat som aldrig varit online larmar inte", async () => {
    expect((await machineAlerts()).some((a) => a.machine_id === m2)).toBe(false);
    const health = await asUser(owner, async (tx) =>
      healthOf(await loadHealthData(tx, orgId, "2026-11-02", at(30)), "Europe/Stockholm", at(30)),
    );
    expect(health.find((h) => h.machineId === m1)?.status).toBe("offline");
    expect(health.find((h) => h.machineId === m2)?.status).not.toBe("offline");
  });

  it("påfyllaren läser anslutningen; en utomstående nekas", async () => {
    const list = await asUser(refiller, (tx) =>
      rows<{ machine_id: string; online: boolean; offline_since: Date | null }>(
        tx,
        sql`select machine_id, online, offline_since from public.machine_connectivity(${orgId}::uuid)`,
      ),
    );
    expect(list.map((r) => r.machine_id).sort()).toEqual([m1, m2].sort());
    const data = await asUser(refiller, (tx) => loadHealthData(tx, orgId, "2026-11-02", at(30)));
    const c = data.connectivity.find((x) => x.machineId === m1);
    expect(connectivityView(c, at(30))).toEqual({
      state: "offline",
      since: at(10).toISOString(),
    });
    const stranger = await createUser();
    const denied = await asUser(stranger, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select * from public.machine_connectivity(${orgId}::uuid)`),
      ),
    );
    expect(denied.code).toBe("42501");
  });

  it("tillbaka online: larmet stängs av larmjobbet", async () => {
    await syncAt(40, true);
    await evaluateOrganization(db(), orgId, at(40));
    for (const m of [50, 60, 70]) await syncAt(m, true);
    await evaluateOrganization(db(), orgId, at(75));
    const alerts = await machineAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe("closed");
    const st = await state("2");
    expect(st.awish_offline_since).toBeNull();
  });

  it("fladder: tillbaka offline inom 20 minuter är samma period och samma incident, ingen ny avisering", async () => {
    const before = await deliveries();
    await syncAt(80, false);
    await syncAt(90, true);
    await syncAt(100, false); // fladder: perioden från 80 fortsätter
    expect(iso((await state("2")).awish_offline_since)).toBe(at(80).toISOString());
    await syncAt(110, false);
    await evaluateOrganization(db(), orgId, at(110));
    const alerts = await machineAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      status: "open",
      title: "BL-001 är offline sedan 15:20",
      reopen_count: 1,
    });
    expect(await deliveries()).toBe(before);
  });

  it("Awish-cronen utvärderar larmen direkt (larmjobbet går bara en gång om dagen)", async () => {
    const other = await createOrg(await createUser());
    expect(await orgsNeedingOfflineEvaluation(db(), [orgId, other, ""], at(110))).toEqual([orgId]);
    const sent: { key: string; userId: string }[] = [];
    const run = await runOfflineAlerts(db(), [orgId, other], {
      now: at(120),
      baseUrl: "http://test",
      dispatch: async (delivery, recipient) => {
        for (const item of delivery.items) sent.push({ key: item.key, userId: recipient.userId });
        return {
          results: [{ channel: "push", status: "sent", detail: "test" }],
          goneDevices: [],
          okDevices: [],
          status: "sent",
        };
      },
    });
    expect(run.organizations.map((o) => [o.organizationId, o.status])).toEqual([[orgId, "ok"]]);
    // Offlinelarmet från 14:30 (i kön sedan dess) skickas nu till ägaren.
    expect(sent).toContainEqual({ key: `machine:${m1}`, userId: owner.id });
    // Utan automat offline och utan öppet offlinelarm: ingen extra körning.
    for (const m of [130, 140, 150]) await syncAt(m, true);
    await evaluateOrganization(db(), orgId, at(185));
    expect((await machineAlerts())[0]!.status).toBe("closed");
    expect(await orgsNeedingOfflineEvaluation(db(), [orgId], at(185))).toEqual([]);
  });

  it("klientroller kan inte skriva anslutningen", async () => {
    const outcome = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.source_machines set awish_online = false, awish_offline_since = now()
              where data_source_id = ${sourceId}::uuid and external_id = '2'`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});

describe("Awish-kontots slutdag", () => {
  it("läses vid synken, i källans tidszon, högst en gång per dygn", async () => {
    const src = await one<{
      awish_expires_at: Date | null;
      awish_merchant_checked_at: Date | null;
      tz: string;
    }>(
      db(),
      sql`select awish_expires_at, awish_merchant_checked_at, source_timezone as tz
          from public.data_sources where id = ${sourceId}::uuid`,
    );
    expect(src.tz).toBe("Asia/Shanghai");
    expect(iso(src.awish_expires_at)).toBe("2027-04-18T15:48:54.000Z");
    expect(iso(src.awish_merchant_checked_at)).toBe(at(0).toISOString());
    // Alla synkar ovan (0–110 min) läste Merchant en gång.
    expect(fake.state.calls.filter((c) => c.method === "Merchant")).toHaveLength(1);

    fake.state.merchantExpiredAt = "2026-11-20 12:00:00";
    await syncAt(24 * 60 - 1, true);
    expect(fake.state.calls.filter((c) => c.method === "Merchant")).toHaveLength(1);
    await syncAt(24 * 60, true);
    expect(fake.state.calls.filter((c) => c.method === "Merchant")).toHaveLength(2);
    const after = await one<{ awish_expires_at: Date | null }>(
      db(),
      sql`select awish_expires_at from public.data_sources where id = ${sourceId}::uuid`,
    );
    expect(iso(after.awish_expires_at)).toBe("2026-11-20T04:00:00.000Z");
  });

  it("påminnelsen: inget före 30 dagar, 'soon' inom 30, brådskande inom 7; bara ägare och admin", async () => {
    const viewer = await viewerFor(owner, orgId);
    const expires = Date.parse("2026-11-20T04:00:00Z");
    const day = 86_400_000;
    expect(await loadAwishExpiryFor(viewer, new Date(expires - 40 * day))).toBeNull();
    const soon = await loadAwishExpiryFor(viewer, new Date(expires - 20 * day));
    expect(soon?.level).toBe("soon");
    expect(soon?.text.replace(/ /g, " ")).toBe(
      "Awish-kontot går ut 20 nov. 2026 – förläng hos Awish",
    );
    expect((await loadAwishExpiryFor(viewer, new Date(expires - 5 * day)))?.level).toBe("now");
    expect(
      await loadAwishExpiryFor(await viewerFor(refiller, orgId), new Date(expires - 5 * day)),
    ).toBeNull();
  });

  it("klientroller kan inte ändra slutdagen", async () => {
    const outcome = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.data_sources set awish_expires_at = now() + interval '1 year'
              where id = ${sourceId}::uuid`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
    // Andra ändringar av källan går som förut.
    const rename = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.data_sources set name = 'Awish API' where id = ${sourceId}::uuid`,
        ),
      ),
    );
    expect(rename.ok).toBe(true);
  });
});

describe("anslutningen när orderna stoppar synken", () => {
  it("läget sparas ändå (annars tystnar offlinelarmet medan orderna inte går att läsa)", async () => {
    const f = await startFakeAwish({
      machines: [{ id: "7", name: "Hamnen", machine_no: "163279xx", is_online: true }],
    });
    try {
      const o = await createUser();
      const org = await createOrg(o);
      const { dataSourceId } = await saveAwishCredentialsFor(await viewerFor(o, org), {
        appId: f.state.appId,
        appSecret: f.state.appSecret,
        appKey: f.state.appKey,
      });
      const conn = (creds: { appId: string; appSecret: string; appKey: string }) =>
        createAwishClient(creds, { address: f.address, tls: false, sleep: async () => {} });
      const first = await syncAwishSource(
        { db: db(), connect: conn, now: () => at(0) },
        { dataSourceId },
      );
      expect(first.ok, first.message ?? "").toBe(true);
      // Ett heltalsbelopp stoppar synken av order (AwishSyncStop) tills någon rättar det.
      f.state.orders = [fakeOrder(9001, { payTime: "2026-11-02 21:05:00", amount: "400" })];
      f.state.machines[0]!.is_online = false;
      const stopped = await syncAwishSource(
        { db: db(), connect: conn, now: () => at(10) },
        { dataSourceId },
      );
      expect(stopped.ok).toBe(false);
      const st = await one<{ awish_online: boolean | null; awish_offline_since: Date | null }>(
        db(),
        sql`select awish_online, awish_offline_since from public.source_machines
            where data_source_id = ${dataSourceId}::uuid and external_id = '7'`,
      );
      expect(st.awish_online).toBe(false);
      expect(iso(st.awish_offline_since)).toBe(at(10).toISOString());
    } finally {
      await f.stop();
    }
  });
});

describe("audit_log: anslutningen loggas inte i varje tick", () => {
  /**
   * Synken skriver source_machines.awish_* (senast sedd, online) i varje körning, var
   * femte minut. audit_log är append-only: en rad per automat och tick skulle bli
   * hundratusentals rader om året. Kopplingen till en automat (machine_id) loggas som förut.
   */
  const auditRows = async () =>
    (
      await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.audit_log
            where organization_id = ${orgId}::uuid and table_name = 'source_machines'`,
      )
    ).n;

  it("ticks som bara ändrar awish_* ger ingen loggrad; en ny koppling gör det", async () => {
    const before = await auditRows();
    await syncAt(3 * 24 * 60, true);
    await syncAt(3 * 24 * 60 + 5, true);
    await syncAt(3 * 24 * 60 + 10, false);
    await syncAt(3 * 24 * 60 + 15, true);
    expect(await auditRows()).toBe(before);

    await asUser(owner, (tx) =>
      tx.execute(
        sql`update public.source_machines set machine_id = null
            where data_source_id = ${sourceId}::uuid and external_id = '3'`,
      ),
    );
    expect(await auditRows()).toBe(before + 1);
    await asUser(owner, (tx) =>
      tx.execute(
        sql`update public.source_machines set machine_id = ${m2}::uuid
            where data_source_id = ${sourceId}::uuid and external_id = '3'`,
      ),
    );
    expect(await auditRows()).toBe(before + 2);
  });
});
