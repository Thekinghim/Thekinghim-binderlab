import { describe, expect, it } from "vitest";
import { addDays, DomainError } from "@/domain";
import { forecastSales } from "../forecast";
import { dailyOrders, NO_TAX } from "../forecast/test-fixtures";
import { chooseSupplierItem, coverDays, demandAt, demandSum } from "./common";
import { demandFromForecast } from "./demand";
import {
  orderQuantity,
  purchasePlan,
  purchaseQty,
  purchaseQtyByTitle,
  resolvePurchasingOptions,
  safetyStockMilli,
} from "./plan";
import type { PurchasingInput, SupplierItemRef, TitleDemand } from "./types";
import { inventoryValuation } from "./valuation";

const plain = (s: string): string => s.replace(/ /g, " ");
const TODAY = "2026-11-02";

const flat = (titleId: string, perDayMilli: number, dayVarianceMilli2 = 0): TitleDemand => ({
  titleId,
  dailyMilli: new Array(28).fill(perDayMilli),
  dayVarianceMilli2,
});

function item(
  id: string,
  supplierId: string,
  titleId: string,
  over: Partial<SupplierItemRef> = {},
): SupplierItemRef {
  return {
    id,
    supplierId,
    titleId,
    packSize: 1,
    minOrderQty: 0,
    leadTimeDays: 7,
    unitCostOre: 3_000,
    ...over,
  };
}

function input(over: Partial<PurchasingInput> = {}): PurchasingInput {
  return {
    today: TODAY,
    titles: [
      { id: "A", name: "Pokémon 151" },
      { id: "B", name: "30th Celebration" },
      { id: "C", name: "Surging Sparks" },
      { id: "D", name: "Obsidian Flames" },
      { id: "E", name: "Paldea Evolved" },
    ],
    suppliers: [
      { id: "s-1", name: "Leverantör 1", defaultLeadTimeDays: 5 },
      { id: "s-2", name: "Leverantör 2", defaultLeadTimeDays: null },
    ],
    supplierItems: [
      item("i-a1", "s-1", "A", {
        packSize: 12,
        minOrderQty: 10,
        leadTimeDays: 7,
        unitCostOre: 3_000,
      }),
      item("i-a2", "s-2", "A", { leadTimeDays: 3, unitCostOre: 3_200 }),
      item("i-b1", "s-1", "B", { packSize: 6, leadTimeDays: null, unitCostOre: 1_500 }),
    ],
    warehouseStock: [
      { titleId: "A", onHand: 5 },
      { titleId: "B", onHand: 30 },
      { titleId: "C", onHand: 0 },
      { titleId: "E", onHand: 3 },
    ],
    machineStock: [
      { machineId: "m-1", titleId: "A", onHand: 2 },
      { machineId: "m-2", titleId: "A", onHand: 1 },
      { machineId: "m-1", titleId: "D", onHand: 4 },
      { machineId: "m-3", titleId: "D", onHand: -2 },
    ],
    openPurchaseOrders: [
      {
        id: "po-1",
        supplierId: "s-1",
        status: "partially_received",
        orderedOn: "2026-10-29",
        expectedOn: "2026-11-05",
        lines: [{ titleId: "A", quantity: 6, receivedQuantity: 2, unitCostOre: 3_000 }],
      },
      {
        id: "po-2",
        supplierId: "s-1",
        status: "ordered",
        orderedOn: "2026-11-01",
        expectedOn: "2026-12-20",
        lines: [{ titleId: "A", quantity: 10, receivedQuantity: 0, unitCostOre: 3_000 }],
      },
      {
        id: "po-3",
        supplierId: "s-1",
        status: "draft",
        orderedOn: null,
        expectedOn: null,
        lines: [{ titleId: "A", quantity: 100, receivedQuantity: 0, unitCostOre: 3_000 }],
      },
      {
        id: "po-4",
        supplierId: "s-1",
        status: "received",
        orderedOn: "2026-10-01",
        expectedOn: "2026-10-08",
        lines: [{ titleId: "A", quantity: 50, receivedQuantity: 40, unitCostOre: 3_000 }],
      },
    ],
    prices: [
      { titleId: "A", unitCostOre: 2_800, validFrom: "2026-10-01" },
      { titleId: "A", unitCostOre: 3_100, validFrom: "2026-12-01" },
      { titleId: "D", unitCostOre: 1_000, validFrom: "2026-01-01" },
    ],
    demand: [flat("A", 2_000), flat("B", 1_000, 1_000_000), flat("C", 500)],
    ...over,
  };
}

