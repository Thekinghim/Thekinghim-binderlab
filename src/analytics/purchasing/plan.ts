/**
 * Inköpsplanering: förslag på inköpsorder per titel och leverantör.
 *
 * Regler (periodisk beställning: beställning kan läggas var `reviewPeriodDays` dag):
 * 1. **Leverantör.** Titelns leverantörsartikel med lägst pris per pack (sedan kortast ledtid).
 *    Ledtid = artikelns, annars leverantörens standard, annars `defaultLeadTimeDays`.
 * 2. **Behov till nästa leverans.** Väntar vi till nästa beställningstillfälle kommer nästa
 *    leverans om intervall + ledtid dagar. Lagret måste alltså räcka
 *    efterfrågan under ledtid + intervall (prognosen, dag för dag) + säkerhetslager.
 * 3. **Säkerhetslager** = z × √((ledtid + intervall) × dagsvarians), där dagsvariansen kommer
 *    från prognosen (backtestens residualer, minst Poisson). z från servicenivån (95 % → 1,645).
 * 4. **Lagerposition** = centrallager + lager i automater + beställt som väntas inom ledtid +
 *    intervall. Negativa saldon räknas som 0. Beställt som kommer senare räknas inte.
 * 5. **Antal.** Saknas något: behov i hela pack (avrundat uppåt) → minst minsta order →
 *    uppåt till hela boxar (`packSize`). Exempel: saknas 13,2 pack, minsta order 24, box 12
 *    → 14 → 24 → 24 (2 boxar). Saknas 25 → 25 → 25 → 36 (3 boxar).
 *    Mystery packs (`TitleRef.mysteryBatchSize`) packas i hela omgångar: antalet avrundas
 *    uppåt till en multipel av omgången (saknas 5, omgång 14 → 14; saknas 15 → 28).
 *    **Delarna i mystery packs** (`PurchasingInput.mysteryRecipes`): omgångarna som ska
 *    packas × innehållet läggs på varje dels behov innan antalet räknas (2 omgångar med
 *    4 Pokémon 151 per omgång → 8 pack till på Pokémon 151). Se ./mystery-components.ts.
 * 6. **Täckning.** Dagar som lagerpositionen räcker enligt prognosen; senaste beställningsdag =
 *    väntat slut − ledtid. Tar lagret slut före leverans även vid beställning i dag är raden sen.
 */

import {
  addDays,
  assertIsoDate,
  ceilDiv,
  DomainError,
  mysteryBatch,
  mysteryBatchesToPack,
  roundHalfUp,
  wholeBatches,
  type IsoDate,
} from "@/domain";
import { assertIntAtLeast, fig, isqrtRound, MILLI, packs, planEvidence } from "../forecast/common";
import { nameLookup, titleNames } from "../todos/common";
import { day, kr, plural, sentence } from "../todos/text";
import {
  assertSupplierItem,
  chooseSupplierItem,
  coverDays,
  demandSum,
  leadTimeOf,
  onOrderByTitle,
  stockByTitle,
} from "./common";
import { componentNeeds, type MysteryNeed } from "./mystery-components";
import type {
  PurchaseLine,
  PurchaseLineStatus,
  PurchasePlan,
  PurchasingInput,
  PurchasingOptions,
  ProposedPurchaseOrder,
  SupplierItemRef,
  SupplierRef,
  TitleDemand,
} from "./types";

/** Standardvärden. */
export const PURCHASING_DEFAULTS = {
  reviewPeriodDays: 7,
  serviceLevelBp: 9_500,
  defaultLeadTimeDays: 7,
  includeDraftOrders: false,
} as const satisfies Required<PurchasingOptions>;

/** Ensidiga z-värden (i tusendelar) per servicenivå, normalfördelning. */
export const Z_BY_SERVICE_LEVEL_BP: Readonly<Record<number, number>> = {
  5_000: 0,
  8_000: 842,
  9_000: 1_282,
  9_500: 1_645,
  9_750: 1_960,
  9_800: 2_054,
  9_900: 2_326,
};

