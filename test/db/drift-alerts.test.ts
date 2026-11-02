/**
 * Drift (fas 8) mot testdatabasen, hela vägen från databasen:
 *
 * - Misstänkt fel härleds ur försäljningen: en automat som slutat sälja mitt på dagen får
 *   status misstänkt fel, den andra är i drift.
 * - Larm dupliceras inte: samma problem i flera körningar av larmjobbet är EN rad i alerts
 *   och EN avisering per mottagare; utskicken skickas en gång.
 * - Behörighet: påfyllaren ser larm om automater men inte om import, och kan bara
 *   prenumerera på automater och lager.
 * - Påfyllning från fältet är idempotent per klient-id (register_refill_once).
 * - Kundärenden: ordern måste höra till automaten och återbetalningar spärras i stängd månad.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { machineHealth } from "@/analytics/health";
import * as s from "@/db/schema";
import type { AlertDelivery } from "@/analytics/alerts";
import { deliverDue } from "@/server/alerts/deliver";
import { evaluateOrganization } from "@/server/alerts/evaluate";
import { loadHealthData } from "@/server/alerts/inputs";
import type { DispatchResult, Recipient } from "@/server/notify";

import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

/** Tisdag 20 okt. 2026 16:30 svensk tid (sommartid). */
const NOW = new Date("2026-10-20T14:30:00Z");
const MIN = 60_000;

let owner: TestUser;
let refiller: TestUser;
let viewer: TestUser;
let orgId: string;
let m1: string;
let m2: string;
let titleId: string;
let dataSourceId: string;

/** Samlar utskick i stället för att skicka (stub för dispatchDelivery). */
const sent: { delivery: AlertDelivery; recipient: Recipient }[] = [];
async function stubDispatch(delivery: AlertDelivery, recipient: Recipient): Promise<DispatchResult> {
  sent.push({ delivery, recipient });
  return {
    results: [{ channel: "email", status: "sent", detail: "test" }],
    goneDevices: [],
    okDevices: [],
    status: "sent",
  };
}

