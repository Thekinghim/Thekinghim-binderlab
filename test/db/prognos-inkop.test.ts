/**
 * Prognos & inköp (src/server/purchasing) mot testdatabasen: förlorad försäljning ur
 * lagret, prognosen, inköpsförslaget, leverantörer och artiklar, inköpsorder och
 * mottagning (lagerhändelse 'receipt' i centrallagret), behörighet och isolering.
 */

import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { addDays } from "@/domain";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import {
  cancelPurchaseOrderFor,
  closePurchaseOrderFor,
  createPurchaseOrderFor,
  createSupplierFor,
  deleteSupplierItemFor,
  loadPrognosFor,
  lostSalesSummaryFor,
  markPurchaseOrderOrderedFor,
  PurchasingError,
  receivePurchaseOrderFor,
  saveSupplierItemFor,
  setSupplierArchivedFor,
  updateSupplierFor,
} from "@/server/purchasing";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-06-02T08:00:00Z");
const TODAY = "2025-06-02";
const MAY = { start: "2025-05-01", end: "2025-05-31" };

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

interface Seed {
  orgId: string;
  owner: TestUser;
  machineId: string;
  machineLocationId: string;
  centralLocationId: string;
  titleId: string;
  secondTitleId: string;
}

let fx: Seed;
let owner: Viewer;
let reader: Viewer;
let refiller: Viewer;
let otherOwner: Viewer;
let supplierId: string;

/**
 * En organisation med en automat i en butik, två titlar med inköpspris och en leverantör
 * (box 36, ledtid 7 dagar). Titel 1 i automaten: inventering 200 st 1 april, 2 pack/dag
 * 1 april–10 maj, slutsåld 11–19 maj (inventering 0 på kvällen 10 maj), påfylld 20 maj,
 * sedan 2 pack/dag (30 påfyllda, 4 kvar). Ordertriggern skriver försäljningen i lagret.
 */
