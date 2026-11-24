/**
 * När hämtningen från Awish stannar eller misslyckas ska ägaren höra det på en gång
 * (robusthet 1B, punkt 3), mot testdatabasen och låtsas-Awish:
 *
 * - En körning där orderna inte hann hämtas (anropet tog slut på tid) är ett fel, inte en
 *   lyckad hämtning av noll order: "senast hämtat" flyttas inte fram.
 * - Tre fel i rad ger ett kritiskt larm direkt (watch:synk:<källa>) med utskick till
 *   ägaren, också när ägaren har valt enskilda larmtyper. Nästa lyckade körning nollställer
 *   räknaren och stänger larmet.
 * - 30 minuter utan lyckad hämtning larmar också när inget försök görs (jobbet står still).
 * - Datans ålder per automat räknas från när automaten senast sågs i en hämtning.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import {
  AwishApiError,
  createAwishClient,
  type AwishApi,
} from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { NO_ORDERS_IN_TIME, parseState, syncAwishSource } from "../../src/server/awish/sync";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";
import { loadMachineAges, syncWatchAlerts, watchFor } from "../../src/server/monitoring/watch";

import { asUser, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

const ENV = { MAIL_PROVIDER: "outbox" } as const;
const MIN = 60_000;
const T0 = Date.parse("2026-11-19T12:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN);

let fake: FakeAwish;
let owner: TestUser;
let orgId: string;
let sourceId: string;
/** true = Orders hinner inte svara (tiden tar slut), Machines svarar som vanligt. */
let ordersHang = false;

const connect = (creds: { appId: string; appSecret: string; appKey: string }) => {
  const real = createAwishClient(creds, {
    address: fake.address,
    tls: false,
    sleep: async () => {},
  });
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "orders" && ordersHang) {
        return async () => {
          throw new AwishApiError("budget", "Tiden tog slut.");
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as AwishApi & typeof real;
};

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const sync = (minutes: number) =>
  syncAwishSource({ db: db(), connect, now: () => at(minutes) }, { dataSourceId: sourceId });

async function source() {
  const row = await one<{ cursor: string | null; last_synced_at: unknown }>(
    db(),
    sql`select cursor, last_synced_at from public.data_sources where id = ${sourceId}::uuid`,
  );
  return {
    state: parseState(row.cursor),
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at as string).toISOString() : null,
  };
}

async function syncAlerts() {
  return rows<{ status: string; severity: string; title: string; message: string }>(
    db(),
    sql`select status, severity::text, title, message from public.alerts
        where organization_id = ${orgId}::uuid and incident_key = ${`watch:synk:${sourceId}`}
        order by triggered_at`,
  );
}

async function deliveries(): Promise<string[]> {
  return (
    await rows<{ subject: string }>(
      db(),
      sql`select subject from public.alert_deliveries
          where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid
          order by created_at`,
    )
  ).map((r) => r.subject);
}

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [{ id: "2", name: "Centrum", machine_no: "163271xx", is_online: true }],
  });
  owner = await createUser();
  orgId = await createOrg(owner);
  await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Centrum", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  }));
  // Ägaren har valt enskilda larmtyper: systemlarmet om hämtningen ska ändå nå fram.
  await asUser(owner, (tx) =>
    tx
      .update(s.alertSubscriptions)
      .set({ kinds: ["low_stock"], channels: ["email"], quietStart: null, quietEnd: null })
      .where(sql`organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`),
  );
});
afterAll(async () => {
  await fake.stop();
});

