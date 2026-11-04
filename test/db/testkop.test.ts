/**
 * Testköp (20261105070000_testkop.sql, Order → "Markera som testköp") mot testdatabasen:
 *
 * - en markerad order räknas inte i intäkt och vinst (laddarna bakom Hem, Lönsamhet,
 *   Automater, Butiker och AI-assistenten), butikens andel och avräkning, bokföringen,
 *   rapportunderlaget, "saknar inköpspris", butiksportalen eller månadsstängningen,
 * - den står kvar i Order med etiketten (raden och detaljvyn), men inte i antal och summa,
 * - ångra ger tillbaka allt,
 * - vem och när loggas i audit_log; bara ägare och admin får markera, aldrig i en stängd
 *   månad (BL004), och ingen klient kan skriva kolumnen direkt.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { parseOrderParams } from "@/app/(app)/order/_lib/params";
import {
  loadOrderDetailFor,
  loadOrderListFor,
  setTestPurchaseFor,
  TestPurchaseError,
  type OrderListArgs,
} from "@/app/(app)/order/_lib/service";
import { profitability } from "@/domain";
import { AuthorizationError, listOrganizationsFor, type SessionUser } from "@/server/access";
import { loadBokforingFor } from "@/server/bokforing/service";
import { loadDomainInputFor, loadTodosFor, type Viewer } from "@/server/data/core/loaders";
import { queryPortalSales } from "@/server/portal/queries";
import { buildSnapshot } from "@/server/reports/snapshot";
import { loadSnapshotInput } from "@/server/reports/sources";
import { ensureSettlementsFor, recomputeSettlementFor } from "@/server/settlements/service";

import { asPostgres, asUser, attempt, createMember, one, rows, type TestUser } from "./helpers";
import { inviteStoreUser, seedPortalTenant, type PortalTenant } from "./portal-fixture";

const MARCH = { start: "2025-03-01", end: "2025-03-31" };
const APRIL = new Date("2025-04-02T08:00:00Z");
const NO_SCOPE = { storeId: null, machineId: null };

let a: PortalTenant;
let b: PortalTenant;
let ownerA: Viewer;
let adminA: Viewer;
let viewerA: Viewer;
let refillerA: Viewer;
let ownerB: Viewer;
let storeA: TestUser;
let viewerUser: TestUser;
let refillerUser: TestUser;
/** 42001 (79 kr) och 42002 (89 kr) i mars 2025; 42003 (99 kr) har en titel utan pris. */
let orderIds: Record<string, string>;
let unpricedTitleId: string;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function rejects(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

function listArgs(): OrderListArgs {
  return { period: MARCH, compare: null, scope: NO_SCOPE, params: parseOrderParams({}) };
}

/** Allt som ska påverkas av ett testköp, i en ögonblicksbild. */
async function numbers() {
  const input = await loadDomainInputFor(ownerA, { period: MARCH }, APRIL);
  const totals = profitability(input.current, "store").totals;
  const accountant = await asPostgres(async (tx) =>
    buildSnapshot(
      await loadSnapshotInput(tx, {
        organizationId: a.orgId,
        type: "bokforing",
        month: "2025-03",
        now: APRIL.toISOString(),
      }),
    ),
  );
  if (accountant.type !== "bokforing") throw new Error("fel typ");
  const share = accountant.report.stores.find((x) => x.storeId === a.storeId)!;
  const book = (await loadBokforingFor(ownerA, "2025-04-15")).months.find(
    (m) => m.month === "2025-03",
  )!.book;
  const list = await loadOrderListFor(ownerA, listArgs(), APRIL);
  const todos = await loadTodosFor(ownerA, APRIL);
  const portal = await asUser(storeA, (tx) =>
    queryPortalSales(tx, a.storeId, { start: MARCH.start, end: MARCH.end }),
  );
  return {
    orderIds: input.current.orders.map((o) => o.externalId).sort(),
    grossOre: totals.grossOre,
    revenueOre: totals.revenueOre,
    profitOre: totals.profitOre,
    commissionOre: totals.commissionOre,
    unpricedOrders: totals.unpricedOrders,
    storeOrders: share.orders,
    storeGrossOre: share.grossOre,
    compensationOre: share.compensationOre,
    bookSalesInclVatOre: book.salesInclVatOre,
    listCount: list.totals.count,
    listAmountOre: list.totals.amountOre,
    listRows: list.rows.map((r) => [r.externalId, r.testPurchase] as const).sort(),
    missingPrice: todos.some((t) => t.key === `missing-price:${unpricedTitleId}`),
    portalOre: portal.reduce((sum, r) => sum + r.amountOre * r.orderCount, 0),
  };
}

beforeAll(async () => {
  a = await seedPortalTenant("ICA Testköp");
  b = await seedPortalTenant("Coop Testköp");
  ownerA = await viewerFor(a.owner, a.orgId);
  ownerB = await viewerFor(b.owner, b.orgId);
  adminA = await viewerFor(await createMember(a.orgId, "admin"), a.orgId);
  viewerUser = await createMember(a.orgId, "viewer");
  refillerUser = await createMember(a.orgId, "refiller");
  viewerA = await viewerFor(viewerUser, a.orgId);
  refillerA = await viewerFor(refillerUser, a.orgId);
  storeA = await inviteStoreUser(a.owner, a.orgId, a.storeId);
  await asPostgres(async (tx) => {
    const title = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name)
          values (${a.orgId}, 'Prismatic Evolutions Booster') returning id`,
    );
    unpricedTitleId = title.id;
    await tx.execute(
      sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                     ordered_at, amount_ore, machine_id, source_hash)
          values (${a.orgId}, ${a.dataSourceId}, '42003', 'Prismatic', ${title.id},
                  '2025-03-12T10:00:00Z', 9900, ${a.machineId}, 'h3')`,
    );
  });
  const ids = await asPostgres((tx) =>
    rows<{ id: string; external_id: string }>(
      tx,
      sql`select id, external_id from public.orders where organization_id = ${a.orgId}`,
    ),
  );
  orderIds = Object.fromEntries(ids.map((r) => [r.external_id, r.id]));
});