beforeAll(async () => {
  owner = await createUser(`owner-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Drift ${uniqueSuffix()}`);
  refiller = await createMember(orgId, "refiller");
  viewer = await createMember(orgId, "viewer");

  await asPostgres(async (tx) => {
    const org = { organizationId: orgId };
    const machines = await tx
      .insert(s.machines)
      .values([
        { ...org, code: "BL-101", name: "Automat Ett", activeFrom: "2026-08-01" },
        { ...org, code: "BL-102", name: "Automat Två", activeFrom: "2026-08-01" },
      ])
      .returning({ id: s.machines.id });
    m1 = machines[0]!.id;
    m2 = machines[1]!.id;
    const [title] = await tx.insert(s.titles).values({ ...org, name: "Testtitel" }).returning();
    titleId = title!.id;
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    dataSourceId = source!.id;

    // Lager: inventering 1 000 pack i varje automat i början.
    await tx.execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      select ${orgId}::uuid, l.id, ${titleId}::uuid, 'count', 1000, '2026-08-01T06:00:00Z'::timestamptz, 'Start'
      from public.stock_locations l where l.organization_id = ${orgId}::uuid and l.kind = 'machine'`);

    // Försäljning: ett pack i timmen 10:15–19:15 svensk tid varje dag i 8 veckor i båda
    // automaterna. Automat Två slutar efter 10:15 i dag; Automat Ett säljer fram till nu.
    await tx.execute(sql`
      insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                 ordered_at, amount_ore, machine_id, source_hash)
      select ${orgId}::uuid, ${dataSourceId}::uuid, m.code || '-' || to_char(t, 'YYYYMMDDHH24'),
             'Testtitel', ${titleId}::uuid, t, 4900, m.id, 'test'
      from public.machines m
      cross join generate_series('2026-08-22 10:15'::timestamp, '2026-10-20 19:15'::timestamp, interval '1 hour') g(local)
      cross join lateral (select (g.local at time zone 'Europe/Stockholm') as t) z
      where m.organization_id = ${orgId}::uuid
        and extract(hour from g.local) between 10 and 19
        and t < ${NOW.toISOString()}::timestamptz - interval '10 minutes'
        and (m.code = 'BL-101' or t <= '2026-10-20T08:15:00Z'::timestamptz)`);
  });

  // Prenumerationer: ägaren (alla larm, e-post) och påfyllaren (automater och lager, push).
  await asUser(owner, (tx) =>
    tx.insert(s.alertSubscriptions).values({ organizationId: orgId, userId: owner.id, channels: ["email"] }),
  );
  await asUser(refiller, (tx) =>
    tx.insert(s.alertSubscriptions).values({
      organizationId: orgId,
      userId: refiller.id,
      kinds: ["machine_suspected_fault", "machine_offline", "machine_fault", "low_stock"],
      channels: ["push"],
    }),
  );
});

async function alertRows() {
  return rows<{ incident_key: string; kind: string; status: string; occurrences: number; notify_count: number }>(
    db(),
    sql`select incident_key, kind, status, occurrences, notify_count from public.alerts
        where organization_id = ${orgId}::uuid order by triggered_at, incident_key`,
  );
}

async function deliveryCount(): Promise<number> {
  const [r] = await rows<{ n: number }>(
    db(),
    sql`select count(*)::int as n from public.alert_deliveries where organization_id = ${orgId}::uuid`,
  );
  return r!.n;
}

describe("härledning av misstänkt fel", () => {
  it("automaten som slutat sälja är misstänkt fel, den andra i drift", async () => {
    const health = await asUser(owner, async (tx) => {
      const data = await loadHealthData(tx, orgId, "2026-10-20");
      return machineHealth({ orders: data.orders, machines: data.machines, stock: data.stock }, NOW);
    });
    const byId = new Map(health.map((h) => [h.machineId, h]));
    expect(byId.get(m1)?.status).toBe("ok");
    const two = byId.get(m2)!;
    expect(two.status).toBe("suspected_fault");
    expect(two.source).toBe("sales");
    // Underlaget: tystnaden från senaste ordern (10:15 svensk tid) och sannolikheten under 1 %.
    expect(two.silence?.from).toBe("2026-10-20T08:15:00.000Z");
    expect(two.silence?.anomalous).toBe(true);
    expect(two.silence!.zeroProbabilityBp).toBeLessThan(100);
  });

  it("påfyllaren får samma status ur lagrets försäljning (utan belopp)", async () => {
    const health = await asUser(refiller, async (tx) => {
      const data = await loadHealthData(tx, orgId, "2026-10-20");
      expect(data.orders.every((o) => o.amountOre === 0)).toBe(true);
      return machineHealth({ orders: data.orders, machines: data.machines, stock: data.stock }, NOW);
    });
    expect(health.find((h) => h.machineId === m2)?.status).toBe("suspected_fault");
  });
});

describe("larmjobbet dubblerar inte larm", () => {
  it("första körningen skapar en incident och ett utskick per prenumerant", async () => {
    const summary = await evaluateOrganization(db(), orgId, NOW);
    expect(summary.status).toBe("ok");
    const alerts = await alertRows();
    expect(alerts).toEqual([
      expect.objectContaining({
        incident_key: `machine:${m2}`,
        kind: "machine_suspected_fault",
        status: "open",
        occurrences: 1,
        notify_count: 1,
      }),
    ]);
    expect(await deliveryCount()).toBe(2);
  });

  it("samma problem i fem körningar till är fortfarande en rad och inga nya utskick", async () => {
    for (let i = 1; i <= 5; i++) {
      const summary = await evaluateOrganization(db(), orgId, new Date(NOW.getTime() + i * 10 * MIN));
      expect(summary.status).toBe("ok");
      expect(summary.notifications).toBe(0);
    }
    const alerts = await alertRows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: "open", occurrences: 6, notify_count: 1 });
    expect(await deliveryCount()).toBe(2);
  });

  it("två samtidiga körningar ger fortfarande en incident", async () => {
    const at = new Date(NOW.getTime() + 60 * MIN);
    const results = await Promise.all([
      evaluateOrganization(db(), orgId, at),
      evaluateOrganization(db(), orgId, at),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(expect.arrayContaining(["ok"]));
    expect((await alertRows()).filter((a) => a.status === "open")).toHaveLength(1);
    expect(await deliveryCount()).toBe(2);
  });

  it("utskicken skickas en gång, till rätt kanal", async () => {
    const first = await deliverDue(db(), { now: new Date(NOW.getTime() + 61 * MIN), baseUrl: "http://test", dispatch: stubDispatch });
    expect(first.processed).toBeGreaterThanOrEqual(2);
    const mine = sent.filter((x) => [owner.id, refiller.id].includes(x.recipient.userId));
    expect(mine).toHaveLength(2);
    expect(mine.find((x) => x.recipient.userId === owner.id)?.recipient.channels).toEqual(["email"]);
    expect(mine.find((x) => x.recipient.userId === owner.id)?.recipient.email).toBe(owner.email);
    expect(mine.find((x) => x.recipient.userId === refiller.id)?.recipient.channels).toEqual(["push"]);
    expect(mine[0]!.delivery.items[0]!.key).toBe(`machine:${m2}`);

    const again = await deliverDue(db(), { now: new Date(NOW.getTime() + 62 * MIN), baseUrl: "http://test", dispatch: stubDispatch });
    expect(sent.filter((x) => [owner.id, refiller.id].includes(x.recipient.userId))).toHaveLength(2);
    expect(again.sent).toBe(0);
  });

  it("när automaten säljer igen stängs incidenten, utan 'löst'-utskick till den som inte vill ha det", async () => {
    await asPostgres((tx) =>
      tx.execute(sql`
        insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                   ordered_at, amount_ore, machine_id, source_hash)
        values (${orgId}::uuid, ${dataSourceId}::uuid, 'BL-102-igen', 'Testtitel', ${titleId}::uuid,
                ${new Date(NOW.getTime() + 65 * MIN).toISOString()}::timestamptz, 4900, ${m2}::uuid, 'test')`),
    );
    await evaluateOrganization(db(), orgId, new Date(NOW.getTime() + 70 * MIN));
    await evaluateOrganization(db(), orgId, new Date(NOW.getTime() + 110 * MIN));
    const alerts = await alertRows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe("closed");
    expect(await deliveryCount()).toBe(2);
  });
});

describe("behörighet", () => {
  it("påfyllaren ser larm om automater men inte om import", async () => {
    await asPostgres((tx) =>
      tx.insert(s.imports).values({
        organizationId: orgId,
        dataSourceId,
        trigger: "upload",
        parserVersion: "test",
        fileName: "orderlista.csv",
        storagePath: `${orgId}/imports/orderlista.csv`,
        status: "failed",
        startedAt: new Date(),
        finishedAt: new Date(),
      }),
    );
    // Importen har skapats nu (created_at), så körningen görs nu.
    await evaluateOrganization(db(), orgId, new Date(Date.now() + MIN));
    const groups = async (u: TestUser) =>
      (await asUser(u, (tx) => rows<{ g: string }>(tx, sql`select alert_group as g from public.alerts where organization_id = ${orgId}::uuid`)))
        .map((r) => r.g)
        .filter((g, i, all) => all.indexOf(g) === i)
        .sort();
    expect(await groups(owner)).toEqual(expect.arrayContaining(["import", "machine"]));
    expect(await groups(viewer)).toEqual(await groups(owner));
    expect(await groups(refiller)).toEqual(["machine"]);
  });

  it("påfyllaren kan inte prenumerera på alla larm eller kvittera", async () => {
    const other = await createMember(orgId, "refiller");
    const all = await asUser(other, (tx) =>
      attempt(tx, (sp) => sp.insert(s.alertSubscriptions).values({ organizationId: orgId, userId: other.id, channels: ["push"] })),
    );
    expect(all.ok).toBe(false);
    const ack = await asUser(refiller, (tx) =>
      tx.update(s.alerts).set({ acknowledgedAt: new Date() }).where(sql`organization_id = ${orgId}::uuid`).returning({ id: s.alerts.id }),
    );
    expect(ack).toHaveLength(0);
  });

  it("ägaren kvitterar; vem och när sätts av databasen", async () => {
    const [a] = await asUser(owner, (tx) =>
      tx
        .update(s.alerts)
        .set({ acknowledgedAt: new Date("2000-01-01T00:00:00Z") })
        .where(sql`organization_id = ${orgId}::uuid and alert_group = 'import'`)
        .returning({ by: s.alerts.acknowledgedBy, at: s.alerts.acknowledgedAt }),
    );
    expect(a?.by).toBe(owner.id);
    expect(a!.at!.getFullYear()).toBeGreaterThan(2000);
  });

  it("en användare ser bara sina egna prenumerationer och push-enheter", async () => {
    await asUser(owner, (tx) =>
      tx.insert(s.pushSubscriptions).values({
        organizationId: orgId,
        userId: owner.id,
        endpoint: `https://push.example/${randomUUID()}`,
        p256dh: "x".repeat(40),
        authSecret: "y".repeat(16),
      }),
    );
    const seen = await asUser(viewer, async (tx) => ({
      subs: (await tx.select().from(s.alertSubscriptions)).length,
      push: (await tx.select().from(s.pushSubscriptions)).length,
    }));
    expect(seen).toEqual({ subs: 0, push: 0 });
  });
});

