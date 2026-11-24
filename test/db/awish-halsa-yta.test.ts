/**
 * Om Awish krånglar, ytan (WP3): hälsan per Awish-väg (public.awish_path_health) blir
 * vaktens rader och larm, Kontrollens fynd och raderna i Datakällor. Mot testdatabasen och
 * låtsas-Awish (aldrig riktiga Awish). Hälsoraderna skrivs med samma API som synken
 * (recordPathResult, openBreaker), med en låtsasklocka.
 *
 * - Reservvägen fungerar (Products ger INTERNAL, facken läses via webbpanelen): inget larm,
 *   ingen push, bara en statusrad. fallback_since sätts av triggern och står kvar.
 * - 30 minuter utan någon väg: ett kritiskt larm och EN push. Fler körningar ger ingen ny.
 * - Det fungerar igen: larmet stängs och EN push om att det fungerar igen.
 * - Påfyllningar som väntar mer än 60 min larmar; inloggningsfel på webbpanelen direkt.
 * - Kontroll: kön, kontots slutdag och reservvägen längre än ett dygn.
 * - Datakällor: raderna på svenska (13 = Awish internt fel).
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { syncFreshnessCheck } from "../../src/analytics/self-check";
import * as s from "../../src/db/schema";
import { awishHealthPanel } from "../../src/app/(app)/datakallor/_lib/awish-health-load";
import { listOrganizationsFor } from "../../src/server/access";
import { AwishApiError, createAwishClient } from "../../src/server/awish/grpc-client";
import { openBreaker, recordPathResult } from "../../src/server/awish/health";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { syncAwishSource } from "../../src/server/awish/sync";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";
import {
  awishFreshnessFor,
  loadAwishWatchFacts,
  syncWatchAlerts,
  watchFor,
} from "../../src/server/monitoring/watch";
import { querySyncSources } from "../../src/server/self-check/queries";

import { asUser, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

const ENV = { MAIL_PROVIDER: "outbox" } as const;
const MIN = 60_000;
// Två timmar före organisationen skapas: kontrollen och larmjobbet har inget att sakna
// (de larmar först efter ett dygn), så bara Awish-raderna kan larma här.
const T0 = Math.floor(Date.now() / MIN) * MIN - 120 * MIN;
const at = (minutes: number) => new Date(T0 + minutes * MIN);
const internal = () => new AwishApiError("server", "Awish svarade med ett internt fel.", 13);

let fake: FakeAwish;
let owner: TestUser;
let orgId: string;
let sourceId: string;
let machineId: string;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const record = (
  path: Parameters<typeof recordPathResult>[1]["path"],
  route: Parameters<typeof recordPathResult>[1]["route"],
  ok: boolean,
  minutes: number,
  error?: unknown,
) =>
  recordPathResult(db(), {
    organizationId: orgId,
    dataSourceId: sourceId,
    path,
    route,
    ok,
    error,
    now: at(minutes),
  });

/** Orderna hämtades (Open API): hälsan och källans "senast hämtat" (cursor). */
async function ordersOk(minutes: number) {
  await record("orders", "open_api", true, minutes);
  const t = at(minutes).toISOString();
  await db().execute(
    sql`update public.data_sources
        set cursor = (coalesce(cursor, '{}')::jsonb
                      || jsonb_build_object('lastSuccessAt', ${t}::text, 'failures', 0,
                                            'lastRun', jsonb_build_object('at', ${t}::text, 'ok', true)))::text
        where id = ${sourceId}::uuid`,
  );
}