async function seed(): Promise<Seed> {
  const user = await createUser(`prognos-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(user, `Prognos ${uniqueSuffix()}`);
  return asUser(user, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Testbutik" })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [title, second] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151 Booster" },
        { ...org, name: "Surging Sparks Booster" },
      ])
      .returning();
    await tx.insert(s.purchasePrices).values([
      { ...org, titleId: title!.id, unitCostOre: 4_500, validFrom: "2025-01-01" },
      { ...org, titleId: second!.id, unitCostOre: 5_200, validFrom: "2025-01-01" },
    ]);
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [sourceMachine] = await tx
      .insert(s.sourceMachines)
      .values({ ...org, dataSourceId: source!.id, externalId: "AW-1", machineId: machine!.id })
      .returning();
    const [imp] = await tx
      .insert(s.imports)
      .values({
        ...org,
        dataSourceId: source!.id,
        trigger: "upload",
        fileName: "orders.csv",
        fileSha256: "b".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        status: "succeeded",
      })
      .returning();
    const locations = await tx
      .select()
      .from(s.stockLocations)
      .where(eq(s.stockLocations.organizationId, orgId));
    const central = locations.find((l) => l.isCentral)!;
    const machineLocation = locations.find((l) => l.machineId === machine!.id)!;

    await tx.insert(s.stockEvents).values({
      ...org,
      locationId: machineLocation.id,
      titleId: title!.id,
      kind: "count",
      quantity: 200,
      occurredAt: new Date("2025-04-01T06:00:00Z"),
    });
    const values: (typeof s.orders.$inferInsert)[] = [];
    let n = 0;
    for (let d = "2025-04-01"; d <= "2025-06-01"; d = addDays(d, 1)) {
      if (d >= "2025-05-11" && d <= "2025-05-19") continue;
      for (let k = 0; k < 2; k++) {
        n += 1;
        values.push({
          ...org,
          dataSourceId: source!.id,
          externalId: `P${n}`,
          rawTitle: "Pokemon 151",
          titleId: title!.id,
          orderedAt: new Date(`${d}T${k === 0 ? "10" : "14"}:00:00Z`),
          amountOre: 7_900,
          paymentMethod: "card",
          sourceMachineId: sourceMachine!.id,
          machineId: machine!.id,
          importId: imp!.id,
          sourceHash: `p${n}`,
        });
      }
    }
    for (let i = 0; i < values.length; i += 200) {
      await tx.insert(s.orders).values(values.slice(i, i + 200));
    }
    await tx.insert(s.stockEvents).values([
      {
        ...org,
        locationId: machineLocation.id,
        titleId: title!.id,
        kind: "count",
        quantity: 0,
        occurredAt: new Date("2025-05-10T20:00:00Z"),
      },
      {
        ...org,
        locationId: machineLocation.id,
        titleId: title!.id,
        kind: "refill",
        quantity: 30,
        occurredAt: new Date("2025-05-20T05:00:00Z"),
      },
    ]);
    const [supplier] = await tx
      .insert(s.suppliers)
      .values({ ...org, name: "Kortgrossisten AB", defaultLeadTimeDays: 7 })
      .returning();
    await tx.insert(s.supplierItems).values({
      ...org,
      supplierId: supplier!.id,
      titleId: title!.id,
      packSize: 36,
      minOrderQty: 1,
      unitCostOre: 4_300,
    });
    supplierId = supplier!.id;
    return {
      orgId,
      owner: user,
      machineId: machine!.id,
      machineLocationId: machineLocation.id,
      centralLocationId: central.id,
      titleId: title!.id,
      secondTitleId: second!.id,
    };
  });
}

beforeAll(async () => {
  const other = await seed();
  otherOwner = await viewerFor(other.owner, other.orgId);
  fx = await seed();
  owner = await viewerFor(fx.owner, fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
});

describe("loadPrognosFor", () => {
  it("räknar förlorad försäljning ur lagret för perioden", async () => {
    const data = await loadPrognosFor(owner, { period: MAY }, NOW);
    expect(data.today).toBe(TODAY);
    expect(data.asOf).toBe("2025-06-01");
    const p = data.lostSales.periods.find(
      (x) => x.titleId === fx.titleId && x.machineId === fx.machineId,
    );
    expect(p).toBeDefined();
    expect(p!.source).toBe("stock");
    expect(p!.start).toBe("2025-05-11");
    expect(p!.ongoing).toBe(false);
    // 9 hela dagar + påfyllningsdagen som en halv dag, 2 pack/dag à 79 kr.
    expect(p!.lostDayWeightBp).toBe(95_000);
    expect(p!.rate.perDayMilli).toBe(2_000);
    expect(p!.lostRevenueOre).toBe(19 * 7_900);
    expect(p!.lostGrossProfitOre).toBe(19 * (7_900 - 4_500));
    expect(data.lostSales.total.text).toMatch(/^Slutsålt kostade ca\s1\s500\skr/);
  });

  it("gör prognosen utan att räkna slutsålda dagar som efterfrågan 0", async () => {
    const data = await loadPrognosFor(owner, { period: MAY }, NOW);
    const series = data.forecast.series.find((x) => x.titleId === fx.titleId);
    expect(series).toBeDefined();
    expect(series!.components.excludedDays).toBeGreaterThanOrEqual(9);
    // 2 pack/dag i 28 dagar.
    expect(series!.total.unitsMilli).toBeGreaterThan(50_000);
    expect(series!.total.unitsMilli).toBeLessThan(62_000);
    expect(data.forecast.horizon.start).toBe(TODAY);
    expect(data.history).toHaveLength(8);
    expect(data.history.at(-1)!.period.end).toBe("2025-06-01");
    expect(data.forecast.accuracy.total.wapeBp).not.toBeNull();
  });

  it("föreslår inköp i hela boxar från leverantören", async () => {
    const data = await loadPrognosFor(owner, { period: MAY }, NOW);
    const line = data.plan.lines.find((l) => l.titleId === fx.titleId)!;
    expect(line.supplierId).toBe(supplierId);
    expect(line.packSize).toBe(36);
    expect(line.leadTimeDays).toBe(7);
    expect(line.status).toBe("order");
    expect(line.orderQty % 36).toBe(0);
    expect(data.plan.orders[0]?.supplierId).toBe(supplierId);
    expect(data.valuation.titles.find((t) => t.titleId === fx.titleId)?.unitCostOre).toBe(4_500);
  });

  it("låter läsaren se men inte ändra, och stoppar påfyllaren", async () => {
    const data = await loadPrognosFor(reader, { period: MAY }, NOW);
    expect(data.canEdit).toBe(false);
    await expect(loadPrognosFor(refiller, { period: MAY }, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(lostSalesSummaryFor(refiller, MAY, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      createSupplierFor(reader, {
        name: "X",
        contactName: null,
        email: null,
        phone: null,
        defaultLeadTimeDays: null,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("filtrerar förlorad försäljning på automaten", async () => {
    const data = await loadPrognosFor(
      owner,
      { period: MAY, scope: { storeId: null, machineId: fx.orgId } },
      NOW,
    );
    expect(data.lostSales.periods).toHaveLength(0);
    expect(data.forecast.series).toHaveLength(0);
    // Inköpen gäller hela organisationen.
    expect(data.plan.lines.some((l) => l.titleId === fx.titleId)).toBe(true);
  });
});

describe("lostSalesSummaryFor", () => {
  it("ger Hem en mening per månad och Att göra en kostnad per påfyllningsnyckel", async () => {
    const sum = await lostSalesSummaryFor(owner, MAY, NOW);
    expect(sum.text).toBe("Slutsålt kostade ca\u00a01\u00a0500\u00a0kr i maj.");
    expect(sum.lostRevenueOre).toBe(19 * 7_900);
    expect(sum.series[0]).toMatchObject({
      key: `refill:${fx.machineId}:${fx.titleId}`,
      lostRevenueOre: 19 * 7_900,
      ongoing: false,
      since: "2025-05-11",
    });
    expect(sum.href).toBe("/prognos?from=2025-05-01&to=2025-05-31#forlorad-forsaljning");
  });

  it("filtrerar på automaten och länkar med samma filter", async () => {
    const mine = await lostSalesSummaryFor(owner, MAY, NOW, {
      storeId: null,
      machineId: fx.machineId,
    });
    expect(mine.lostRevenueOre).toBe(19 * 7_900);
    expect(mine.href).toBe(
      `/prognos?from=2025-05-01&to=2025-05-31&automat=${fx.machineId}#forlorad-forsaljning`,
    );
    const other = await lostSalesSummaryFor(owner, MAY, NOW, {
      storeId: null,
      machineId: fx.orgId,
    });
    expect(other.lostRevenueOre).toBe(0);
    expect(other.series).toHaveLength(0);
  });

  it("räknar inte i dag (perioden slutar i går)", async () => {
    const sum = await lostSalesSummaryFor(owner, { start: "2025-06-01", end: "2025-06-30" }, NOW);
    expect(sum.period).toEqual({ start: "2025-06-01", end: "2025-06-01" });
    expect(sum.lostRevenueOre).toBe(0);
  });
});

