/**
 * En order som måste hanteras för hand ska stå kvar tills den är hanterad (robusthet 1B,
 * punkt 5), mot testdatabasen och låtsas-Awish:
 *
 * - En order som Awish återbetalar efter importen blir ett larm (order_attention) som syns
 *   i Att göra, inte bara en rad i importloggen. Det skapas en gång, står kvar över flera
 *   körningar och stängs när återbetalningen är införd på ett ärende i Inkorg.
 * - En betald order som inte går att läsa blir ett larm som stängs när ordern finns i
 *   försäljningen.
 * - Larmet skapas ur det synken ser i varje körning: tas det bort (eller gick det inte att
 *   spara första gången) kommer det tillbaka, fast ordern redan är loggad en gång.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { alertTodos } from "../../src/analytics/todos/alerts";
import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { resolveOrderAttention } from "../../src/server/awish/order-attention";
import { syncAwishSource } from "../../src/server/awish/sync";
import {
  fakeOrder,
  startFakeAwish,
  type FakeAwish,
} from "../../src/server/awish/testing/fake-server";
import { queryOpenAlerts } from "../../src/server/data/core/queries";
import type { Viewer } from "../../src/server/data/core/loaders";

import { asPostgres, asUser, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

let fake: FakeAwish;
let owner: TestUser;
let orgId: string;
let sourceId: string;
let machineId: string;

const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
  createAwishClient(creds, { address: fake.address, tls: false, sleep: async () => {} });

const T0 = Date.parse("2026-11-02T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const sync = async (minutes: number) => {
  const r = await syncAwishSource(
    { db: db(), connect, now: () => at(minutes) },
    { dataSourceId: sourceId },
  );
  expect(r.ok, r.message ?? "").toBe(true);
  return r;
};

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function attention() {
  return rows<{
    incident_key: string;
    status: string;
    title: string;
    message: string;
    link: string;
    occurrences: number;
  }>(
    db(),
    sql`select incident_key, status, title, message, link, occurrences from public.alerts
        where organization_id = ${orgId}::uuid and kind = 'order_attention'
        order by triggered_at, incident_key`,
  );
}

async function todoTitles(): Promise<string[]> {
  const alerts = await asUser(owner, (tx) => queryOpenAlerts(tx, orgId));
  return alertTodos({
    input: { alerts },
    nowMs: at(60).getTime(),
  } as unknown as Parameters<typeof alertTodos>[0]).map((t) => `${t.title} → ${t.link}`);
}

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [{ id: "2", name: "Centrum", machine_no: "163271xx", is_online: true }],
    orders: [fakeOrder(880460), fakeOrder(880461, { payTime: "2026-11-02 00:20:00" })],
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
  await sync(0);
  // Automaten kopplas, som ägaren gör på Datakällor, så att ordern hör till BL-001.
  await asPostgres(async (tx) => {
    await tx.execute(
      sql`update public.source_machines set machine_id = ${machineId}::uuid
          where organization_id = ${orgId}::uuid and machine_id is null`,
    );
    await tx.execute(
      sql`update public.orders set machine_id = ${machineId}::uuid
          where organization_id = ${orgId}::uuid and machine_id is null`,
    );
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("en order som återbetalas i Awish efter importen", () => {
  it("blir en punkt i Att göra, en gång, och står kvar över flera körningar", async () => {
    expect(await attention()).toEqual([]);
    fake.state.orders = fake.state.orders.map((o) =>
      o.id === "880460" ? { ...o, status: "PAY_REFUND" } : o,
    );
    await sync(5);
    await sync(10);
    await sync(15);
    const order = await one<{ id: string; amount_ore: number }>(
      db(),
      sql`select id, amount_ore from public.orders
          where organization_id = ${orgId}::uuid and external_id = '880460'`,
    );
    // Ordern ändras inte av synken: försäljningen ligger kvar tills ärendet är infört.
    expect(Number(order.amount_ore)).toBe(17000);
    const found = await attention();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      incident_key: `order_refund:${sourceId}:880460`,
      status: "open",
      title: "Order 880460 i BL-001 återbetalades i Awish",
      link: `/inkorg/nytt?order=${order.id}`,
    });
    expect(found[0]!.message).toBe(
      "Försäljningen på 170 kr ligger kvar i siffrorna och i butikens andel. För in återbetalningen på ett ärende i Inkorg, så dras den av.",
    );
    // Sedd i tre körningar, ett larm.
    expect(Number(found[0]!.occurrences)).toBe(3);
    expect(await todoTitles()).toEqual([
      `Order 880460 i BL-001 återbetalades i Awish → /inkorg/nytt?order=${order.id}`,
    ]);
  });

  it("kommer tillbaka om larmet stängdes utan att ordern är hanterad, fast den redan är loggad", async () => {
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.alerts set status = 'closed', closed_at = now()
            where organization_id = ${orgId}::uuid and kind = 'order_attention'`,
      ),
    );
    expect(await todoTitles()).toEqual([]);
    await sync(20);
    expect((await attention()).map((a) => a.status)).toEqual(["closed", "open"]);
    expect(await todoTitles()).toHaveLength(1);
  });

  it("stängs när återbetalningen är införd på ett ärende, och kommer inte tillbaka", async () => {
    const order = await one<{ id: string }>(
      db(),
      sql`select id from public.orders
          where organization_id = ${orgId}::uuid and external_id = '880460'`,
    );
    // Ett ärende utan återbetalt belopp räcker inte.
    await asUser(owner, (tx) =>
      tx.insert(s.incidents).values({
        organizationId: orgId,
        machineId,
        kind: "refund_request",
        startedAt: at(21),
        orderId: order.id,
        status: "open",
      }),
    );
    expect(await resolveOrderAttention(db(), orgId)).toBe(0);
    expect((await attention()).map((a) => a.status)).toEqual(["closed", "open"]);

    await asUser(owner, (tx) =>
      tx
        .update(s.incidents)
        .set({ refundedOre: 17000, refundedOn: "2026-11-02" })
        .where(sql`organization_id = ${orgId}::uuid and order_id = ${order.id}::uuid`),
    );
    // Som när ärendet sparas i Inkorg.
    expect(await resolveOrderAttention(db(), orgId)).toBe(1);
    expect((await attention()).map((a) => a.status)).toEqual(["closed", "closed"]);
    expect(await todoTitles()).toEqual([]);
    // Awish visar fortfarande ordern som återbetald: inget nytt larm.
    await sync(25);
    await sync(30);
    expect((await attention()).map((a) => a.status)).toEqual(["closed", "closed"]);
  });
});

describe("en betald order som inte går att läsa", () => {
  it("blir en punkt som står kvar, och stängs när ordern finns i försäljningen", async () => {
    fake.state.orders = [
      ...fake.state.orders,
      fakeOrder(880470, { payTime: "", date: "2026-11-02" }),
    ];
    await sync(35);
    await sync(40);
    const open = (await attention()).filter((a) => a.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      incident_key: `order_error:${sourceId}:880470`,
      title: "Order 880470 från Awish kunde inte läsas",
      link: "/datakallor",
    });
    expect(open[0]!.message).toContain(
      "Ordern är betald i Awish men finns inte i Binderlab, så den saknas i försäljningen och i butikens andel.",
    );
    expect(open[0]!.message).toContain("Betaltid (pay_time) saknas.");
    expect(await todoTitles()).toEqual(["Order 880470 från Awish kunde inte läsas → /datakallor"]);

    // Awish rättar ordern: den läses in, och punkten stängs.
    fake.state.orders = fake.state.orders.map((o) =>
      o.id === "880470" ? { ...o, payTime: "2026-11-02 00:30:00" } : o,
    );
    await sync(45);
    const stored = await rows(
      db(),
      sql`select 1 from public.orders
          where organization_id = ${orgId}::uuid and external_id = '880470'`,
    );
    expect(stored).toHaveLength(1);
    expect((await attention()).filter((a) => a.status === "open")).toEqual([]);
  });
});