async function alerts(key: string) {
  return rows<{ status: string; severity: string; title: string }>(
    db(),
    sql`select status, severity::text, title from public.alerts
        where organization_id = ${orgId}::uuid and incident_key = ${`watch:${key}`}
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

async function health(path: string) {
  return one<{ active_route: string; fallback_since: unknown; alerted_at: unknown }>(
    db(),
    sql`select active_route, fallback_since, alerted_at from public.awish_path_health
        where data_source_id = ${sourceId}::uuid and path = ${path}`,
  );
}

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [{ id: "2", name: "Centrum", machine_no: "163271xx", is_online: true }],
  });
  owner = await createUser();
  orgId = await createOrg(owner);
  const [m] = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Centrum", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  machineId = m!.id;
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  }));
  // En lyckad synk mot låtsas-Awish (orderna hämtade, automaten kopplad).
  const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
    createAwishClient(creds, { address: fake.address, tls: false, sleep: async () => {} });
  const r = await syncAwishSource(
    { db: db(), connect, now: () => at(0) },
    { dataSourceId: sourceId },
  );
  expect(r.ok, r.message ?? "").toBe(true);
  await asUser(owner, (tx) =>
    tx.execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where organization_id = ${orgId}::uuid and machine_id is null`,
    ),
  );
  // Ägaren vill ha larm (push och e-post), alla typer, inga tysta timmar.
  await asUser(owner, (tx) =>
    tx
      .update(s.alertSubscriptions)
      .set({ channels: ["email"], quietStart: null, quietEnd: null })
      .where(sql`organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`),
  );
  // Orderna fungerar hela tiden (Open API), automaterna också.
  await ordersOk(0);
  await record("machines", "open_api", true, 0);
});
afterAll(async () => {
  await fake.stop();
});

describe("lagret via reservvägen", () => {
  it("Products ger INTERNAL, webbpanelen fungerar: inget larm, bara en statusrad", async () => {
    await record("stock", "open_api", true, 0);
    for (const m of [5, 10, 15, 60, 120]) {
      await record("stock", "webbpanelen", true, m, internal());
      await ordersOk(m);
      await record("machines", "open_api", true, m);
      await syncWatchAlerts(db(), orgId, at(m + 1), ENV);
    }
    const h = await health("stock");
    expect(h.active_route).toBe("webbpanelen");
    // Triggern: reservvägen sedan första gången, inte senaste.
    expect(new Date(h.fallback_since as string).toISOString()).toBe(at(5).toISOString());
    expect(await alerts("awish:stock")).toEqual([]);
    expect(await deliveries()).toEqual([]);
    const lines = await watchFor(db(), orgId, at(121), ENV);
    expect(lines.map((l) => l.key).filter((k) => k.startsWith("awish:"))).toEqual([]);
    const fresh = await awishFreshnessFor(db(), orgId, at(121));
    expect(fresh.banner).toBeNull();
    expect(fresh.status).toEqual([
      {
        key: "awish-reserv:stock",
        text: expect.stringMatching(
          /^Lager i automaterna: via webbpanelen sedan \d\d:\d\d \(Open API: Awish internt fel\)\.$/,
        ),
      },
    ]);
    expect(fresh.text).toMatch(/^Försäljning .* · Lager .*$/);
  });

  it("Datakällor: Reservväg: webbpanelen med felet på svenska", async () => {
    const panel = await awishHealthPanel(db(), orgId, "Europe/Stockholm", at(121));
    const stock = panel.rows.find((r) => r.path === "stock");
    expect(stock).toMatchObject({ state: "fallback", label: "Lager i automaterna" });
    expect(stock!.text).toMatch(/^Reservväg: webbpanelen sedan /);
    expect(stock!.error).toMatch(/: Awish internt fel \(13\)$/);
    expect(panel.rows.find((r) => r.path === "orders")?.state).toBe("ok");
    expect(panel.summary).toEqual({ tone: "warn", text: "Reservvägen används" });
  });
});

describe("ingen väg för lagret", () => {
  const base = 3 * 60;

  it("30 min utan väg: ett larm och en push, fler körningar ger ingen ny", async () => {
    await record("stock", "open_api", true, base);
    const unavailable = new AwishApiError("unavailable", "Awish svarar inte.", 14);
    for (const m of [5, 10, 20, 31, 36, 41]) {
      await record("stock", "senast_kanda", false, base + m, unavailable);
      await ordersOk(base + m);
      await record("machines", "open_api", true, base + m);
      await syncWatchAlerts(db(), orgId, at(base + m), ENV);
    }
    const open = await alerts("awish:stock");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ status: "open", severity: "critical" });
    expect(open[0]!.title).toMatch(/^Lagret har inte lästs sedan /);
    expect(await deliveries()).toEqual([expect.stringMatching(/^Lagret har inte lästs sedan /)]);
    expect((await health("stock")).alerted_at).not.toBeNull();
  });

  it("det fungerar igen: larmet stängs och en push om det", async () => {
    await record("stock", "webbpanelen", true, base + 45, internal());
    // Reservvägen läste automaten (annars larmar vakten att just den inte läses).
    await db().execute(
      sql`update public.stock_locations set awish_synced_at = ${at(base + 45).toISOString()}::timestamptz
          where organization_id = ${orgId}::uuid and machine_id = ${machineId}::uuid`,
    );
    await syncWatchAlerts(db(), orgId, at(base + 45), ENV);
    await syncWatchAlerts(db(), orgId, at(base + 50), ENV);
    expect((await alerts("awish:stock")).map((a) => a.status)).toEqual(["closed"]);
    expect(await deliveries()).toEqual([
      expect.stringMatching(/^Lagret har inte lästs sedan /),
      "Lagret läses från Awish igen",
    ]);
    expect((await health("stock")).alerted_at).toBeNull();
  });
});