describe("hämtningen från Awish", () => {
  it("en lyckad körning: senast hämtat flyttas fram, inga fel räknas", async () => {
    const r = await sync(0);
    expect(r.ok, r.message ?? "").toBe(true);
    const { state, lastSyncedAt } = await source();
    expect(state.lastSuccessAt).toBe(at(0).toISOString());
    expect(state.failures ?? 0).toBe(0);
    expect(lastSyncedAt).not.toBeNull();
    expect((await watchFor(db(), orgId, at(1), ENV)).map((l) => l.key)).not.toContain(
      `synk:${sourceId}`,
    );
  });

  it("orderna hann inte hämtas: körningen är ett fel och senast hämtat står kvar", async () => {
    const before = await source();
    ordersHang = true;
    const r = await sync(5);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(NO_ORDERS_IN_TIME);
    const after = await source();
    expect(after.state.lastSuccessAt).toBe(at(0).toISOString());
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt);
    expect(after.state.failures).toBe(1);
    expect(after.state.lastRun).toMatchObject({ ok: false, message: NO_ORDERS_IN_TIME });
    // Ett fel larmar inte än.
    await syncWatchAlerts(db(), orgId, at(5), ENV);
    expect(await syncAlerts()).toEqual([]);
  });

  it("tre fel i rad: kritiskt larm på en gång, med utskick till ägaren", async () => {
    await sync(10);
    await syncWatchAlerts(db(), orgId, at(10), ENV);
    expect(await syncAlerts()).toEqual([]);
    await sync(15);
    expect((await source()).state.failures).toBe(3);
    // 15 minuter sedan senaste lyckade: under 30 minuter, men tre fel i rad.
    await syncWatchAlerts(db(), orgId, at(15), ENV);
    await syncWatchAlerts(db(), orgId, at(16), ENV);
    const alerts = await syncAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: "open", severity: "critical" });
    expect(alerts[0]!.title.startsWith("Försäljningen har inte hämtats sedan ")).toBe(true);
    expect(alerts[0]!.message).toContain(`Awish svarar med fel: ${NO_ORDERS_IN_TIME}`);
    expect(alerts[0]!.message).toContain(
      "Försäljningen står still tills det fungerar igen. Ladda upp orderlistan från Awish i Datakällor så länge.",
    );
    // Ett utskick (inte ett per körning), fast ägaren bara har valt "Titel nära slut".
    const sent = await deliveries();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith("Försäljningen har inte hämtats sedan ")).toBe(true);
  });

  it("nästa lyckade körning nollställer räknaren och stänger larmet", async () => {
    ordersHang = false;
    const r = await sync(20);
    expect(r.ok, r.message ?? "").toBe(true);
    expect((await source()).state.failures ?? 0).toBe(0);
    await syncWatchAlerts(db(), orgId, at(20), ENV);
    expect((await syncAlerts()).map((a) => a.status)).toEqual(["closed"]);
    // Ett besked om att det fungerar igen (till den som fick larmet), inte fler.
    await syncWatchAlerts(db(), orgId, at(21), ENV);
    expect(await deliveries()).toEqual([
      expect.stringMatching(/^Försäljningen har inte hämtats sedan /),
      "Försäljningen hämtas från Awish igen",
    ]);
  });

  it("30 minuter utan lyckad hämtning larmar också när inget försök görs", async () => {
    const lines = await watchFor(db(), orgId, at(55), ENV);
    const line = lines.find((l) => l.key === `synk:${sourceId}`);
    expect(line?.level).toBe("critical");
    expect(line?.detail).toContain("Hämtningen körs inte alls just nu.");
    // 29 minuter efter den senaste lyckade: inte än.
    expect((await watchFor(db(), orgId, at(49), ENV)).map((l) => l.key)).not.toContain(
      `synk:${sourceId}`,
    );
  });

  it("datans ålder per automat räknas från när automaten senast sågs", async () => {
    await asUser(owner, (tx) =>
      tx.execute(
        sql`update public.source_machines sm set machine_id = m.id
            from public.machines m
            where sm.organization_id = ${orgId}::uuid and m.organization_id = sm.organization_id
              and m.code = 'BL-001' and sm.machine_id is null`,
      ),
    );
    const fresh = await loadMachineAges(db(), orgId, at(23));
    expect(fresh).toMatchObject([
      { label: "BL-001", minutes: 3, stale: false, text: "3 min sedan" },
    ]);
    const stale = await loadMachineAges(db(), orgId, at(20 + 130));
    expect(stale).toMatchObject([{ label: "BL-001", stale: true, text: "2 tim 10 min sedan" }]);
  });
});
