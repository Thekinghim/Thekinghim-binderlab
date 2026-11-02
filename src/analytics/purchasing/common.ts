/**
 * Gemensam hjälp för inköpsplanering och lagervärde: efterfrågan per dag, täckning,
 * beställt och saldon per titel.
 */

import { addDays, DomainError, type IsoDate } from "@/domain";
import { assertIntAtLeast, assertOre, MILLI } from "../forecast/common";
import type {
  MachineStockRef,
  OnOrderLine,
  PurchaseOrderRef,
  SupplierItemRef,
  SupplierRef,
  TitleDemand,
  WarehouseStockRef,
} from "./types";

/** Längsta täckning som räknas ut (dagar). Längre visas som "över ett år". */
export const MAX_COVER_DAYS = 366;

/**
 * Efterfrågan dag `i` (0 = i dag), i tusendelar. Efter seriens slut upprepas den sista
 * veckan (samma veckodag), så att veckodagsmönstret behålls. Är serien kortare än 7 dagar
 * upprepas hela serien. Tom serie = 0.
 */
export function demandAt(d: TitleDemand | undefined, i: number): number {
  if (!d) return 0;
  const n = d.dailyMilli.length;
  if (n === 0) return 0;
  if (i < n) return d.dailyMilli[i] ?? 0;
  const cycle = Math.min(7, n);
  const offset = (i - n) % cycle;
  return d.dailyMilli[n - cycle + offset] ?? 0;
}

/** Summan av efterfrågan dag `from` … `from + days − 1`, i tusendelar. */
export function demandSum(d: TitleDemand | undefined, from: number, days: number): number {
  let s = 0;
  for (let i = from; i < from + days; i++) s += demandAt(d, i);
  return s;
}

/**
 * Hela dagar som `packs` räcker: antalet dagar från i dag innan den sammanlagda
 * efterfrågan överstiger lagret. `null` om lagret räcker längre än `MAX_COVER_DAYS` eller
 * efterfrågan är 0. 0 om lagret inte räcker i dag.
 */
export function coverDays(packs: number, d: TitleDemand | undefined): number | null {
  const stock = packs * MILLI;
  let cum = 0;
  for (let i = 0; i < MAX_COVER_DAYS; i++) {
    cum += demandAt(d, i);
    if (cum > stock) return i;
  }
  return null;
}

/** Kontrollerar en leverantörsartikel. */
export function assertSupplierItem(item: SupplierItemRef): void {
  assertIntAtLeast(item.packSize, 1, `Pack per box för artikel ${item.id}`);
  assertIntAtLeast(item.minOrderQty, 0, `Minsta beställning för artikel ${item.id}`);
  if (item.leadTimeDays !== null)
    assertIntAtLeast(item.leadTimeDays, 0, `Ledtid för artikel ${item.id}`);
  assertOre(item.unitCostOre, `Inköpspris för artikel ${item.id}`);
}

/**
 * Leverantörsartikeln som används för titeln: lägst pris per pack, sedan kortast ledtid,
 * sedan leverantörens och artikelns id (så att valet alltid är detsamma).
 */
export function chooseSupplierItem(
  items: readonly SupplierItemRef[],
  leadTime: (item: SupplierItemRef) => number,
): SupplierItemRef | null {
  let best: SupplierItemRef | null = null;
  for (const it of items) {
    if (
      best === null ||
      it.unitCostOre < best.unitCostOre ||
      (it.unitCostOre === best.unitCostOre &&
        (leadTime(it) < leadTime(best) ||
          (leadTime(it) === leadTime(best) &&
            (it.supplierId < best.supplierId ||
              (it.supplierId === best.supplierId && it.id < best.id)))))
    ) {
      best = it;
    }
  }
  return best;
}

/** Ledtiden för en artikel: artikelns, annars leverantörens standard, annars `fallback`. */
export function leadTimeOf(
  item: SupplierItemRef,
  suppliers: ReadonlyMap<string, SupplierRef>,
  fallback: number,
): { days: number; source: "item" | "supplier" | "default" } {
  if (item.leadTimeDays !== null) return { days: item.leadTimeDays, source: "item" };
  const s = suppliers.get(item.supplierId);
  if (s && s.defaultLeadTimeDays !== null) {
    assertIntAtLeast(s.defaultLeadTimeDays, 0, `Ledtid för leverantör ${s.id}`);
    return { days: s.defaultLeadTimeDays, source: "supplier" };
  }
  return { days: fallback, source: "default" };
}

