/**
 * Månadens siffror för bokföringen, ur bokföringsrapporten (@/reports buildAccountantReport,
 * samma orderliggare som resten av appen) och inköpen. Rena funktioner, belopp i öre.
 *
 * Butikernas andel är butiksersättningen enligt avtalen: vinstdelning (50/50 av vinsten efter
 * kostnader, avtal med commission_base 'profit_after_costs') när den finns i liggaren, annars
 * provision, plus hyra.
 *
 *   Försäljning (netto) = försäljning inkl. moms − återbetalningar till kunder
 *   Resultat = försäljning (netto) − VMB-moms − inköp − kortavgifter − butikernas andel
 *
 * VMB räknas bara när "VMB i bokföringen" är på (bookkeeping_settings.vmb_enabled, standard
 * av). Av: VMB-momsen är 0, inget underskott förs vidare och resultatet är försäljning −
 * inköp − kortavgifter − butikernas andel. En skickad månad behåller valet den skickades med.
 *
 * Bokföringen förutsätter momssats 0 i Inställningar, med eller utan VMB: med VMB skulle
 * utgående moms räknas två gånger, utan VMB skulle momsen bokas som försäljning.
 */

import type { AccountantReport } from "@/reports";

import { vmbChain, type VmbResult } from "./vmb";

/** Momssatsen i Inställningar är inte 0: bokföringen räknar bara med momssats 0 (se filhuvudet). */
export class VmbVatRateError extends Error {
  constructor() {
    super("Bokföringen kräver momssats 0 i Inställningar.");
    this.name = "VmbVatRateError";
  }
}

export type PurchaseBasis = "received_purchases" | "cost_of_goods";

export const PURCHASE_BASIS_LABEL: Record<PurchaseBasis, string> = {
  received_purchases: "Mottagna inköp i månaden",
  cost_of_goods: "Inköpsvärde sålda pack",
};

export interface StoreShare {
  readonly storeId: string | null;
  readonly name: string;
  readonly orders: number;
  readonly salesInclVatOre: number;
  /** Vinstandel eller provision. */
  readonly shareOre: number;
  readonly rentOre: number;
  /** Andel + hyra. */
  readonly totalOre: number;
  /**
   * Vinstdelning enligt avtalet (null = provision eller ingen andel): om VMB-momsen drogs före
   * delningen och hur mycket som drogs i butikens delning.
   */
  readonly split?: { readonly vmbBeforeSplit: boolean; readonly vmbVatOre: number } | null;
}

export interface MonthDay {
  readonly date: string;
  readonly orders: number;
  readonly salesInclVatOre: number;
}

export interface MonthFigures {
  readonly month: string;
  readonly orders: number;
  /** Försäljning inkl. moms (brutto, före återbetalningar). */
  readonly salesInclVatOre: number;
  /** Återbetalningar till kunder i månaden (≥ 0). */
  readonly refundsOre: number;
  readonly cardFeesOre: number;
  /** Inköp enligt valt underlag (VMB). */
  readonly purchasesOre: number;
  readonly purchaseBasis: PurchaseBasis;
  readonly costOfGoodsOre: number;
  readonly receivedPurchasesOre: number;
  readonly unpricedOrders: number;
  /**
   * Order hos butiker med vinstdelning som saknar inköpspris: butikernas andel är inte
   * färdigräknad och månaden ska inte bokföras förrän priserna finns.
   */
  readonly profitSplitUnpricedOrders: number;
  readonly stores: readonly StoreShare[];
  /** Σ butikernas andel + hyra. */
  readonly storeShareOre: number;
  readonly days: readonly MonthDay[];
}

export interface MonthBook extends MonthFigures {
  /** VMB i bokföringen för månaden (av = ingen VMB-moms och inget underskott). */
  readonly vmbEnabled: boolean;
  /** VMB-uträkningen; allt 0 utom försäljning, inköp och marginal när VMB är av. */
  readonly vmb: VmbResult;
  readonly resultOre: number;
}

/** VMB per månad: samma för alla, eller per månad ("ÅÅÅÅ-MM"). */
export type VmbChoice = boolean | ((month: string) => boolean);

