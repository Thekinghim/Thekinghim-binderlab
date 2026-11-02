/**
 * Lagervärde och kapitalbindning per titel.
 *
 * Regler:
 * - **Inköpspris** = det pris i purchase_prices som gäller i dag (senaste med giltig från ≤ i dag,
 *   domänens `priceOn`). Saknas det används leverantörsartikelns pris (billigast per pack).
 *   Saknas båda räknas titelns värde som 0 och titeln listas i `titlesWithoutCost`.
 * - **Lagervärde** = (centrallager + automater) × inköpspris. Negativa saldon räknas som 0.
 * - **Beställt** = kvar att ta emot på öppna inköpsorder × radens pris.
 * - **Kapitalbindning** = lagervärde + beställt.
 * - **Räcker** = hela dagar som lagret (utan beställt) räcker enligt efterfrågan.
 * - Andel = titelns lagervärde / totalt lagervärde, i bp.
 */

import { assertIsoDate, PriceIndex, ratioBp, roundHalfUp } from "@/domain";
import { fig, planEvidence } from "../forecast/common";
import { titleNames } from "../todos/common";
import { kr, pct, plural } from "../todos/text";
import {
  assertSupplierItem,
  chooseSupplierItem,
  coverDays,
  demandSum,
  leadTimeOf,
  onOrderByTitle,
  stockByTitle,
} from "./common";
import { resolvePurchasingOptions } from "./plan";
import type {
  InventoryValuation,
  PurchasingInput,
  SupplierItemRef,
  TitleDemand,
  TitleInventoryValue,
} from "./types";