describe("ett testköp räknas inte, och ångra ger tillbaka det", () => {
  let before: Awaited<ReturnType<typeof numbers>>;

  it("utan testköp räknas alla tre order", async () => {
    before = await numbers();
    expect(before.orderIds).toEqual(["42001", "42002", "42003"]);
    expect(before.listCount).toBe(3);
    expect(before.listAmountOre).toBe(7900 + 8900 + 9900);
    expect(before.storeOrders).toBe(3);
    expect(before.bookSalesInclVatOre).toBe(7900 + 8900 + 9900);
    expect(before.unpricedOrders).toBe(1);
    expect(before.missingPrice).toBe(true);
    expect(before.portalOre).toBe(7900 + 8900 + 9900);
    expect(before.profitOre).toBeGreaterThan(0);
  });

  it("markerade order försvinner ur intäkt, vinst, andel, bokföring, portal och att göra", async () => {
    const res = await setTestPurchaseFor(ownerA, orderIds["42002"]!, true);
    expect(res.testPurchaseAt).not.toBeNull();
    await setTestPurchaseFor(adminA, orderIds["42003"]!, true);

    const after = await numbers();
    expect(after.orderIds).toEqual(["42001"]);
    expect(after.grossOre).toBe(7900);
    expect(after.revenueOre).toBeLessThan(before.revenueOre);
    expect(after.profitOre).toBeLessThan(before.profitOre);
    expect(after.commissionOre).toBeLessThan(before.commissionOre);
    expect(after.unpricedOrders).toBe(0);
    expect(after.storeOrders).toBe(1);
    expect(after.storeGrossOre).toBe(7900);
    expect(after.compensationOre).toBeLessThan(before.compensationOre);
    expect(after.bookSalesInclVatOre).toBe(7900);
    expect(after.missingPrice).toBe(false);
    expect(after.portalOre).toBe(7900);
    // Order: raderna står kvar med etiketten, men räknas inte i antal och summa.
    expect(after.listCount).toBe(1);
    expect(after.listAmountOre).toBe(7900);
    expect(after.listRows).toEqual([
      ["42001", false],
      ["42002", true],
      ["42003", true],
    ]);
  });

  it("avräkningen räknar inte testköpet och räknas om efter ångra", async () => {
    const run = await ensureSettlementsFor(ownerA, APRIL);
    expect(run).toMatchObject({ month: "2025-03", created: 1, errors: [] });
    const settlement = await asPostgres((tx) =>
      one<{ id: string; amount_ore: string }>(
        tx,
        sql`select id, amount_ore from public.store_settlements where organization_id = ${a.orgId}`,
      ),
    );
    const marked = await numbers();
    expect(Number(settlement.amount_ore)).toBe(marked.compensationOre);

    await setTestPurchaseFor(ownerA, orderIds["42002"]!, false);
    await setTestPurchaseFor(ownerA, orderIds["42003"]!, false);
    const recomputed = await recomputeSettlementFor(ownerA, settlement.id, APRIL);
    expect(recomputed.amountOre).toBe(before.compensationOre);
    expect(recomputed.previousOre).toBe(marked.compensationOre);
  });

  it("efter ångra är allt som före markeringen", async () => {
    expect(await numbers()).toEqual(before);
  });
});