export function monthFiguresFromReport(
  month: string,
  report: AccountantReport,
  receivedPurchasesOre: number,
  basis: PurchaseBasis,
  refundsOre = 0,
): MonthFigures {
  // Momssats 0 krävs med och utan VMB (se filhuvudet).
  if (report.vatRateBp !== 0) throw new VmbVatRateError();
  if (!Number.isSafeInteger(refundsOre) || refundsOre < 0) {
    throw new RangeError("Återbetalningarna ska vara ett heltal ≥ 0 i öre.");
  }
  const t = report.totals;
  const stores = report.stores
    .filter((s) => s.kind === "store" && (s.compensationOre !== 0 || s.orders > 0))
    .map((s): StoreShare => ({
      storeId: s.storeId,
      name: s.name,
      orders: s.orders,
      salesInclVatOre: s.grossOre,
      shareOre: s.commissionOre,
      rentOre: s.rentOre,
      totalOre: s.compensationOre,
      split: s.split ?? null,
    }))
    .sort((a, b) => b.totalOre - a.totalOre || a.name.localeCompare(b.name, "sv"));
  return {
    month,
    orders: t.orders,
    salesInclVatOre: t.grossOre,
    refundsOre,
    cardFeesOre: t.feesOre,
    purchasesOre: basis === "cost_of_goods" ? t.costOre : receivedPurchasesOre,
    purchaseBasis: basis,
    costOfGoodsOre: t.costOre,
    receivedPurchasesOre,
    unpricedOrders: t.unpricedOrders,
    profitSplitUnpricedOrders: report.profitSplitUnpricedOrders ?? 0,
    stores,
    storeShareOre: stores.reduce((s, x) => s + x.totalOre, 0),
    days: report.days
      .filter((d) => d.orders !== 0 || d.grossOre !== 0)
      .map((d) => ({ date: d.date, orders: d.orders, salesInclVatOre: d.grossOre })),
  };
}

/** Försäljningen efter återbetalningar (underlaget för VMB och resultatet). */
export function netSales(f: Pick<MonthFigures, "salesInclVatOre" | "refundsOre">): number {
  return f.salesInclVatOre - f.refundsOre;
}

/** Resultatet för månaden (se filhuvudet). */
export function monthResult(f: MonthFigures, vatOre: number): number {
  return netSales(f) - vatOre - f.purchasesOre - f.cardFeesOre - f.storeShareOre;
}

/** VMB-raden för en månad utan VMB: ingen moms, inget underskott in eller ut. */
function noVmb(f: MonthFigures): VmbResult {
  const salesInclVatOre = netSales(f);
  return {
    salesInclVatOre,
    purchasesOre: f.purchasesOre,
    carryInOre: 0,
    marginOre: salesInclVatOre - f.purchasesOre,
    vatOre: 0,
    baseOre: 0,
    carryOutOre: 0,
  };
}

/**
 * Månaderna med resultat och (när VMB är på) VMB, underskottet fört vidare från den äldsta.
 * En skickad månads underskott (`sentCarryOut`) gäller för nästa månad. En månad utan VMB
 * för inte något underskott vidare. `vmb` är "VMB i bokföringen" (standard av).
 */
export function bookMonths(
  figures: readonly MonthFigures[],
  openingCarryOre: number,
  sentCarryOut: ReadonlyMap<string, number> = new Map(),
  vmb: VmbChoice = false,
): MonthBook[] {
  const on = (month: string) => (typeof vmb === "function" ? vmb(month) : vmb);
  const chain = vmbChain(
    figures.map((f) => ({
      month: f.month,
      salesInclVatOre: netSales(f),
      purchasesOre: f.purchasesOre,
      fixedCarryOutOre: on(f.month) ? (sentCarryOut.get(f.month) ?? null) : 0,
    })),
    openingCarryOre,
  );
  return figures.map((f) => {
    const vmbEnabled = on(f.month);
    const r = vmbEnabled ? chain.get(f.month)! : noVmb(f);
    return { ...f, vmbEnabled, vmb: r, resultOre: monthResult(f, r.vatOre) };
  });
}