/** Standardvärden plus angivna inställningar, kontrollerade. */
export function resolvePurchasingOptions(options: PurchasingOptions = {}) {
  const o = {
    reviewPeriodDays: options.reviewPeriodDays ?? PURCHASING_DEFAULTS.reviewPeriodDays,
    serviceLevelBp: options.serviceLevelBp ?? PURCHASING_DEFAULTS.serviceLevelBp,
    defaultLeadTimeDays: options.defaultLeadTimeDays ?? PURCHASING_DEFAULTS.defaultLeadTimeDays,
    includeDraftOrders: options.includeDraftOrders ?? PURCHASING_DEFAULTS.includeDraftOrders,
  };
  assertIntAtLeast(o.reviewPeriodDays, 1, "Dagar mellan beställningar");
  assertIntAtLeast(o.defaultLeadTimeDays, 0, "Standardledtid");
  const zMilli = Z_BY_SERVICE_LEVEL_BP[o.serviceLevelBp];
  if (zMilli === undefined) {
    throw new DomainError(
      "invalid_input",
      `Servicenivån måste vara en av ${Object.keys(Z_BY_SERVICE_LEVEL_BP).join(", ")} bp, fick ${o.serviceLevelBp}.`,
    );
  }
  return { ...o, zMilli };
}

/**
 * Antal att beställa: behov i hela pack (uppåt) → minst `minOrderQty` → uppåt till hela
 * boxar om `packSize`. 0 om inget saknas.
 * orderQuantity(13_200, 24, 12) → { rawQty: 14, afterMinQty: 24, orderQty: 24 }
 */
export function orderQuantity(
  shortfallMilli: number,
  minOrderQty: number,
  packSize: number,
): { rawQty: number; afterMinQty: number; orderQty: number } {
  assertIntAtLeast(shortfallMilli, 0, "Det som saknas");
  assertIntAtLeast(minOrderQty, 0, "Minsta beställning");
  assertIntAtLeast(packSize, 1, "Pack per box");
  if (shortfallMilli === 0) return { rawQty: 0, afterMinQty: 0, orderQty: 0 };
  const rawQty = ceilDiv(shortfallMilli, MILLI);
  const afterMinQty = Math.max(rawQty, minOrderQty);
  const orderQty = ceilDiv(afterMinQty, packSize) * packSize;
  return { rawQty, afterMinQty, orderQty };
}

/**
 * Antalet att köpa in (eller packa, för egna produkter) för en titel: EN regel för Inköp
 * (/prognos) och Vårt lager, så att båda sidorna visar samma tal.
 *
 *   behov  = försäljning under ledtid + dagar till nästa beställning (prognos) + säkerhetslager
 *   saknas = behov − (vårt lager + automaterna + beställt som kommer i tid)
 *   antal  = saknas i hela pack → minst minsta order → uppåt till hela boxar (orderQuantity)
 *
 * Med leverantör ('order') är det det avrundade antalet ("Beställ 36 st"). Utan leverantör
 * ('no-supplier') finns ingen box: det som saknas i hela pack ("Köp ca 35 st"). Räcker
 * lagret, eller säljs titeln inte, är det 0.
 *
 * Mystery packs med `packNow` (omgångar räknade från facken): antalet att packa nu, i pack.
 */
export function purchaseQty(
  line: Pick<PurchaseLine, "status" | "orderQty" | "rawQty" | "packNow">,
): number {
  // Mystery pack med känt antal från facken: det som ska packas nu (samma som Mystery-sidan).
  if (line.packNow) return line.packNow.packs;
  if (line.status === "order") return line.orderQty;
  if (line.status === "no-supplier") return line.rawQty;
  return 0;
}

/** Ett antal omgångar som ett heltal ≥ 0 (saknas, minus och trasiga tal blir 0). */
function wholeBatchCount(n: number | null | undefined): number {
  return n === null || n === undefined || !Number.isFinite(n) ? 0 : Math.max(0, Math.trunc(n));
}

/** purchaseQty per titel i planen (bara titlar med antal > 0). */
export function purchaseQtyByTitle(plan: Pick<PurchasePlan, "lines">): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of plan.lines) {
    const q = purchaseQty(l);
    if (q > 0) out.set(l.titleId, q);
  }
  return out;
}