describe("påfyllning från fältet", () => {
  it("samma klient-id ger en lagerhändelse, och ett ändrat innehåll avvisas", async () => {
    const clientId = randomUUID();
    const call = (qty: number) =>
      asUser(refiller, (tx) =>
        rows<{ stock_event_id: string; duplicate: boolean }>(
          tx,
          sql`select * from public.register_refill_once(${orgId}::uuid, ${clientId}::uuid, ${m1}::uuid,
                ${titleId}::uuid, ${qty}, false, now() - interval '1 hour', 'offline')`,
        ),
      );
    const first = await call(12);
    const second = await call(12);
    expect(first[0]!.duplicate).toBe(false);
    expect(second[0]).toEqual({ stock_event_id: first[0]!.stock_event_id, duplicate: true });
    const [n] = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events where organization_id = ${orgId}::uuid and kind = 'refill' and note = 'offline'`,
    );
    expect(n!.n).toBe(1);
    const changed = await settle(call(13));
    expect(changed.ok).toBe(false);
  });

  it("läsaren kan inte registrera påfyllning", async () => {
    const r = await settle(
      asUser(viewer, (tx) =>
        tx.execute(sql`select * from public.register_refill_once(${orgId}::uuid, ${randomUUID()}::uuid, ${m1}::uuid, ${titleId}::uuid, 1)`),
      ),
    );
    expect(r.ok).toBe(false);
  });
});

describe("kundärenden", () => {
  it("ordern måste komma från ärendets automat", async () => {
    const [order] = await rows<{ id: string }>(
      db(),
      sql`select id from public.orders where organization_id = ${orgId}::uuid and machine_id = ${m1}::uuid limit 1`,
    );
    const wrong = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.incidents).values({ organizationId: orgId, machineId: m2, kind: "not_delivered", startedAt: NOW, orderId: order!.id }),
      ),
    );
    expect(wrong.ok).toBe(false);
    const right = await asUser(owner, (tx) =>
      tx
        .insert(s.incidents)
        .values({
          organizationId: orgId,
          machineId: m1,
          kind: "not_delivered",
          startedAt: NOW,
          orderId: order!.id,
          refundedOre: 4900,
          refundedOn: "2026-10-20",
        })
        .returning({ id: s.incidents.id }),
    );
    expect(right).toHaveLength(1);
    // Ändringen loggas.
    const [log] = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log where table_name = 'incidents' and row_id = ${right[0]!.id}::uuid`,
    );
    expect(log!.n).toBe(1);
  });

  it("påfyllaren ser inga ärenden", async () => {
    const n = await asUser(refiller, (tx) => tx.select().from(s.incidents));
    expect(n).toHaveLength(0);
  });

  it("en återbetalning i en stängd månad stoppas (BL004)", async () => {
    await asUser(owner, (tx) => tx.execute(sql`select public.close_period(${orgId}::uuid, '2026-09-01'::date)`));
    const r = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.incidents).values({
          organizationId: orgId,
          machineId: m1,
          kind: "refund_request",
          startedAt: new Date("2026-09-15T10:00:00Z"),
          refundedOre: 4900,
          refundedOn: "2026-09-15",
        }),
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BL004");
  });
});

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await p };
  } catch {
    return { ok: false };
  }
}