describe("Order och loggen", () => {
  it("detaljvyn visar när och av vem; loggen har båda ändringarna", async () => {
    const id = orderIds["42001"]!;
    await setTestPurchaseFor(ownerA, id, true);
    // Samma värde igen ändrar inget och loggar inget.
    const first = await setTestPurchaseFor(ownerA, id, true);
    const again = await setTestPurchaseFor(adminA, id, true);
    expect(again.testPurchaseAt).toBe(first.testPurchaseAt);

    const detail = await loadOrderDetailFor(viewerA, id);
    expect(detail?.testPurchase?.at).toBe(first.testPurchaseAt);
    expect(detail?.testPurchase?.by).toBeTruthy();

    await setTestPurchaseFor(adminA, id, false);
    expect((await loadOrderDetailFor(ownerA, id))?.testPurchase).toBeNull();

    const log = await asPostgres((tx) =>
      rows<{ actor_id: string; before: string | null; after: string | null }>(
        tx,
        sql`select actor_id, before ->> 'test_purchase_at' as before,
                   after ->> 'test_purchase_at' as after
            from public.audit_log
            where organization_id = ${a.orgId} and table_name = 'orders' and row_id = ${id}
            order by occurred_at, id`,
      ),
    );
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ actor_id: a.owner.id, before: null });
    expect(log[0]!.after).not.toBeNull();
    expect(log[1]).toMatchObject({ actor_id: adminA.user.userId, after: null });
  });
});

describe("behörighet", () => {
  it("läsaren och påfyllaren får inte markera", async () => {
    const id = orderIds["42001"]!;
    expect(await rejects(setTestPurchaseFor(viewerA, id, true))).toBeInstanceOf(AuthorizationError);
    expect(await rejects(setTestPurchaseFor(refillerA, id, true))).toBeInstanceOf(
      AuthorizationError,
    );
    for (const u of [viewerUser, refillerUser]) {
      const out = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`select public.set_test_purchase(${a.orgId}::uuid, ${id}::uuid, true)`),
        ),
      );
      expect(out).toMatchObject({ ok: false, code: "42501" });
    }
  });

  it("en annan organisation når inte ordern", async () => {
    const id = orderIds["42001"]!;
    const err = await rejects(setTestPurchaseFor(ownerB, id, true));
    expect(err).toBeInstanceOf(TestPurchaseError);
    const direct = await asUser(b.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select public.set_test_purchase(${a.orgId}::uuid, ${id}::uuid, true)`),
      ),
    );
    expect(direct).toMatchObject({ ok: false, code: "42501" });
    const { at } = await asPostgres((tx) =>
      one<{ at: Date | null }>(
        tx,
        sql`select test_purchase_at as at from public.orders where id = ${id}`,
      ),
    );
    expect(at).toBeNull();
  });

  it("ingen klient skriver kolumnen direkt, inte ens ägaren", async () => {
    const id = orderIds["42001"]!;
    const out = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.orders set test_purchase_at = now() where id = ${id}`),
      ),
    );
    expect(out).toMatchObject({ ok: false, code: "42501" });
  });

  it("tiden sätts av databasen, och belopp och tid på ordern kan fortfarande inte ändras", async () => {
    const id = orderIds["42001"]!;
    await asPostgres((tx) =>
      tx.execute(sql`update public.orders set test_purchase_at = '2000-01-01' where id = ${id}`),
    );
    const { recent } = await asPostgres((tx) =>
      one<{ recent: boolean }>(
        tx,
        sql`select test_purchase_at > now() - interval '1 minute' as recent
            from public.orders where id = ${id}`,
      ),
    );
    expect(recent).toBe(true);
    const amount = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.orders set test_purchase_at = null, amount_ore = 1 where id = ${id}`,
        ),
      ),
    );
    expect(amount).toMatchObject({ ok: false, code: "BL007" });
    await setTestPurchaseFor(ownerA, id, false);
  });
});

describe("stängd månad", () => {
  it("stängningens sammanfattning räknar inte testköp, och en stängd månad ändras inte", async () => {
    await setTestPurchaseFor(ownerA, orderIds["42002"]!, true);
    await asUser(a.owner, (tx) =>
      tx.execute(sql`select public.close_period(${a.orgId}::uuid, '2025-03-01'::date)`),
    );
    const { summary } = await asPostgres((tx) =>
      one<{ summary: { order_count: number; revenue_ore: number } }>(
        tx,
        sql`select snapshot -> 'database' as summary from public.period_closes
            where organization_id = ${a.orgId} and month = '2025-03-01' and reopened_at is null`,
      ),
    );
    expect(summary).toMatchObject({ order_count: 2, revenue_ore: 7900 + 9900 });

    const err = await rejects(setTestPurchaseFor(ownerA, orderIds["42002"]!, false));
    expect(err).toBeInstanceOf(TestPurchaseError);
    expect((err as Error).message).toMatch(/stängd/);

    await asUser(a.owner, (tx) =>
      tx.execute(sql`select public.reopen_period(${a.orgId}::uuid, '2025-03-01'::date)`),
    );
    expect((await setTestPurchaseFor(ownerA, orderIds["42002"]!, false)).testPurchaseAt).toBeNull();
  });
});