describe("regler", () => {
  it("antal: hela pack uppåt → minsta order → hela boxar", () => {
    expect(orderQuantity(13_200, 24, 12)).toEqual({ rawQty: 14, afterMinQty: 24, orderQty: 24 });
    expect(orderQuantity(25_000, 24, 12)).toEqual({ rawQty: 25, afterMinQty: 25, orderQty: 36 });
    expect(orderQuantity(12_000, 0, 12)).toEqual({ rawQty: 12, afterMinQty: 12, orderQty: 12 });
    expect(orderQuantity(12_001, 0, 12)).toEqual({ rawQty: 13, afterMinQty: 13, orderQty: 24 });
    expect(orderQuantity(1, 0, 1)).toEqual({ rawQty: 1, afterMinQty: 1, orderQty: 1 });
    // Minsta order som inte är hela boxar avrundas också uppåt: 10 → 12.
    expect(orderQuantity(3_000, 10, 12)).toEqual({ rawQty: 3, afterMinQty: 10, orderQty: 12 });
    expect(orderQuantity(0, 24, 12)).toEqual({ rawQty: 0, afterMinQty: 0, orderQty: 0 });
    expect(() => orderQuantity(1_000, 0, 0)).toThrow(DomainError);
    expect(() => orderQuantity(-1, 0, 1)).toThrow(DomainError);
  });

  it("säkerhetslager = z × √(dagar × dagsvarians)", () => {
    // √(14 × 1 000 000) = 3 742 (3 741,66); × 1,645 = 6 156.
    expect(safetyStockMilli(1_645, 14, 1_000_000)).toBe(6_156);
    expect(safetyStockMilli(1_645, 14, 0)).toBe(0);
    expect(safetyStockMilli(0, 14, 1_000_000)).toBe(0);
  });

  it("servicenivån väljer z", () => {
    expect(resolvePurchasingOptions().zMilli).toBe(1_645);
    expect(resolvePurchasingOptions({ serviceLevelBp: 9_900 }).zMilli).toBe(2_326);
    expect(() => resolvePurchasingOptions({ serviceLevelBp: 9_600 })).toThrow(DomainError);
    expect(() => resolvePurchasingOptions({ reviewPeriodDays: 0 })).toThrow(DomainError);
  });

  it("efterfrågan efter prognosens slut upprepar sista veckan", () => {
    const d: TitleDemand = {
      titleId: "x",
      dailyMilli: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => v * 1_000),
      dayVarianceMilli2: 0,
    };
    expect(demandAt(d, 9)).toBe(10_000);
    expect(demandAt(d, 10)).toBe(4_000);
    expect(demandAt(d, 16)).toBe(10_000);
    expect(demandAt(d, 17)).toBe(4_000);
    expect(demandSum(d, 8, 4)).toBe(9_000 + 10_000 + 4_000 + 5_000);
    expect(demandAt({ titleId: "y", dailyMilli: [1_000, 3_000], dayVarianceMilli2: 0 }, 5)).toBe(
      3_000,
    );
    expect(demandAt(undefined, 3)).toBe(0);
  });

  it("täckning: hela dagar innan efterfrågan överstiger lagret", () => {
    const d = flat("x", 3_000);
    expect(coverDays(10, d)).toBe(3);
    expect(coverDays(0, d)).toBe(0);
    expect(coverDays(5, flat("x", 0))).toBeNull();
    expect(coverDays(100_000, d)).toBeNull();
  });

  it("leverantör: billigast per pack, sedan kortast ledtid, sedan id", () => {
    const lt = (it: SupplierItemRef) => it.leadTimeDays ?? 99;
    const a = item("1", "s-b", "A", { unitCostOre: 3_000, leadTimeDays: 7 });
    const b = item("2", "s-a", "A", { unitCostOre: 3_000, leadTimeDays: 3 });
    const c = item("3", "s-c", "A", { unitCostOre: 2_900, leadTimeDays: 14 });
    expect(chooseSupplierItem([a, b], lt)!.id).toBe("2");
    expect(chooseSupplierItem([a, b, c], lt)!.id).toBe("3");
    const d = item("4", "s-a", "A", { unitCostOre: 3_000, leadTimeDays: 7 });
    expect(chooseSupplierItem([a, d], lt)!.id).toBe("4");
    expect(chooseSupplierItem([], lt)).toBeNull();
  });
});