/** Säkerhetslager i tusendelar: z × √(dagar × dagsvarians). */
export function safetyStockMilli(zMilli: number, days: number, dayVarianceMilli2: number): number {
  assertIntAtLeast(dayVarianceMilli2, 0, "Dagsvariansen");
  return roundHalfUp(
    BigInt(zMilli) * isqrtRound(BigInt(days) * BigInt(dayVarianceMilli2)),
    BigInt(MILLI),
  );
}

const STATUS_ORDER: Record<PurchaseLineStatus, number> = {
  order: 0,
  "no-supplier": 1,
  ok: 2,
  "no-demand": 3,
};

/** Förslag på inköpsorder per titel och leverantör, med underlag. */
export function purchasePlan(input: PurchasingInput): PurchasePlan {
  assertIsoDate(input.today, "Dagen för planen");
  const o = resolvePurchasingOptions(input.options);
  const today = input.today;
  const titleName = titleNames(input.titles ?? []);
  const supplierName = nameLookup(input.suppliers);
  const suppliers = new Map<string, SupplierRef>(input.suppliers.map((s) => [s.id, s]));
  const itemsByTitle = new Map<string, SupplierItemRef[]>();
  for (const it of input.supplierItems) {
    assertSupplierItem(it);
    const list = itemsByTitle.get(it.titleId);
    if (list) list.push(it);
    else itemsByTitle.set(it.titleId, [it]);
  }
  const demand = new Map<string, TitleDemand>(input.demand.map((d) => [d.titleId, d]));
  const leadOf = (it: SupplierItemRef) => leadTimeOf(it, suppliers, o.defaultLeadTimeDays);
  const chosen = new Map<string, SupplierItemRef | null>();
  const choose = (titleId: string): SupplierItemRef | null => {
    if (!chosen.has(titleId)) {
      chosen.set(
        titleId,
        chooseSupplierItem(itemsByTitle.get(titleId) ?? [], (it) => leadOf(it).days),
      );
    }
    return chosen.get(titleId)!;
  };
  const leadFor = (titleId: string): number => {
    const it = choose(titleId);
    return it ? leadOf(it).days : o.defaultLeadTimeDays;
  };
  const onOrder = onOrderByTitle({
    orders: input.openPurchaseOrders,
    today,
    includeDrafts: o.includeDraftOrders,
    leadTimeFor: (supplierId, titleId) => {
      const it = (itemsByTitle.get(titleId) ?? []).find((x) => x.supplierId === supplierId);
      return it
        ? leadOf(it).days
        : (suppliers.get(supplierId)?.defaultLeadTimeDays ?? o.defaultLeadTimeDays);
    },
    countUntil: (titleId) => addDays(today, leadFor(titleId) + o.reviewPeriodDays - 1),
  });
  const stock = stockByTitle(input.warehouseStock, input.machineStock);
  const batchOf = new Map(
    (input.titles ?? []).flatMap((t) => {
      const b = mysteryBatch(t.mysteryBatchSize);
      return b === null ? [] : [[t.id, b] as const];
    }),
  );

  const lineOf = (titleId: string, mystery: MysteryNeed | null): PurchaseLine => {
    const item = choose(titleId);
    const lt = item ? leadOf(item) : { days: o.defaultLeadTimeDays, source: "default" as const };
    const L = lt.days;
    const R = o.reviewPeriodDays;
    const d = demand.get(titleId);
    const dL = demandSum(d, 0, L);
    const dP = demandSum(d, 0, L + R);
    const variance = d?.dayVarianceMilli2 ?? 0;
    const ss = safetyStockMilli(o.zMilli, L + R, variance);
    // Pack som går åt till mystery packs som ska packas (utöver titelns egen försäljning).
    const toMystery = mystery?.packs ?? 0;
    const target = dP + ss + toMystery * MILLI;
    const st = stock.get(titleId) ?? { warehouse: 0, machines: 0, negative: 0, machineIds: [] };
    const oo = onOrder.get(titleId) ?? [];
    const counted = oo.filter((x) => x.counted).reduce((s, x) => s + x.outstanding, 0);
    const later = oo.filter((x) => !x.counted).reduce((s, x) => s + x.outstanding, 0);
    const position = st.warehouse + st.machines + counted;
    const shortfall = Math.max(0, target - position * MILLI);
    const packSize = item?.packSize ?? 1;
    const minQty = item?.minOrderQty ?? 0;
    const base = orderQuantity(shortfall, minQty, packSize);
    // Mystery pack: hela omgångar (packas hemma, en omgång i taget).
    const batch = batchOf.get(titleId);
    const q =
      batch === undefined
        ? base
        : {
            rawQty: wholeBatches(base.rawQty, batch),
            afterMinQty: wholeBatches(base.afterMinQty, batch),
            orderQty: wholeBatches(base.orderQty, batch),
          };
    let status: PurchaseLineStatus;
    if (dP === 0 && toMystery === 0) status = "no-demand";
    else if (shortfall === 0) status = "ok";
    else if (!item) status = "no-supplier";
    else status = "order";
    const orderQty = status === "order" ? q.orderQty : 0;
    const unitCost = item?.unitCostOre ?? 0;
    const orderValue = orderQty * unitCost;
    const cover = coverDays(position, d);
    const projectedStockout = cover !== null && dP > 0 ? addDays(today, cover) : null;
    const orderByRaw = projectedStockout !== null ? addDays(projectedStockout, -L) : null;
    const orderBy = orderByRaw !== null && orderByRaw < today ? today : orderByRaw;
    const late = cover !== null && dP > 0 && cover < L;
    const expectedArrival = addDays(today, L);

    const tName = titleName(titleId);
    const sName = item ? supplierName(item.supplierId) : "";
    const boxes = orderQty / packSize;
    const leadText = `${plural(L, "dags", "dagars")} ledtid + ${plural(R, "dag", "dagar")} till nästa beställning`;
    const stockParts = [`vårt lager ${st.warehouse}`, `automater ${st.machines}`];
    if (counted > 0) stockParts.push(`beställt ${counted}`);
    const mysteryText =
      mystery && toMystery > 0
        ? ` + ${toMystery} pack till ${mystery.parts
            .map((m) => `${plural(m.batches, "omgång", "omgångar")} ${titleName(m.titleId)}`)
            .join(" och ")}`
        : "";
    const need =
      `Behov till nästa leverans ${packs(dP)} pack (${leadText}) + säkerhetslager ${packs(ss)}${mysteryText} = ${packs(target)}; ` +
      `lager ${position} (${stockParts.join(", ")})`;
    let text: string;
    if (status === "order") {
      text =
        `Beställ ${orderQty} pack ${tName} (${plural(boxes, "box", "boxar")} à ${packSize}) från ${sName} för ${kr(orderValue)}. ` +
        `${need}.`;
      if (orderQty !== q.rawQty) {
        const reasons: string[] = [];
        if (q.afterMinQty > q.rawQty) reasons.push(`minsta order ${minQty}`);
        if (orderQty > q.afterMinQty) reasons.push(`${packSize} per box`);
        text += ` Saknas ${q.rawQty}, avrundat till ${orderQty} (${reasons.join(", ")}).`;
      }
      if (late && projectedStockout !== null) {
        text += ` ${sentence(`Lagret väntas ta slut ${day(projectedStockout)}, före leveransen ${day(expectedArrival)}`)}`;
      }
    } else if (status === "no-supplier") {
      text = `${tName} behöver ${q.rawQty} pack men saknar leverantörsartikel. ${need}.`;
    } else if (status === "ok") {
      text =
        `${tName} räcker: ${position} pack i lager och beställt mot behovet ${packs(target)} t.o.m. nästa leverans` +
        (cover !== null ? ` (räcker ${plural(cover, "dag", "dagar")}).` : ".");
      if (orderBy !== null) text += ` ${sentence(`Beställ senast ${day(orderBy)}`)}`;
    } else {
      text = `${tName}: ingen väntad försäljning. ${position} pack i lager.`;
    }
    if (later > 0) text += ` ${later} beställda pack kommer senare och räknas inte.`;
    if (st.negative > 0)
      text += ` ${plural(st.negative, "lagerplats", "lagerplatser")} med negativt saldo räknas som 0.`;

    const evidence = planEvidence({
      rule:
        "Beställningsnivå = efterfrågan under ledtid + intervall (prognos) + säkerhetslager (z × √(dagar × dagsvarians)). " +
        "Saknas något jämfört med vårt lager + automater + beställt: hela pack → minsta order → hela boxar.",
      period: { start: today, end: addDays(today, L + R - 1) },
      titleIds: [titleId, ...(mystery?.parts.map((m) => m.titleId) ?? [])],
      machineIds: st.machineIds,
      dates: oo.map((x) => x.expectedOn),
      purchaseOrderIds: oo.map((x) => x.purchaseOrderId),
      supplierIds: [...(item ? [item.supplierId] : []), ...oo.map((x) => x.supplierId)],
      figures: [
        fig("leadTimeDays", "Ledtid", L, "days"),
        fig("reviewPeriodDays", "Dagar till nästa beställning", R, "days"),
        fig("demandLeadTimeMilli", "Efterfrågan under ledtiden", dL, "milli"),
        fig("demandProtectionMilli", "Efterfrågan under ledtid + intervall", dP, "milli"),
        fig("safetyStockMilli", "Säkerhetslager", ss, "milli"),
        ...(toMystery > 0
          ? [fig("mysteryNeedPacks", "Går till mystery packs", toMystery, "packs")]
          : []),
        fig("targetMilli", "Beställningsnivå", target, "milli"),
        fig("warehouseOnHand", "Vårt lager", st.warehouse, "packs"),
        fig("machineOnHand", "I automater", st.machines, "packs"),
        fig("onOrderCounted", "Beställt (räknas)", counted, "packs"),
        fig("onOrderLater", "Beställt (kommer senare, räknas inte)", later, "packs"),
        fig("shortfallMilli", "Saknas", shortfall, "milli"),
        fig("minOrderQty", "Minsta order", minQty, "packs"),
        fig("packSize", "Pack per box", packSize, "packs"),
        fig("orderQty", "Föreslaget antal", orderQty, "packs"),
        fig("unitCostOre", "Pris per pack", unitCost, "ore"),
        fig("orderValueOre", "Ordervärde", orderValue, "ore"),
      ],
    });

    return {
      titleId,
      status,
      supplierItemId: item?.id ?? null,
      supplierId: item?.supplierId ?? null,
      leadTimeDays: L,
      leadTimeSource: lt.source,
      reviewPeriodDays: R,
      demandLeadTimeMilli: dL,
      demandProtectionMilli: dP,
      safetyStockMilli: ss,
      targetMilli: target,
      warehouseOnHand: st.warehouse,
      machineOnHand: st.machines,
      onOrderCounted: counted,
      onOrderLater: later,
      onOrder: oo,
      positionPacks: position,
      shortfallMilli: shortfall,
      rawQty: q.rawQty,
      afterMinQty: q.afterMinQty,
      orderQty,
      packSize,
      boxes,
      minOrderQty: minQty,
      unitCostOre: unitCost,
      orderValueOre: orderValue,
      expectedArrival,
      coverDays: cover,
      projectedStockout,
      orderBy,
      late,
      text,
      evidence,
      ...(mystery && toMystery > 0 ? { mysteryNeed: mystery } : {}),
    };
  };

  // Mystery packen räknas först: omgångarna som ska packas × innehållet blir delarnas
  // extra behov. En del kan inte själv vara ett mystery pack (databasen stoppar det).
  const recipes = (input.mysteryRecipes ?? []).filter((r) => mysteryBatch(r.batchSize) !== null);
  const recipeSize = new Map(recipes.map((r) => [r.titleId, r.batchSize]));
  const mysteryLines = new Map<string, PurchaseLine>();
  const known = new Set([
    ...demand.keys(),
    ...stock.keys(),
    ...itemsByTitle.keys(),
    ...onOrder.keys(),
  ]);
  for (const r of recipes) {
    if (known.has(r.titleId) && !mysteryLines.has(r.titleId)) {
      mysteryLines.set(r.titleId, lineOf(r.titleId, null));
    }
  }
  const givenBatches = new Map((input.mysteryBatches ?? []).map((b) => [b.titleId, b.batches]));
  const fixPlaces = new Map(
    (input.mysteryBatches ?? []).flatMap((b) => (b.fixPlaceId ? [[b.titleId, b.fixPlaceId]] : [])),
  );
  const needs = componentNeeds(recipes, (mysteryId) => {
    const line = mysteryLines.get(mysteryId);
    // Planens antal i hela omgångar: täcker ledtid + dagar till nästa beställning.
    const planned = line
      ? (mysteryBatchesToPack({
          batchSize: recipeSize.get(mysteryId),
          planPacks: purchaseQty(line),
          packedAtHome: line.warehouseOnHand,
        })?.batches ?? 0)
      : 0;
    // Delarna köps för det största av planens antal och fackens (se PurchasingInput): fackens
    // tal ser bara 7 dagar fram och får aldrig sänka det som köps, bara höja det.
    return Math.max(planned, wholeBatchCount(givenBatches.get(mysteryId)));
  });
  // Raden för mystery packet visar fackens tal (det som ska packas nu), när det är känt.
  for (const [mysteryId, line] of [...mysteryLines]) {
    const given = givenBatches.get(mysteryId);
    const size = mysteryBatch(recipeSize.get(mysteryId));
    if (given === undefined || size === null) continue;
    const batches = wholeBatchCount(given);
    const fixPlaceId = fixPlaces.get(mysteryId);
    mysteryLines.set(mysteryId, {
      ...line,
      packNow: { batches, packs: batches * size, ...(fixPlaceId ? { fixPlaceId } : {}) },
    });
  }
  const titleIds = [...new Set([...known, ...needs.keys()])].sort();
  const lines: PurchaseLine[] = titleIds.map(
    (titleId) => mysteryLines.get(titleId) ?? lineOf(titleId, needs.get(titleId) ?? null),
  );

  lines.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.orderValueOre - a.orderValueOre ||
      (a.titleId < b.titleId ? -1 : a.titleId > b.titleId ? 1 : 0),
  );

  const bySupplier = new Map<string, PurchaseLine[]>();
  for (const l of lines) {
    if (l.status !== "order" || l.supplierId === null) continue;
    const list = bySupplier.get(l.supplierId);
    if (list) list.push(l);
    else bySupplier.set(l.supplierId, [l]);
  }
  const orders: ProposedPurchaseOrder[] = [...bySupplier.entries()]
    .map(([supplierId, ls]) => {
      const totalOre = ls.reduce((s, l) => s + l.orderValueOre, 0);
      const totalPacks = ls.reduce((s, l) => s + l.orderQty, 0);
      let arrival: IsoDate = today;
      for (const l of ls) if (l.expectedArrival > arrival) arrival = l.expectedArrival;
      return {
        supplierId,
        lines: ls,
        totalPacks,
        totalOre,
        expectedArrival: arrival,
        text:
          `Inköpsorder till ${supplierName(supplierId)}: ${plural(ls.length, "titel", "titlar")}, ` +
          `${totalPacks} pack för ${kr(totalOre)}. ${sentence(`Väntad leverans ${day(arrival)}`)}`,
        evidence: planEvidence({
          rule: "Summan av raderna för leverantören; varje rad har eget underlag.",
          period: { start: today, end: arrival },
          titleIds: ls.map((l) => l.titleId),
          supplierIds: [supplierId],
          purchaseOrderIds: ls.flatMap((l) => l.evidence.purchaseOrderIds ?? []),
          figures: [
            fig("lines", "Titlar", ls.length, "count"),
            fig("totalPacks", "Pack", totalPacks, "packs"),
            fig("totalOre", "Ordervärde", totalOre, "ore"),
          ],
        }),
      };
    })
    .sort((a, b) => b.totalOre - a.totalOre || (a.supplierId < b.supplierId ? -1 : 1));

  const totalOre = orders.reduce((s, x) => s + x.totalOre, 0);
  const orderLines = lines.filter((l) => l.status === "order").length;
  const missing = lines.filter((l) => l.status === "no-supplier").length;
  let text =
    orders.length === 0
      ? "Inga inköp behövs i dag."
      : `Föreslagna inköp: ${kr(totalOre)} hos ${plural(orders.length, "leverantör", "leverantörer")} (${plural(orderLines, "titel", "titlar")}).`;
  if (missing > 0)
    text += ` ${plural(missing, "titel", "titlar")} behöver köpas men saknar leverantörsartikel.`;
  return { today, lines, orders, totalOre, text };
}
