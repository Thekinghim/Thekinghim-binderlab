/**
 * Oberoende granskning (red team) av Drift (fas 8): försök att kringgå behörigheten och
 * spärrarna i databasen för larm, prenumerationer, push-enheter, utskick, kundärenden och
 * påfyllning från fältet.
 *
 * Testerna beskriver det säkra beteendet. Ett test som fallerar är ett fynd i granskningen.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { AlertDelivery } from "@/analytics/alerts";
import * as s from "@/db/schema";
import { deliverDue } from "@/server/alerts/deliver";
import { evaluateOrganization } from "@/server/alerts/evaluate";
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
  settle,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

let owner: TestUser;
let viewer: TestUser;
let refiller: TestUser;
let storeUser: TestUser | null = null;
let orgId: string;
let otherOwner: TestUser;
let otherOrg: string;
let m1: string;
let m2: string;
let t1: string;
let t2: string;
let otherMachine: string;
let otherTitle: string;
let importAlert: string;
let machineAlert: string;

beforeAll(async () => {
  owner = await createUser(`rt-owner-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `RT Drift ${uniqueSuffix()}`);
  viewer = await createMember(orgId, "viewer");
  refiller = await createMember(orgId, "refiller");
  // Butiksanvändare (portalen): medlemskap med rollen store och en butik.
  storeUser = await createUser(`rt-store-${uniqueSuffix()}@test.binderlab.se`);
  await asPostgres(async (tx) => {
    const [store] = await rows<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name) values (${orgId}::uuid, 'RT Butik') returning id`,
    );
    await tx.execute(
      sql`insert into public.memberships (organization_id, user_id, role, store_id)
          values (${orgId}::uuid, ${storeUser!.id}::uuid, 'store', ${store!.id}::uuid)`,
    );
  });
  otherOwner = await createUser(`rt-other-${uniqueSuffix()}@test.binderlab.se`);
  otherOrg = await createOrg(otherOwner, `RT Annan ${uniqueSuffix()}`);

  await asPostgres(async (tx) => {
    const ms = await tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "RT-1", name: "RT Ett", activeFrom: "2026-01-01" },
        { organizationId: orgId, code: "RT-2", name: "RT Två", activeFrom: "2026-01-01" },
        { organizationId: otherOrg, code: "RT-X", name: "RT Annan", activeFrom: "2026-01-01" },
      ])
      .returning({ id: s.machines.id });
    m1 = ms[0]!.id;
    m2 = ms[1]!.id;
    otherMachine = ms[2]!.id;
    const ts = await tx
      .insert(s.titles)
      .values([
        { organizationId: orgId, name: "RT Titel A" },
        { organizationId: orgId, name: "RT Titel B" },
        { organizationId: otherOrg, name: "RT Titel X" },
      ])
      .returning({ id: s.titles.id });
    t1 = ts[0]!.id;
    t2 = ts[1]!.id;
    otherTitle = ts[2]!.id;
    const as = await tx
      .insert(s.alerts)
      .values([
        {
          organizationId: orgId,
          kind: "import_failed",
          severity: "critical" as const,
          evidence: {},
          incidentKey: "import:rt",
          alertGroup: "import",
          title: "Importen misslyckades",
        },
        {
          organizationId: orgId,
          kind: "machine_offline",
          severity: "critical" as const,
          evidence: {},
          machineId: m1,
          incidentKey: `machine:${m1}`,
          alertGroup: "machine",
          title: "RT Ett är ur drift",
        },
      ])
      .returning({ id: s.alerts.id });
    importAlert = as[0]!.id;
    machineAlert = as[1]!.id;
  });
});

// ---------------------------------------------------------------------------
// Larm
// ---------------------------------------------------------------------------

describe("larm: läsning och kvittering", () => {
  it("påfyllaren ser larmet om automaten men inte importlarmet", async () => {
    const ids = (await asUser(refiller, (tx) => tx.select({ id: s.alerts.id }).from(s.alerts))).map(
      (r) => r.id,
    );
    expect(ids).toContain(machineAlert);
    expect(ids).not.toContain(importAlert);
  });

  it("butiken (portal) ser inga larm", async () => {
    if (!storeUser) return;
    const r = await asUser(storeUser, (tx) => tx.select({ id: s.alerts.id }).from(s.alerts));
    expect(r).toHaveLength(0);
  });

  it("läsaren och påfyllaren kan inte kvittera", async () => {
    for (const u of [viewer, refiller]) {
      const r = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`update public.alerts set acknowledged_at = now() where id = ${machineAlert}::uuid returning id`,
          ),
        ),
      );
      if (r.ok) expect(Array.from(r.value as unknown as unknown[])).toHaveLength(0);
    }
  });

  it("ägaren kan inte skriva om larmets innehåll eller stänga det", async () => {
    const r = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.alerts set status = 'closed', closed_at = now() where id = ${machineAlert}::uuid`,
        ),
      ),
    );
    expect(r.ok).toBe(false);
    const ins = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp
          .insert(s.alerts)
          .values({ organizationId: orgId, kind: "x_y", severity: "info", evidence: {} }),
      ),
    );
    expect(ins.ok).toBe(false);
  });

  it("den som kvitterade kan inte förfalskas (acknowledged_by)", async () => {
    await asUser(owner, (tx) =>
      tx.execute(
        sql`update public.alerts set acknowledged_at = now() where id = ${machineAlert}::uuid`,
      ),
    );
    // Ändra bara acknowledged_by till någon annan, utan att röra acknowledged_at.
    await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.alerts set acknowledged_by = ${viewer.id}::uuid where id = ${machineAlert}::uuid`,
        ),
      ),
    );
    const [row] = await rows<{ acknowledged_by: string }>(
      db(),
      sql`select acknowledged_by from public.alerts where id = ${machineAlert}::uuid`,
    );
    expect(row!.acknowledged_by).toBe(owner.id);
  });
});

// ---------------------------------------------------------------------------
// Prenumerationer, push-enheter, utskick
// ---------------------------------------------------------------------------

describe("prenumerationer och push-enheter", () => {
  it("påfyllaren kan inte prenumerera på alla larm eller på import/avvikande dag", async () => {
    for (const kinds of [null, ["import_failed"], ["low_stock", "day_anomaly"]]) {
      const r = await asUser(refiller, (tx) =>
        attempt(tx, (sp) =>
          sp.insert(s.alertSubscriptions).values({
            organizationId: orgId,
            userId: refiller.id,
            kinds: kinds as string[] | null,
            channels: ["email"],
          }),
        ),
      );
      expect(r.ok).toBe(false);
    }
  });

  it("ingen kan skapa en prenumeration åt någon annan", async () => {
    const r = await asUser(viewer, (tx) =>
      attempt(tx, (sp) =>
        sp
          .insert(s.alertSubscriptions)
          .values({ organizationId: orgId, userId: owner.id, channels: ["email"] }),
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("butiken (portal) kan inte prenumerera på larm", async () => {
    if (!storeUser) return;
    const u = storeUser;
    const r = await asUser(u, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.alertSubscriptions).values({
          organizationId: orgId,
          userId: u.id,
          kinds: ["machine_offline"],
          channels: ["email"],
        }),
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("en annan användare kan inte ta över en push-enhet (samma endpoint)", async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await asUser(owner, (tx) =>
      tx.insert(s.pushSubscriptions).values({
        organizationId: orgId,
        userId: owner.id,
        endpoint,
        p256dh: "x".repeat(40),
        authSecret: "y".repeat(16),
      }),
    );
    const r = await asUser(viewer, (tx) =>
      attempt(tx, (sp) =>
        sp
          .insert(s.pushSubscriptions)
          .values({
            organizationId: orgId,
            userId: viewer.id,
            endpoint,
            p256dh: "z".repeat(40),
            authSecret: "z".repeat(16),
          })
          .onConflictDoUpdate({
            target: [s.pushSubscriptions.organizationId, s.pushSubscriptions.endpoint],
            set: { p256dh: "z".repeat(40), authSecret: "z".repeat(16) },
          }),
      ),
    );
    expect(r.ok).toBe(false);
    const [row] = await rows<{ user_id: string; p256dh: string }>(
      db(),
      sql`select user_id, p256dh from public.push_subscriptions where endpoint = ${endpoint}`,
    );
    expect(row).toEqual({ user_id: owner.id, p256dh: "x".repeat(40) });
  });

  // SSRF: servern (larmjobbet och "Skicka provlarm") gör en POST till endpoint. Den måste
  // vara en känd push-tjänst, inte en godtycklig https-adress i det interna nätet.
  it("push-endpoint måste vara en känd push-tjänst (ingen SSRF mot interna adresser)", async () => {
    for (const endpoint of [
      "https://127.0.0.1:5432/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost:3200/api/cron/larm",
      "https://internal.example.com/hook",
    ]) {
      const r = await asUser(viewer, (tx) =>
        attempt(tx, (sp) =>
          sp.insert(s.pushSubscriptions).values({
            organizationId: orgId,
            userId: viewer.id,
            endpoint,
            p256dh: "x".repeat(40),
            authSecret: "y".repeat(16),
          }),
        ),
      );
      expect(r.ok, endpoint).toBe(false);
    }
  });

  it("utskick kan inte skrivas av användare", async () => {
    const r = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.alertDeliveries).values({
          organizationId: orgId,
          userId: owner.id,
          sendAt: new Date(),
          subject: "x",
          items: [],
          alertIds: [],
          results: [],
        }),
      ),
    );
    expect(r.ok).toBe(false);
  });
});

describe("utskick till den som inte längre får larmet", () => {
  const sent: { delivery: AlertDelivery; recipient: Recipient }[] = [];
  async function stub(delivery: AlertDelivery, recipient: Recipient): Promise<DispatchResult> {
    sent.push({ delivery, recipient });
    return {
      results: [{ channel: "email", status: "sent", detail: "test" }],
      goneDevices: [],
      okDevices: [],
      status: "sent",
    };
  }

  it("ett köat utskick skickas inte efter att användaren tagits bort ur organisationen", async () => {
    const leaver = await createMember(orgId, "admin");
    const at = new Date("2020-01-01T00:00:00Z");
    await asPostgres(async (tx) => {
      await tx.insert(s.alertDeliveries).values({
        organizationId: orgId,
        userId: leaver.id,
        sendAt: at,
        deferred: true,
        subject: "Importen misslyckades",
        items: [{ kind: "import_failed", title: "Importen misslyckades" }],
        alertIds: [importAlert],
        results: [],
      });
      await tx.execute(
        sql`delete from public.memberships where organization_id = ${orgId}::uuid and user_id = ${leaver.id}::uuid`,
      );
    });
    sent.length = 0;
    await deliverDue(db(), {
      now: new Date("2020-01-01T00:01:00Z"),
      baseUrl: "http://x",
      dispatch: stub,
    });
    expect(sent.filter((x) => x.recipient.userId === leaver.id)).toHaveLength(0);
  });

  it("ett köat importlarm skickas inte till den som blivit påfyllare", async () => {
    const demoted = await createMember(orgId, "admin");
    const at = new Date("2020-01-02T00:00:00Z");
    await asPostgres(async (tx) => {
      await tx.insert(s.alertDeliveries).values({
        organizationId: orgId,
        userId: demoted.id,
        sendAt: at,
        deferred: true,
        subject: "Importen misslyckades",
        items: [{ kind: "import_failed", title: "Importen misslyckades" }],
        alertIds: [importAlert],
        results: [],
      });
      await tx.execute(
        sql`update public.memberships set role = 'refiller' where organization_id = ${orgId}::uuid and user_id = ${demoted.id}::uuid`,
      );
    });
    sent.length = 0;
    await deliverDue(db(), {
      now: new Date("2020-01-02T00:01:00Z"),
      baseUrl: "http://x",
      dispatch: stub,
    });
    const mine = sent.filter((x) => x.recipient.userId === demoted.id);
    expect(mine.flatMap((x) => x.delivery.items.map((i) => i.kind))).not.toContain("import_failed");
  });
});

// ---------------------------------------------------------------------------
// Kundärenden
// ---------------------------------------------------------------------------

describe("kundärenden", () => {
  it("läsaren, påfyllaren och butiken kan inte skapa ärenden", async () => {
    for (const u of [viewer, refiller, ...(storeUser ? [storeUser] : [])]) {
      const r = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.insert(s.incidents).values({
            organizationId: orgId,
            machineId: m1,
            kind: "other",
            startedAt: new Date(),
          }),
        ),
      );
      expect(r.ok).toBe(false);
    }
  });

  it("butiken (portal) ser inga ärenden eller återbetalningar", async () => {
    if (!storeUser) return;
    const r = await asUser(storeUser, (tx) => tx.select().from(s.incidents));
    expect(r).toHaveLength(0);
  });

  it("ägaren kan inte koppla en order eller titel från en annan organisation", async () => {
    const r = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.incidents).values({
          organizationId: orgId,
          machineId: m1,
          kind: "other",
          startedAt: new Date(),
          titleId: otherTitle,
        }),
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("ansvarig kan inte vara en butiksanvändare (extern part)", async () => {
    if (!storeUser) return;
    const r = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.incidents).values({
          organizationId: orgId,
          machineId: m1,
          kind: "other",
          startedAt: new Date(),
          assigneeId: storeUser!.id,
        }),
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("en återbetalning i en stängd månad kan inte flyttas till en annan automat eller titel", async () => {
    const [inc] = await asUser(owner, (tx) =>
      tx
        .insert(s.incidents)
        .values({
          organizationId: orgId,
          machineId: m1,
          titleId: t1,
          kind: "not_delivered",
          startedAt: new Date("2026-03-10T10:00:00Z"),
          refundedOre: 4900,
          refundedOn: "2026-03-10",
        })
        .returning({ id: s.incidents.id }),
    );
    await asUser(owner, (tx) =>
      tx.execute(sql`select public.close_period(${orgId}::uuid, '2026-03-01'::date)`),
    );
    const moveMachine = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.incidents set machine_id = ${m2}::uuid where id = ${inc!.id}::uuid`,
        ),
      ),
    );
    const moveTitle = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.incidents set title_id = ${t2}::uuid where id = ${inc!.id}::uuid`,
        ),
      ),
    );
    expect({ machine: moveMachine.ok, title: moveTitle.ok }).toEqual({
      machine: false,
      title: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Påfyllning från fältet
// ---------------------------------------------------------------------------

describe("påfyllning från fältet", () => {
  it("påfyllaren kan inte registrera i en annan organisation", async () => {
    const r = await settle(
      asUser(refiller, (tx) =>
        tx.execute(
          sql`select * from public.register_refill_once(${otherOrg}::uuid, ${randomUUID()}::uuid, ${otherMachine}::uuid, ${otherTitle}::uuid, 1)`,
        ),
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("påfyllaren kan inte blanda in en automat från en annan organisation", async () => {
    const r = await settle(
      asUser(refiller, (tx) =>
        tx.execute(
          sql`select * from public.register_refill_once(${orgId}::uuid, ${randomUUID()}::uuid, ${otherMachine}::uuid, ${t1}::uuid, 1, false)`,
        ),
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("påfyllaren kan inte skriva field_submissions direkt eller se andras", async () => {
    const r = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.fieldSubmissions).values({
          organizationId: orgId,
          clientId: randomUUID(),
          machineId: m1,
          titleId: t1,
          quantity: 1,
          fromWarehouse: false,
          occurredAt: new Date(),
          stockEventId: randomUUID(),
        }),
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("ett klient-id som en annan påfyllare använt ger inte hennes lagerhändelse", async () => {
    const other = await createMember(orgId, "refiller");
    const clientId = randomUUID();
    await asUser(other, (tx) =>
      tx.execute(
        sql`select * from public.register_refill_once(${orgId}::uuid, ${clientId}::uuid, ${m1}::uuid, ${t1}::uuid, 1, false)`,
      ),
    );
    const r = await settle(
      asUser(refiller, (tx) =>
        tx.execute(
          sql`select * from public.register_refill_once(${orgId}::uuid, ${clientId}::uuid, ${m1}::uuid, ${t1}::uuid, 1, false)`,
        ),
      ),
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Härledning: data som inte importerats än är inte ett maskinfel
// ---------------------------------------------------------------------------

describe("misstänkt fel när försäljningen inte importerats än", () => {
  // Awish CSV laddas upp manuellt (en gång per dag). Fram till nästa uppladdning finns ingen
  // försäljning efter den senaste filen. Det är en eftersläpning i datat, inte en automat som
  // slutat sälja, och ska inte larma "misstänkt fel/ur drift" för alla automater.
  it("en dag utan uppladdad fil larmar inte alla automater som trasiga", async () => {
    const o = await createUser(`rt-lag-${uniqueSuffix()}@test.binderlab.se`);
    const org = await createOrg(o, `RT Eftersläp ${uniqueSuffix()}`);
    const now = new Date("2026-10-21T12:00:00Z"); // ons 14:00 svensk tid
    await asPostgres(async (tx) => {
      await tx.insert(s.machines).values([
        { organizationId: org, code: "LAG-1", name: "Lag Ett", activeFrom: "2026-08-01" },
        { organizationId: org, code: "LAG-2", name: "Lag Två", activeFrom: "2026-08-01" },
      ]);
      const [title] = await tx
        .insert(s.titles)
        .values({ organizationId: org, name: "Lagtitel" })
        .returning({ id: s.titles.id });
      const [src] = await tx
        .insert(s.dataSources)
        .values({ organizationId: org, provider: "awish_csv", name: "Awish CSV" })
        .returning({ id: s.dataSources.id });
      await tx.execute(sql`
        insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
        select ${org}::uuid, l.id, ${title!.id}::uuid, 'count', 5000, '2026-08-01T06:00:00Z'::timestamptz, 'Start'
        from public.stock_locations l where l.organization_id = ${org}::uuid and l.kind = 'machine'`);
      // Ett pack i timmen 08–21 varje dag t.o.m. tisdag 20 okt. kl. 21 (filen laddades upp då).
      await tx.execute(sql`
        insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                   ordered_at, amount_ore, machine_id, source_hash)
        select ${org}::uuid, ${src!.id}::uuid, m.code || '-' || to_char(g.local, 'YYYYMMDDHH24'),
               'Lagtitel', ${title!.id}::uuid, (g.local at time zone 'Europe/Stockholm'), 4900, m.id, 'rt'
        from public.machines m
        cross join generate_series('2026-08-25 08:10'::timestamp, '2026-10-20 21:10'::timestamp, interval '1 hour') g(local)
        where m.organization_id = ${org}::uuid and extract(hour from g.local) between 8 and 21`);
    });
    const summary = await evaluateOrganization(db(), org, now);
    expect(summary.status).toBe("ok");
    const machineAlerts = await rows<{ kind: string; title: string }>(
      db(),
      sql`select kind, title from public.alerts where organization_id = ${org}::uuid and alert_group = 'machine'`,
    );
    expect(machineAlerts).toEqual([]);
  });
});