describe("purchasePlan", () => {
  const plan = purchasePlan(input());
  const line = (id: string) => plan.lines.find((l) => l.titleId === id)!;

  it("beställer upp till behovet till nästa leverans, avrundat till minsta order och hela boxar", () => {
    const a = line("A");
    expect(a).toMatchObject({
      status: "order",
      supplierId: "s-1",
      supplierItemId: "i-a1",
      leadTimeDays: 7,
      leadTimeSource: "item",
      demandLeadTimeMilli: 14_000,
      demandProtectionMilli: 28_000,
      safetyStockMilli: 0,
      targetMilli: 28_000,
      warehouseOnHand: 5,
      machineOnHand: 3,
      onOrderCounted: 4,
      onOrderLater: 10,
      positionPacks: 12,
      shortfallMilli: 16_000,
      rawQty: 16,
      afterMinQty: 16,
      orderQty: 24,
      boxes: 2,
      orderValueOre: 72_000,
      expectedArrival: "2026-11-09",
      coverDays: 6,
      projectedStockout: "2026-11-08",
      orderBy: TODAY,
      late: true,
    });
    expect(a.onOrder.map((x) => [x.purchaseOrderId, x.outstanding, x.counted])).toEqual([
      ["po-1", 4, true],
      ["po-2", 10, false],
    ]);
    expect(plain(a.text)).toBe(
      "Beställ 24 pack Pokémon 151 (2 boxar à 12) från Leverantör 1 för 720 kr. " +
        "Behov till nästa leverans 28 pack (7 dagars ledtid + 7 dagar till nästa beställning) + säkerhetslager 0 = 28; " +
        "lager 12 (vårt lager 5, automater 3, beställt 4). Saknas 16, avrundat till 24 (12 per box). " +
        "Lagret väntas ta slut 8 nov., före leveransen 9 nov. 10 beställda pack kommer senare och räknas inte.",
    );
    expect(a.evidence.machineIds).toEqual(["m-1", "m-2"]);
    expect(a.evidence.figures.find((f) => f.key === "orderQty")!.value).toBe(24);
  });

  it("underlaget länkar till inköpsorder och leverantörer", () => {
    const a = line("A");
    // po-1 räknas, po-2 kommer efter ledtid + intervall; utkastet po-3 och mottagna po-4 räknas inte.
    expect(a.evidence.purchaseOrderIds).toEqual(["po-1", "po-2"]);
    expect(a.evidence.supplierIds).toEqual(["s-1"]);
    expect(a.evidence.dates).toEqual(["2026-11-05", "2026-12-20"]);
    expect(a.evidence.figures.find((f) => f.key === "onOrderLater")!.value).toBe(10);
    expect(line("C").evidence.purchaseOrderIds).toEqual([]);
    const s1 = plan.orders.find((o) => o.supplierId === "s-1")!;
    expect(s1.evidence.supplierIds).toEqual(["s-1"]);
    expect(s1.evidence.purchaseOrderIds).toEqual(["po-1", "po-2"]);
    const withDraft = purchasePlan(input({ options: { includeDraftOrders: true } }));
    expect(withDraft.lines.find((l) => l.titleId === "A")!.evidence.purchaseOrderIds).toEqual([
      "po-1",
      "po-2",
      "po-3",
    ]);
  });

  it("räcker lagret: ingen beställning, men senaste beställningsdag", () => {
    const b = line("B");
    expect(b).toMatchObject({
      status: "ok",
      leadTimeDays: 5,
      leadTimeSource: "supplier",
      demandProtectionMilli: 12_000,
      safetyStockMilli: 5_698, // 1,645 × √(12 × 1 000 000)
      targetMilli: 17_698,
      orderQty: 0,
      coverDays: 30,
      projectedStockout: "2026-12-02",
      orderBy: "2026-11-27",
      late: false,
    });
    expect(plain(b.text)).toBe(
      "30th Celebration räcker: 30 pack i lager och beställt mot behovet 18 t.o.m. nästa leverans (räcker 30 dagar). Beställ senast 27 nov.",
    );
  });

  it("titel utan leverantörsartikel och titel utan efterfrågan", () => {
    expect(line("C")).toMatchObject({
      status: "no-supplier",
      rawQty: 7,
      orderQty: 0,
      leadTimeSource: "default",
    });
    expect(plain(line("C").text)).toMatch(
      /^Surging Sparks behöver 7 pack men saknar leverantörsartikel\./,
    );
    expect(line("D")).toMatchObject({ status: "no-demand", positionPacks: 4, orderQty: 0 });
    expect(plain(line("D").text)).toBe(
      "Obsidian Flames: ingen väntad försäljning. 4 pack i lager. 1 lagerplats med negativt saldo räknas som 0.",
    );
  });

  it("samlar raderna till inköpsorder per leverantör", () => {
    expect(plan.lines.map((l) => l.titleId)).toEqual(["A", "C", "B", "D", "E"]);
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0]).toMatchObject({
      supplierId: "s-1",
      totalPacks: 24,
      totalOre: 72_000,
      expectedArrival: "2026-11-09",
    });
    expect(plain(plan.orders[0]!.text)).toBe(
      "Inköpsorder till Leverantör 1: 1 titel, 24 pack för 720 kr. Väntad leverans 9 nov.",
    );
    expect(plan.totalOre).toBe(72_000);
    expect(plain(plan.text)).toBe(
      "Föreslagna inköp: 720 kr hos 1 leverantör (1 titel). 1 titel behöver köpas men saknar leverantörsartikel.",
    );
  });

  it("utkast räknas bara om det anges; väntad leverans utan datum = i dag + ledtid", () => {
    const p = purchasePlan(input({ options: { includeDraftOrders: true } }));
    const a = p.lines.find((l) => l.titleId === "A")!;
    expect(a.onOrderCounted).toBe(104);
    expect(a.onOrder.find((x) => x.purchaseOrderId === "po-3")!.expectedOn).toBe("2026-11-09");
    expect(a.status).toBe("ok");
  });

  it("försenad leverans räknas och markeras", () => {
    const p = purchasePlan(
      input({
        openPurchaseOrders: [
          {
            id: "po-9",
            supplierId: "s-1",
            status: "ordered",
            orderedOn: "2026-10-01",
            expectedOn: "2026-10-20",
            lines: [{ titleId: "A", quantity: 5, receivedQuantity: 0, unitCostOre: 3_000 }],
          },
        ],
      }),
    );
    const oo = p.lines.find((l) => l.titleId === "A")!.onOrder[0]!;
    expect([oo.overdue, oo.counted]).toEqual([true, true]);
  });

  it("texten säger varför antalet avrundats", () => {
    const p = purchasePlan(
      input({
        demand: [flat("A", 500)],
        warehouseStock: [],
        machineStock: [],
        openPurchaseOrders: [],
      }),
    );
    const a = p.lines.find((l) => l.titleId === "A")!;
    // Saknas 7 → minsta order 10 → 12 (hela boxar).
    expect([a.rawQty, a.afterMinQty, a.orderQty]).toEqual([7, 10, 12]);
    expect(plain(a.text)).toMatch(/Saknas 7, avrundat till 12 \(minsta order 10, 12 per box\)\./);
  });

  it("säkerhetslager höjer beställningen", () => {
    const p = purchasePlan(input({ demand: [flat("A", 2_000, 4_000_000)] }));
    const a = p.lines.find((l) => l.titleId === "A")!;
    // 1,645 × √(14 × 4 000 000) = 1,645 × 7 483 = 12 310 → mål 40 310, saknas 28 310 → 29 → 36.
    expect(a.safetyStockMilli).toBe(12_310);
    expect(a.rawQty).toBe(29);
    expect(a.orderQty).toBe(36);
  });

  it("ogiltig leverantörsartikel ger DomainError", () => {
    expect(() =>
      purchasePlan(input({ supplierItems: [item("bad", "s-1", "A", { packSize: 0 })] })),
    ).toThrow(DomainError);
  });
});