describe("automaternas status och påfyllningarna", () => {
  const base = 4 * 60;

  it("Machines svarar inte: varning efter 30 min, inga falska offline-larm", async () => {
    await record("machines", "open_api", true, base);
    const down = new AwishApiError("unavailable", "Awish svarar inte.", 14);
    await record("machines", "senast_kanda", false, base + 5, down);
    await record("machines", "senast_kanda", false, base + 31, down);
    const lines = await watchFor(db(), orgId, at(base + 31), ENV);
    const line = lines.find((l) => l.key === "awish:machines");
    expect(line).toMatchObject({ level: "warning" });
    expect(line!.title).toMatch(/^Vi vet inte om automaterna är online sedan /);
    const later = await watchFor(db(), orgId, at(base + 121), ENV);
    expect(later.find((l) => l.key === "awish:machines")?.level).toBe("critical");
    await record("machines", "open_api", true, base + 125);
  });

  it("påfyllning som väntar mer än 60 min larmar; Kontroll säger samma sak", async () => {
    await db().execute(sql`
      insert into public.automation_log (organization_id, kind, machine_id, units, occurred_at)
      values (${orgId}::uuid, 'awish_push_failed', ${machineId}::uuid, 0,
              ${at(base + 130).toISOString()}::timestamptz)`);
    const facts = await loadAwishWatchFacts(db(), orgId);
    expect(facts.push).toEqual({ pendingMachines: 1, oldestAt: at(base + 130).toISOString() });
    expect((await watchFor(db(), orgId, at(base + 170), ENV)).map((l) => l.key)).not.toContain(
      "awish:push",
    );
    const lines = await watchFor(db(), orgId, at(base + 191), ENV);
    expect(lines.find((l) => l.key === "awish:push")?.title).toBe(
      "Påfyllningen i en automat har inte nått Awish",
    );
    const check = syncFreshnessCheck({
      sources: await querySyncSources(db(), orgId, "Europe/Stockholm", at(base + 191)),
      now: at(base + 191),
    });
    expect(check.findings.map((f) => f.text)).toContainEqual(
      expect.stringContaining("en automat har väntat på Awish i 61 min"),
    );
  });

  it("inloggningsfel på webbpanelen: larm direkt", async () => {
    const auth = new AwishApiError("auth", "Inloggningen till Awish misslyckades.");
    await record("push", "ingen", false, base + 192, auth);
    await openBreaker(db(), sourceId, "push", "webbpanelen", "auth", at(base + 192));
    const lines = await watchFor(db(), orgId, at(base + 192), ENV);
    expect(lines.find((l) => l.key === "awish:push")).toMatchObject({
      level: "critical",
      title: "Inloggningen till webbpanelen fungerar inte",
    });
  });
});

describe("Kontroll", () => {
  it("Kontroll: reservvägen längre än ett dygn ger en varning", async () => {
    const day = 7 * 60 + 26 * 60;
    await record("stock", "webbpanelen", true, day, internal());
    await ordersOk(day);
    const sources = await querySyncSources(db(), orgId, "Europe/Stockholm", at(day));
    const result = syncFreshnessCheck({ sources, now: at(day) });
    expect(result.findings.map((f) => f.text)).toContainEqual(
      expect.stringContaining("Open API har inte fungerat på ett dygn – kontakta Awish."),
    );
    // Open API fungerar igen: fallback_since nollställs och varningen försvinner.
    await record("stock", "open_api", true, day + 5);
    expect((await health("stock")).fallback_since).toBeNull();
    const after = syncFreshnessCheck({
      sources: await querySyncSources(db(), orgId, "Europe/Stockholm", at(day + 5)),
      now: at(day + 5),
    });
    expect(after.findings.map((f) => f.text).join(" ")).not.toContain("kontakta Awish");
  });
});