describe("leverantörer och artiklar", () => {
  it("skapar, ändrar, arkiverar och hanterar artiklar", async () => {
    const id = await createSupplierFor(owner, {
      name: "Nordic Cards",
      contactName: "Eva",
      email: "eva@nordic.example",
      phone: null,
      defaultLeadTimeDays: 3,
    });
    await updateSupplierFor(owner, {
      id,
      name: "Nordic Cards AB",
      contactName: "Eva",
      email: null,
      phone: "08-123",
      defaultLeadTimeDays: 4,
    });
    const itemId = await saveSupplierItemFor(owner, {
      supplierId: id,
      titleId: fx.secondTitleId,
      packSize: 24,
      minOrderQty: 24,
      leadTimeDays: null,
      unitCostOre: 5_000,
    });
    await expect(
      saveSupplierItemFor(owner, {
        supplierId: id,
        titleId: fx.secondTitleId,
        packSize: 12,
        minOrderQty: 12,
        leadTimeDays: null,
        unitCostOre: 5_100,
      }),
    ).rejects.toThrow(/finns redan hos leverantören/);
    await saveSupplierItemFor(owner, {
      id: itemId,
      supplierId: id,
      titleId: fx.secondTitleId,
      packSize: 12,
      minOrderQty: 12,
      leadTimeDays: 2,
      unitCostOre: 4_900,
    });
    let data = await loadPrognosFor(owner, { period: MAY }, NOW);
    const sup = data.suppliers.find((x) => x.id === id)!;
    expect(sup).toMatchObject({ name: "Nordic Cards AB", phone: "08-123", defaultLeadTimeDays: 4 });
    expect(data.supplierItems.find((i) => i.id === itemId)).toMatchObject({
      packSize: 12,
      leadTimeDays: 2,
      unitCostOre: 4_900,
    });

    await deleteSupplierItemFor(owner, { id: itemId });
    await setSupplierArchivedFor(owner, { id, archived: true });
    data = await loadPrognosFor(owner, { period: MAY }, NOW);
    expect(data.supplierItems.some((i) => i.id === itemId)).toBe(false);
    expect(data.suppliers.find((x) => x.id === id)?.archived).toBe(true);
    await expect(
      createPurchaseOrderFor(owner, {
        supplierId: id,
        status: "ordered",
        expectedOn: null,
        note: null,
        lines: [{ titleId: fx.titleId, quantity: 1, unitCostOre: 1 }],
      }),
    ).rejects.toThrow(/arkiverad/);
  });
});