describe("inventoryValuation", () => {
  const v = inventoryValuation(input());
  const row = (id: string) => v.titles.find((t) => t.titleId === id)!;

  it("lagervärde med inköpspriset som gäller i dag, annars leverantörens pris", () => {
    expect(row("A")).toMatchObject({
      onHand: 8,
      unitCostOre: 2_800,
      costSource: "purchase-price",
      warehouseValueOre: 14_000,
      machineValueOre: 8_400,
      valueOre: 22_400,
      onOrderPacks: 14,
      onOrderValueOre: 42_000,
      capitalTiedOre: 64_400,
      shareBp: 3_137,
      demandPerDayMilli: 2_000,
      coverDays: 4,
    });
    expect(row("B")).toMatchObject({
      unitCostOre: 1_500,
      costSource: "supplier-item",
      valueOre: 45_000,
    });
    expect(row("D")).toMatchObject({
      onHand: 4,
      valueOre: 4_000,
      negativeStockLocations: 1,
      coverDays: null,
    });
    expect(row("E")).toMatchObject({ unitCostOre: null, costSource: "none", valueOre: 0 });
    expect(plain(row("A").text)).toBe(
      "Pokémon 151: 8 pack i lager för 224 kr (31 % av lagervärdet), räcker 4 dagar. Beställt 14 pack för 420 kr.",
    );
    expect(plain(row("D").text)).toBe(
      "Obsidian Flames: 4 pack i lager för 40 kr (6 % av lagervärdet), ingen väntad försäljning.",
    );
  });

  it("summor och kapitalbindning", () => {
    expect(v.valueOre).toBe(71_400);
    expect(v.machineValueOre).toBe(12_400);
    expect(v.warehouseValueOre).toBe(59_000);
    expect(v.onOrderValueOre).toBe(42_000);
    expect(v.capitalTiedOre).toBe(113_400);
    expect(v.titles.reduce((a, t) => a + t.valueOre, 0)).toBe(v.valueOre);
    expect(v.titlesWithoutCost).toEqual(["E"]);
    expect(v.titles.map((t) => t.titleId)).toEqual(["A", "B", "D", "C", "E"]);
    expect(plain(v.text)).toBe(
      "Lagret är värt 714 kr i inköpspris, varav 124 kr i automaterna. Beställt för 420 kr: kapitalbindning 1 134 kr. " +
        "Mest bundet i Pokémon 151: 644 kr (57 %). 1 titel saknar inköpspris och räknas som 0.",
    );
  });

  it("underlaget länkar till inköpsorder och leverantören vars pris används", () => {
    expect(row("A").evidence.purchaseOrderIds).toEqual(["po-1", "po-2"]);
    expect(row("A").evidence.supplierIds).toEqual(["s-1"]);
    // B värderas med leverantörsartikelns pris: leverantören ingår i underlaget.
    expect(row("B").evidence.supplierIds).toEqual(["s-1"]);
    // D värderas med inköpspriset och har inget beställt.
    expect(row("D").evidence.supplierIds).toEqual([]);
    expect(row("D").evidence.purchaseOrderIds).toEqual([]);
    expect(v.evidence.purchaseOrderIds).toEqual(["po-1", "po-2"]);
    expect(v.evidence.supplierIds).toEqual(["s-1"]);
  });

  it("ett framtida inköpspris gäller inte i dag", () => {
    const later = inventoryValuation(input({ today: "2026-12-01" }));
    expect(later.titles.find((t) => t.titleId === "A")!.unitCostOre).toBe(3_100);
  });
});