/** Lagervärde, beställt och kapitalbindning per titel och totalt. */
export function inventoryValuation(input: PurchasingInput): InventoryValuation {
  assertIsoDate(input.today, "Dagen för lagervärdet");
  const o = resolvePurchasingOptions(input.options);
  const today = input.today;
  const titleName = titleNames(input.titles ?? []);
  const prices = new PriceIndex(input.prices ?? []);
  const suppliers = new Map(input.suppliers.map((s) => [s.id, s]));
  const itemsByTitle = new Map<string, SupplierItemRef[]>();
  for (const it of input.supplierItems) {
    assertSupplierItem(it);
    const list = itemsByTitle.get(it.titleId);
    if (list) list.push(it);
    else itemsByTitle.set(it.titleId, [it]);
  }
  const leadOf = (it: SupplierItemRef) => leadTimeOf(it, suppliers, o.defaultLeadTimeDays).days;
  const demand = new Map<string, TitleDemand>(input.demand.map((d) => [d.titleId, d]));
  const stock = stockByTitle(input.warehouseStock, input.machineStock);
  const onOrder = onOrderByTitle({
    orders: input.openPurchaseOrders,
    today,
    includeDrafts: o.includeDraftOrders,
    leadTimeFor: (supplierId, titleId) => {
      const it = (itemsByTitle.get(titleId) ?? []).find((x) => x.supplierId === supplierId);
      return it
        ? leadOf(it)
        : (suppliers.get(supplierId)?.defaultLeadTimeDays ?? o.defaultLeadTimeDays);
    },
    countUntil: () => "9999-12-31",
  });

  const titleIds = [...new Set([...stock.keys(), ...onOrder.keys()])].sort();
  const rows = titleIds.map((titleId) => {
    const st = stock.get(titleId) ?? { warehouse: 0, machines: 0, negative: 0, machineIds: [] };
    const price = prices.priceOn(titleId, today);
    const item = chooseSupplierItem(itemsByTitle.get(titleId) ?? [], leadOf);
    const unitCost = price ? price.unitCostOre : item ? item.unitCostOre : null;
    const costSource = price ? "purchase-price" : item ? "supplier-item" : "none";
    const onHand = st.warehouse + st.machines;
    const c = unitCost ?? 0;
    const oo = onOrder.get(titleId) ?? [];
    const onOrderPacks = oo.reduce((s, x) => s + x.outstanding, 0);
    const onOrderValue = oo.reduce((s, x) => s + x.outstanding * x.unitCostOre, 0);
    const d = demand.get(titleId);
    const demandPerDay = d ? roundHalfUp(demandSum(d, 0, 28), 28) : 0;
    return {
      titleId,
      warehouseOnHand: st.warehouse,
      machineOnHand: st.machines,
      onHand,
      unitCostOre: unitCost,
      costSource,
      warehouseValueOre: st.warehouse * c,
      machineValueOre: st.machines * c,
      valueOre: onHand * c,
      onOrderPacks,
      onOrderValueOre: onOrderValue,
      capitalTiedOre: onHand * c + onOrderValue,
      demandPerDayMilli: demandPerDay,
      coverDays: d ? coverDays(onHand, d) : null,
      negativeStockLocations: st.negative,
      machineIds: st.machineIds,
      orderIds: oo.map((x) => x.purchaseOrderId),
      supplierIds: [
        ...oo.map((x) => x.supplierId),
        ...(costSource === "supplier-item" && item ? [item.supplierId] : []),
      ],
    } as const;
  });

  const valueOre = rows.reduce((s, r) => s + r.valueOre, 0);
  const titles: TitleInventoryValue[] = rows
    .map((r) => {
      const shareBp = ratioBp(r.valueOre, valueOre);
      const tName = titleName(r.titleId);
      let text: string;
      if (r.unitCostOre === null) {
        text = `${tName}: ${r.onHand} pack i lager, inköpspris saknas.`;
      } else {
        text = `${tName}: ${r.onHand} pack i lager för ${kr(r.valueOre)}`;
        if (shareBp !== null) text += ` (${pct(shareBp)} av lagervärdet)`;
        text +=
          r.coverDays !== null
            ? `, räcker ${plural(r.coverDays, "dag", "dagar")}.`
            : r.demandPerDayMilli === 0
              ? ", ingen väntad försäljning."
              : ", räcker över ett år.";
      }
      if (r.onOrderPacks > 0)
        text += ` Beställt ${r.onOrderPacks} pack för ${kr(r.onOrderValueOre)}.`;
      const { machineIds, orderIds, supplierIds, ...rest } = r;
      return {
        ...rest,
        shareBp,
        text,
        evidence: planEvidence({
          rule:
            "Lagervärde = (centrallager + automater) × inköpspriset som gäller i dag; " +
            "kapitalbindning = lagervärde + beställt (kvar att ta emot × radens pris).",
          period: { start: today, end: today },
          titleIds: [r.titleId],
          machineIds,
          purchaseOrderIds: orderIds,
          supplierIds,
          figures: [
            fig("warehouseOnHand", "Centrallager", r.warehouseOnHand, "packs"),
            fig("machineOnHand", "I automater", r.machineOnHand, "packs"),
            fig("unitCostOre", "Inköpspris per pack", r.unitCostOre ?? 0, "ore"),
            fig("valueOre", "Lagervärde", r.valueOre, "ore"),
            fig("onOrderPacks", "Beställt", r.onOrderPacks, "packs"),
            fig("onOrderValueOre", "Beställt värde", r.onOrderValueOre, "ore"),
            fig("capitalTiedOre", "Kapitalbindning", r.capitalTiedOre, "ore"),
            fig("demandPerDayMilli", "Efterfrågan per dag", r.demandPerDayMilli, "milli"),
            ...(orderIds.length > 0
              ? [fig("openPurchaseOrders", "Öppna inköpsorder", new Set(orderIds).size, "count")]
              : []),
          ],
        }),
      } satisfies TitleInventoryValue;
    })
    .sort((a, b) => b.capitalTiedOre - a.capitalTiedOre || (a.titleId < b.titleId ? -1 : 1));

  const warehouseValueOre = titles.reduce((s, r) => s + r.warehouseValueOre, 0);
  const machineValueOre = titles.reduce((s, r) => s + r.machineValueOre, 0);
  const onOrderValueOre = titles.reduce((s, r) => s + r.onOrderValueOre, 0);
  const capitalTiedOre = valueOre + onOrderValueOre;
  const withoutCost = titles
    .filter((r) => r.unitCostOre === null && r.onHand > 0)
    .map((r) => r.titleId);

  let text = `Lagret är värt ${kr(valueOre)} i inköpspris, varav ${kr(machineValueOre)} i automaterna.`;
  if (onOrderValueOre > 0)
    text += ` Beställt för ${kr(onOrderValueOre)}: kapitalbindning ${kr(capitalTiedOre)}.`;
  const top = titles[0];
  if (top && capitalTiedOre > 0 && top.capitalTiedOre > 0) {
    const share = ratioBp(top.capitalTiedOre, capitalTiedOre) ?? 0;
    text += ` Mest bundet i ${titleName(top.titleId)}: ${kr(top.capitalTiedOre)} (${pct(share)}).`;
  }
  if (withoutCost.length > 0) {
    text += ` ${plural(withoutCost.length, "titel", "titlar")} saknar inköpspris och räknas som 0.`;
  }
  return {
    today,
    titles,
    valueOre,
    warehouseValueOre,
    machineValueOre,
    onOrderValueOre,
    capitalTiedOre,
    titlesWithoutCost: withoutCost,
    text,
    evidence: planEvidence({
      rule: "Summan av titlarnas lagervärde och beställda värde.",
      period: { start: today, end: today },
      titleIds: titles.map((r) => r.titleId),
      purchaseOrderIds: titles.flatMap((r) => r.evidence.purchaseOrderIds ?? []),
      supplierIds: titles.flatMap((r) => r.evidence.supplierIds ?? []),
      figures: [
        fig("valueOre", "Lagervärde", valueOre, "ore"),
        fig("warehouseValueOre", "Varav centrallager", warehouseValueOre, "ore"),
        fig("machineValueOre", "Varav automater", machineValueOre, "ore"),
        fig("onOrderValueOre", "Beställt", onOrderValueOre, "ore"),
        fig("capitalTiedOre", "Kapitalbindning", capitalTiedOre, "ore"),
        fig("titlesWithoutCost", "Titlar utan inköpspris", withoutCost.length, "count"),
      ],
    }),
  };
}