/**
 * Beställt men inte mottaget per titel, från öppna inköpsorder (status 'ordered' och
 * 'partially_received', plus 'draft' om `includeDrafts`). Kvar = beställt − mottaget (minst 0).
 * Väntad leverans = `expectedOn`, annars beställd + ledtid, annars i dag + ledtid.
 * En rad räknas i lagerpositionen när den väntas senast `countUntil`.
 */
export function onOrderByTitle(args: {
  orders: readonly PurchaseOrderRef[];
  today: IsoDate;
  includeDrafts: boolean;
  leadTimeFor: (supplierId: string, titleId: string) => number;
  countUntil: (titleId: string) => IsoDate;
}): Map<string, OnOrderLine[]> {
  const out = new Map<string, OnOrderLine[]>();
  for (const po of args.orders) {
    const open =
      po.status === "ordered" ||
      po.status === "partially_received" ||
      (args.includeDrafts && po.status === "draft");
    if (!open) continue;
    for (const line of po.lines) {
      assertIntAtLeast(line.quantity, 0, `Antal på inköpsorder ${po.id}`);
      assertIntAtLeast(line.receivedQuantity, 0, `Mottaget antal på inköpsorder ${po.id}`);
      assertOre(line.unitCostOre, `Pris på inköpsorder ${po.id}`);
      const outstanding = Math.max(0, line.quantity - line.receivedQuantity);
      if (outstanding === 0) continue;
      const lt = args.leadTimeFor(po.supplierId, line.titleId);
      const expectedOn =
        po.expectedOn ??
        (po.orderedOn !== null ? addDays(po.orderedOn, lt) : addDays(args.today, lt));
      const entry: OnOrderLine = {
        purchaseOrderId: po.id,
        supplierId: po.supplierId,
        status: po.status,
        outstanding,
        unitCostOre: line.unitCostOre,
        expectedOn,
        overdue: expectedOn < args.today,
        counted: expectedOn <= args.countUntil(line.titleId),
      };
      const list = out.get(line.titleId);
      if (list) list.push(entry);
      else out.set(line.titleId, [entry]);
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) =>
      a.expectedOn !== b.expectedOn
        ? a.expectedOn < b.expectedOn
          ? -1
          : 1
        : a.purchaseOrderId < b.purchaseOrderId
          ? -1
          : a.purchaseOrderId > b.purchaseOrderId
            ? 1
            : 0,
    );
  }
  return out;
}

/** Saldo per titel: centrallager och automater. Negativa saldon räknas som 0 och räknas upp. */
export function stockByTitle(
  warehouse: readonly WarehouseStockRef[],
  machines: readonly MachineStockRef[],
): Map<string, { warehouse: number; machines: number; negative: number; machineIds: string[] }> {
  const out = new Map<
    string,
    { warehouse: number; machines: number; negative: number; machineIds: string[] }
  >();
  const get = (titleId: string) => {
    let e = out.get(titleId);
    if (!e) {
      e = { warehouse: 0, machines: 0, negative: 0, machineIds: [] };
      out.set(titleId, e);
    }
    return e;
  };
  for (const w of warehouse) {
    if (!Number.isSafeInteger(w.onHand)) {
      throw new DomainError("invalid_input", `Ogiltigt saldo för titel ${w.titleId}.`);
    }
    const e = get(w.titleId);
    if (w.onHand < 0) e.negative += 1;
    else e.warehouse += w.onHand;
  }
  for (const m of machines) {
    if (!Number.isSafeInteger(m.onHand)) {
      throw new DomainError(
        "invalid_input",
        `Ogiltigt saldo för titel ${m.titleId} i ${m.machineId}.`,
      );
    }
    const e = get(m.titleId);
    if (m.onHand < 0) e.negative += 1;
    else e.machines += m.onHand;
    e.machineIds.push(m.machineId);
  }
  return out;
}