describe("från prognos till inköp", () => {
  const asOf = "2026-10-31";
  const orders = [
    ...dailyOrders("a", "A", "m-1", addDays(asOf, -139), 140, 3),
    ...dailyOrders("b", "A", "m-2", addDays(asOf, -139), 140, 1),
  ];
  const forecast = forecastSales({ orders, asOf, settings: NO_TAX });

  it("efterfrågan per titel är summan av automaterna och kan börja senare", () => {
    const d = demandFromForecast(forecast);
    expect(d).toHaveLength(1);
    expect(d[0]!.dailyMilli).toHaveLength(28);
    expect(d[0]!.dailyMilli[0]).toBe(4_000);
    expect(d[0]!.dayVarianceMilli2).toBe(3_000_000 + 1_000_000);
    expect(demandFromForecast(forecast, TODAY)[0]!.dailyMilli).toHaveLength(27);
    expect(() => demandFromForecast(forecast, asOf)).toThrow(DomainError);
  });

  it("planen använder prognosen och dess osäkerhet", () => {
    const p = purchasePlan(
      input({
        today: "2026-11-01",
        demand: demandFromForecast(forecast),
        openPurchaseOrders: [],
        warehouseStock: [{ titleId: "A", onHand: 10 }],
        machineStock: [],
      }),
    );
    const a = p.lines.find((l) => l.titleId === "A")!;
    // 14 dagar × 4 pack = 56; säkerhetslager 1,645 × √(14 × 4 000 000) = 12 310.
    expect(a.demandProtectionMilli).toBe(56_000);
    expect(a.safetyStockMilli).toBe(12_310);
    expect(a.rawQty).toBe(59); // 68 310 − 10 000 → 58,31 → 59
    expect(a.orderQty).toBe(60);
  });
});

describe("purchaseQty: en regel för Inköp och Vårt lager", () => {
  it("beställ: det avrundade antalet; utan leverantör: det som saknas; annars 0", () => {
    expect(purchaseQty({ status: "order", orderQty: 36, rawQty: 25 })).toBe(36);
    expect(purchaseQty({ status: "no-supplier", orderQty: 0, rawQty: 59 })).toBe(59);
    expect(purchaseQty({ status: "ok", orderQty: 0, rawQty: 0 })).toBe(0);
    expect(purchaseQty({ status: "no-demand", orderQty: 0, rawQty: 0 })).toBe(0);
  });

  it("per titel: bara titlar med antal över 0", () => {
    const m = purchaseQtyByTitle({
      lines: [
        { titleId: "a", status: "order", orderQty: 24, rawQty: 14 },
        { titleId: "b", status: "no-supplier", orderQty: 0, rawQty: 7 },
        { titleId: "c", status: "ok", orderQty: 0, rawQty: 0 },
      ] as unknown as Parameters<typeof purchaseQtyByTitle>[0]["lines"],
    });
    expect([...m]).toEqual([
      ["a", 24],
      ["b", 7],
    ]);
  });
});