describe("inköpsorder och mottagning", () => {
  it("skapar en order från förslaget, räknar den som beställd och tar emot i två steg", async () => {
    const before = await loadPrognosFor(owner, { period: MAY }, NOW);
    const line = before.plan.lines.find((l) => l.titleId === fx.titleId)!;
    const qty = line.orderQty;
    expect(qty).toBeGreaterThan(0);

    const poId = await createPurchaseOrderFor(
      owner,
      {
        supplierId,
        status: "ordered",
        expectedOn: null,
        note: "Från förslaget",
        lines: [{ titleId: fx.titleId, quantity: qty, unitCostOre: 4_300 }],
      },
      NOW,
    );
    const after = await loadPrognosFor(owner, { period: MAY }, NOW);
    const po = after.purchaseOrders.find((p) => p.id === poId)!;
    expect(po).toMatchObject({ status: "ordered", orderedOn: TODAY, expectedOn: "2025-06-09" });
    const afterLine = after.plan.lines.find((l) => l.titleId === fx.titleId)!;
    expect(afterLine.onOrderCounted).toBeGreaterThanOrEqual(qty);
    expect(afterLine.status).toBe("ok");
    expect(after.valuation.onOrderValueOre).toBe(qty * 4_300);

    const centralBefore = await centralOnHand(fx.titleId);
    const lineId = po.lines[0]!.id;
    const first = await receivePurchaseOrderFor(
      owner,
      { id: poId, lines: [{ lineId, quantity: 10 }] },
      NOW,
    );
    expect(first).toEqual({ status: "partially_received", received: 10 });
    expect(await centralOnHand(fx.titleId)).toBe(centralBefore + 10);
    const receipts = await asUser(fx.owner, (tx) =>
      rows<{ quantity: number; kind: string; business_date: string }>(
        tx,
        sql`select e.quantity, e.kind::text as kind, e.business_date::text as business_date
            from public.stock_events e
            where e.organization_id = ${fx.orgId}::uuid and e.location_id = ${fx.centralLocationId}::uuid
              and e.kind = 'receipt' and e.quantity = 10`,
      ),
    );
    expect(receipts).toHaveLength(1);

    await expect(
      receivePurchaseOrderFor(owner, { id: poId, lines: [{ lineId, quantity: qty }] }, NOW),
    ).rejects.toThrow(/Högst/);
    await expect(cancelPurchaseOrderFor(owner, { id: poId })).rejects.toBeInstanceOf(
      PurchasingError,
    );

    const second = await receivePurchaseOrderFor(
      owner,
      { id: poId, lines: [{ lineId, quantity: qty - 10 }] },
      NOW,
    );
    expect(second).toEqual({ status: "received", received: qty - 10 });
    expect(await centralOnHand(fx.titleId)).toBe(centralBefore + qty);
    const [head] = await asUser(fx.owner, (tx) =>
      tx
        .select({ status: s.purchaseOrders.status, receivedOn: s.purchaseOrders.receivedOn })
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, poId)),
    );
    expect(head).toEqual({ status: "received", receivedOn: TODAY });
    await expect(
      receivePurchaseOrderFor(owner, { id: poId, lines: [{ lineId, quantity: 1 }] }, NOW),
    ).rejects.toThrow(/redan mottagen/);
  });

  it("utkast måste beställas innan mottagning och kan avbrytas", async () => {
    const draftId = await createPurchaseOrderFor(
      owner,
      {
        supplierId,
        status: "draft",
        expectedOn: null,
        note: null,
        lines: [{ titleId: fx.titleId, quantity: 36, unitCostOre: 4_300 }],
      },
      NOW,
    );
    const data = await loadPrognosFor(owner, { period: MAY }, NOW);
    const draft = data.purchaseOrders.find((p) => p.id === draftId)!;
    expect(draft).toMatchObject({ status: "draft", orderedOn: null, expectedOn: null });
    await expect(
      receivePurchaseOrderFor(
        owner,
        { id: draftId, lines: [{ lineId: draft.lines[0]!.id, quantity: 1 }] },
        NOW,
      ),
    ).rejects.toThrow(/beställd/);
    await expect(
      markPurchaseOrderOrderedFor(owner, { id: draftId, expectedOn: "2025-05-01" }, NOW),
    ).rejects.toThrow(/före i dag/);
    await markPurchaseOrderOrderedFor(owner, { id: draftId, expectedOn: "2025-06-20" }, NOW);
    await cancelPurchaseOrderFor(owner, { id: draftId });
    const [head] = await asUser(fx.owner, (tx) =>
      tx
        .select({ status: s.purchaseOrders.status, orderedOn: s.purchaseOrders.orderedOn })
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, draftId)),
    );
    expect(head).toEqual({ status: "cancelled", orderedOn: TODAY });
  });

  it("isolerar organisationerna och stoppar läsaren", async () => {
    const poId = await createPurchaseOrderFor(
      owner,
      {
        supplierId,
        status: "ordered",
        expectedOn: null,
        note: null,
        lines: [{ titleId: fx.titleId, quantity: 36, unitCostOre: 4_300 }],
      },
      NOW,
    );
    const theirs = await loadPrognosFor(otherOwner, { period: MAY }, NOW);
    expect(theirs.purchaseOrders.some((p) => p.id === poId)).toBe(false);
    expect(theirs.suppliers.some((x) => x.id === supplierId)).toBe(false);
    await expect(cancelPurchaseOrderFor(otherOwner, { id: poId })).rejects.toThrow(/finns inte/);
    await expect(
      createPurchaseOrderFor(otherOwner, {
        supplierId,
        status: "ordered",
        expectedOn: null,
        note: null,
        lines: [{ titleId: fx.titleId, quantity: 1, unitCostOre: 1 }],
      }),
    ).rejects.toThrow(/finns inte/);
    await expect(cancelPurchaseOrderFor(reader, { id: poId })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("regler för inköpsorder", () => {
  const base = { supplierId: "", status: "ordered" as const, expectedOn: null, note: null };

  it("kräver artikel hos leverantören, minsta order och hela boxar", async () => {
    await expect(
      createPurchaseOrderFor(
        owner,
        {
          ...base,
          supplierId,
          lines: [{ titleId: fx.secondTitleId, quantity: 36, unitCostOre: 4_300 }],
        },
        NOW,
      ),
    ).rejects.toThrow(/finns inte hos leverantören/);
    await expect(
      createPurchaseOrderFor(
        owner,
        { ...base, supplierId, lines: [{ titleId: fx.titleId, quantity: 40, unitCostOre: 4_300 }] },
        NOW,
      ),
    ).rejects.toThrow(/hela boxar om 36/);
    const itemId = await saveSupplierItemFor(owner, {
      supplierId,
      titleId: fx.secondTitleId,
      packSize: 12,
      minOrderQty: 24,
      leadTimeDays: null,
      unitCostOre: 3_900,
    });
    await expect(
      createPurchaseOrderFor(
        owner,
        {
          ...base,
          supplierId,
          lines: [{ titleId: fx.secondTitleId, quantity: 12, unitCostOre: 3_900 }],
        },
        NOW,
      ),
    ).rejects.toThrow(/minsta order är 24/);
    await deleteSupplierItemFor(owner, { id: itemId });
  });

  it("räknar inte utkast som beställt: förslaget står kvar", async () => {
    const before = await loadPrognosFor(owner, { period: MAY }, NOW);
    const line = before.plan.lines.find((l) => l.titleId === fx.titleId)!;
    const draftId = await createPurchaseOrderFor(
      owner,
      {
        ...base,
        supplierId,
        status: "draft",
        lines: [{ titleId: fx.titleId, quantity: 72, unitCostOre: 4_300 }],
      },
      NOW,
    );
    const after = await loadPrognosFor(owner, { period: MAY }, NOW);
    const afterLine = after.plan.lines.find((l) => l.titleId === fx.titleId)!;
    expect(afterLine.onOrderCounted).toBe(line.onOrderCounted);
    expect(afterLine.orderQty).toBe(line.orderQty);
    expect(after.valuation.onOrderValueOre).toBe(before.valuation.onOrderValueOre);
    await cancelPurchaseOrderFor(owner, { id: draftId });
  });

  it("avslutar en delvis mottagen order med restorder", async () => {
    const before = await loadPrognosFor(owner, { period: MAY }, NOW);
    const onOrderBefore = before.plan.lines.find((l) => l.titleId === fx.titleId)!.onOrderCounted;
    const poId = await createPurchaseOrderFor(
      owner,
      { ...base, supplierId, lines: [{ titleId: fx.titleId, quantity: 72, unitCostOre: 4_300 }] },
      NOW,
    );
    await expect(closePurchaseOrderFor(owner, { id: poId }, NOW)).rejects.toThrow(
      /Avbryt den i stället/,
    );
    const data = await loadPrognosFor(owner, { period: MAY }, NOW);
    const lineId = data.purchaseOrders.find((p) => p.id === poId)!.lines[0]!.id;
    await receivePurchaseOrderFor(owner, { id: poId, lines: [{ lineId, quantity: 36 }] }, NOW);
    await expect(closePurchaseOrderFor(reader, { id: poId }, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(closePurchaseOrderFor(otherOwner, { id: poId }, NOW)).rejects.toThrow(
      /finns inte/,
    );

    expect(await closePurchaseOrderFor(owner, { id: poId }, NOW)).toEqual({ missing: 36 });
    const after = await loadPrognosFor(owner, { period: MAY }, NOW);
    const po = after.purchaseOrders.find((p) => p.id === poId)!;
    expect(po).toMatchObject({ status: "received", receivedOn: TODAY });
    expect(po.note).toMatch(/restorder: 36 pack kom aldrig/);
    expect(po.lines[0]!.receivedQuantity).toBe(36);
    // Resten räknas inte längre som beställt.
    expect(after.plan.lines.find((l) => l.titleId === fx.titleId)!.onOrderCounted).toBe(
      onOrderBefore,
    );
    await expect(closePurchaseOrderFor(owner, { id: poId }, NOW)).rejects.toThrow(/redan mottagen/);
  });

  it("räknar serien från första kända saldo och tar med nivåns osäkerhet", async () => {
    const data = await loadPrognosFor(owner, { period: MAY }, NOW);
    const series = data.forecast.series.find((x) => x.titleId === fx.titleId)!;
    expect(series.levelVarianceMilli2).toBeGreaterThan(0);
    expect(series.startDate <= "2025-04-01").toBe(true);
    expect(data.forecastHistory).toEqual({ start: "2025-04-07", end: "2025-06-01" });
    expect(data.demandBasis.find((b) => b.titleId === fx.titleId)).toMatchObject({
      series: 1,
      lowDataSeries: 0,
    });
  });
});

async function centralOnHand(titleId: string): Promise<number> {
  const [row] = await asUser(fx.owner, (tx) =>
    tx
      .select({ q: s.stockLevels.quantity })
      .from(s.stockLevels)
      .where(
        and(
          eq(s.stockLevels.organizationId, fx.orgId),
          eq(s.stockLevels.locationId, fx.centralLocationId),
          eq(s.stockLevels.titleId, titleId),
        ),
      ),
  );
  return row?.q ?? 0;
}
