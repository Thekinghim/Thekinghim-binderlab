/**
 * Typer för inköpsplanering och lagervärde.
 *
 * Antal i hela pack (en order = ett pack), prognoser i tusendelar av pack ("milli"),
 * belopp i öre, andelar i bp. `packSize` är antal pack per box från leverantören.
 */

import type { IsoDate, MysteryRecipeRef, PurchasePrice } from "@/domain";
import type { PlanEvidence } from "../forecast/common";
import type { TitleRef } from "../todos/types";
import type { MysteryNeed } from "./mystery-components";

/** Leverantör (suppliers). */
export interface SupplierRef {
  readonly id: string;
  readonly name: string;
  readonly defaultLeadTimeDays: number | null;
}

/** Leverantörsartikel (supplier_items). */
export interface SupplierItemRef {
  readonly id: string;
  readonly supplierId: string;
  readonly titleId: string;
  /** Pack per box. Beställt antal avrundas uppåt till hela boxar. */
  readonly packSize: number;
  /** Minsta beställning i pack. */
  readonly minOrderQty: number;
  /** Ledtid i dagar. `null` = leverantörens standard. */
  readonly leadTimeDays: number | null;
  /** Inköpspris per pack. */
  readonly unitCostOre: number;
}

/** Status för en inköpsorder (purchase_orders.status). */
export type PurchaseOrderStatus =
  "draft" | "ordered" | "partially_received" | "received" | "cancelled";

/** Inköpsorder med rader. */
export interface PurchaseOrderRef {
  readonly id: string;
  readonly supplierId: string;
  readonly status: PurchaseOrderStatus;
  readonly orderedOn: IsoDate | null;
  readonly expectedOn: IsoDate | null;
  readonly lines: readonly {
    readonly id?: string;
    readonly titleId: string;
    readonly quantity: number;
    readonly receivedQuantity: number;
    readonly unitCostOre: number;
  }[];
}

/** Saldo i centrallagret. */
export interface WarehouseStockRef {
  readonly titleId: string;
  readonly onHand: number;
}

/** Saldo i en automat. */
export interface MachineStockRef {
  readonly machineId: string;
  readonly titleId: string;
  readonly onHand: number;
}

/**
 * Efterfrågan per titel. `dailyMilli[0]` är `today`. Är den kortare än vad planen behöver
 * upprepas den sista veckan (veckodagarna behålls).
 */
export interface TitleDemand {
  readonly titleId: string;
  readonly dailyMilli: readonly number[];
  /** Dagsvarians i milli² (från prognosen), för säkerhetslagret. */
  readonly dayVarianceMilli2: number;
}

/** Inställningar för inköpsplaneringen. Alla har standardvärden (`PURCHASING_DEFAULTS`). */
export interface PurchasingOptions {
  /** Dagar mellan beställningstillfällena. Standard 7. */
  readonly reviewPeriodDays?: number;
  /**
   * Servicenivå i bp: sannolikheten att lagret räcker till nästa leverans.
   * 5 000, 8 000, 9 000, 9 500, 9 750, 9 800 eller 9 900. Standard 9 500.
   */
  readonly serviceLevelBp?: number;
  /** Ledtid när varken artikeln eller leverantören har någon. Standard 7. */
  readonly defaultLeadTimeDays?: number;
  /** Räkna utkast (status 'draft') som beställt. Standard false. */
  readonly includeDraftOrders?: boolean;
}

/** Indata till `purchasePlan` och `inventoryValuation`. */
export interface PurchasingInput {
  /** Dagen planen görs (beställning läggs i dag). */
  readonly today: IsoDate;
  readonly titles?: readonly TitleRef[];
  readonly suppliers: readonly SupplierRef[];
  readonly supplierItems: readonly SupplierItemRef[];
  readonly warehouseStock: readonly WarehouseStockRef[];
  readonly machineStock: readonly MachineStockRef[];
  readonly openPurchaseOrders: readonly PurchaseOrderRef[];
  /** Inköpspriser (purchase_prices), för lagervärdet. */
  readonly prices?: readonly PurchasePrice[];
  readonly demand: readonly TitleDemand[];
  readonly options?: PurchasingOptions;
  /**
   * Gällande innehåll per mystery pack (delar och antal per omgång). Med dem läggs
   * omgångarna som ska packas × innehållet på varje dels behov. Utan: som förr.
   */
  readonly mysteryRecipes?: readonly MysteryRecipeRef[];
  /**
   * Omgångar att packa NU per mystery pack, räknat från facken (mysteryBatchesToPack med
   * fackens saldo: ett fack som är tomt eller blir tomt inom 7 dagar = en omgång). Samma tal
   * som Mystery-sidan visar ("Packa 1 omgång före fredag").
   *
   * Två saker händer med talet (runda 2, R2-9):
   * 1. Raden för mystery packet visar det (`PurchaseLine.packNow`, purchaseQty), så att
   *    Vårt lager, Inköp och delägarens inköpslista säger samma antal som Mystery-sidan.
   * 2. DELARNA köps för det STÖRSTA av talet och planens eget antal. Planens antal täcker
   *    ledtid + dagar till nästa beställning (ca 14 dagar); fackens tal bara 7 dagar. Delar
   *    tar ca 7 dagar att få hem, så med bara fackens tal skulle delarna till nästa veckas
   *    omgång beställas för sent. Fackens tal är ändå ett golv: en ny automat utan
   *    försäljning ger 0 i planen men 1 omgång från facket.
   * Saknas en titel här används planens antal till båda.
   */
  readonly mysteryBatches?: readonly { readonly titleId: string; readonly batches: number }[];
}

/** Redan beställt för en titel. */
export interface OnOrderLine {
  readonly purchaseOrderId: string;
  readonly supplierId: string;
  readonly status: PurchaseOrderStatus;
  /** Kvar att ta emot. */
  readonly outstanding: number;
  readonly unitCostOre: number;
  /** Väntad leverans: `expectedOn`, annars beställd + ledtid, annars i dag + ledtid. */
  readonly expectedOn: IsoDate;
  /** Väntad leverans har passerat. */
  readonly overdue: boolean;
  /** Kommer inom ledtid + intervall och räknas därför i lagerpositionen. */
  readonly counted: boolean;
}

/** Status för en titel i planen. */
export type PurchaseLineStatus = "order" | "ok" | "no-supplier" | "no-demand";

/** Förslag för en titel. */
export interface PurchaseLine {
  readonly titleId: string;
  readonly status: PurchaseLineStatus;
  /** Vald leverantörsartikel (billigast per pack, sedan kortast ledtid). */
  readonly supplierItemId: string | null;
  readonly supplierId: string | null;
  readonly leadTimeDays: number;
  readonly leadTimeSource: "item" | "supplier" | "default";
  readonly reviewPeriodDays: number;
  /** Efterfrågan under ledtiden, i tusendelar. */
  readonly demandLeadTimeMilli: number;
  /** Efterfrågan under ledtid + intervall, i tusendelar. */
  readonly demandProtectionMilli: number;
  /** Säkerhetslager = z × √((ledtid + intervall) × dagsvarians), i tusendelar. */
  readonly safetyStockMilli: number;
  /** Beställningsnivå = efterfrågan under ledtid + intervall + säkerhetslager. */
  readonly targetMilli: number;
  readonly warehouseOnHand: number;
  readonly machineOnHand: number;
  /** Beställt som räknas (kommer inom ledtid + intervall). */
  readonly onOrderCounted: number;
  /** Beställt som kommer senare och inte räknas. */
  readonly onOrderLater: number;
  readonly onOrder: readonly OnOrderLine[];
  /** Lagerposition = centrallager + automater + beställt som räknas (negativa saldon räknas som 0). */
  readonly positionPacks: number;
  /** Saknas till beställningsnivån, i tusendelar (0 om inget saknas). */
  readonly shortfallMilli: number;
  /** Steg för steg: behov i hela pack → minsta order → hela boxar. */
  readonly rawQty: number;
  readonly afterMinQty: number;
  /** Föreslaget antal pack (multipel av `packSize`). */
  readonly orderQty: number;
  readonly packSize: number;
  readonly boxes: number;
  readonly minOrderQty: number;
  readonly unitCostOre: number;
  readonly orderValueOre: number;
  /** Väntad leverans om beställningen läggs i dag. */
  readonly expectedArrival: IsoDate;
  /** Hela dagar som lagerpositionen räcker (`null` = mer än ett år eller ingen efterfrågan). */
  readonly coverDays: number | null;
  /** Väntat slut på lagret utan ny beställning. */
  readonly projectedStockout: IsoDate | null;
  /** Senaste dag att beställa för att hinna få leverans innan lagret tar slut. */
  readonly orderBy: IsoDate | null;
  /** Lagret tar slut före leverans även om beställningen läggs i dag. */
  readonly late: boolean;
  readonly text: string;
  readonly evidence: PlanEvidence;
  /**
   * Titeln är en del i mystery packs som ska packas: pack som går åt till dem. De ingår i
   * `targetMilli` och därmed i antalet att köpa. Saknas när inget går dit.
   */
  readonly mysteryNeed?: MysteryNeed;
  /**
   * Bara mystery packs, när fackens tal är känt (PurchasingInput.mysteryBatches): omgångar
   * och pack att packa nu. purchaseQty() ger då `packs` i stället för planens antal.
   */
  readonly packNow?: { readonly batches: number; readonly packs: number };
}

/** Förslag på inköpsorder till en leverantör. */
export interface ProposedPurchaseOrder {
  readonly supplierId: string;
  readonly lines: readonly PurchaseLine[];
  readonly totalPacks: number;
  readonly totalOre: number;
  readonly expectedArrival: IsoDate;
  readonly text: string;
  readonly evidence: PlanEvidence;
}

/** Resultatet av `purchasePlan`. */
export interface PurchasePlan {
  readonly today: IsoDate;
  readonly lines: readonly PurchaseLine[];
  readonly orders: readonly ProposedPurchaseOrder[];
  readonly totalOre: number;
  readonly text: string;
}

/** Lagervärde och kapitalbindning för en titel. */
export interface TitleInventoryValue {
  readonly titleId: string;
  readonly warehouseOnHand: number;
  readonly machineOnHand: number;
  readonly onHand: number;
  /** Inköpspriset per pack som gäller i dag. */
  readonly unitCostOre: number | null;
  readonly costSource: "purchase-price" | "supplier-item" | "none";
  readonly warehouseValueOre: number;
  readonly machineValueOre: number;
  readonly valueOre: number;
  /** Beställt men inte mottaget: antal och värde (radens pris). */
  readonly onOrderPacks: number;
  readonly onOrderValueOre: number;
  /** Kapitalbindning = lagervärde + beställt. */
  readonly capitalTiedOre: number;
  /** Andel av det totala lagervärdet, i bp. */
  readonly shareBp: number | null;
  /** Efterfrågan per dag (snitt av de första 28 dagarna), i tusendelar. */
  readonly demandPerDayMilli: number;
  /** Hela dagar som lagret (utan beställt) räcker. `null` = ingen efterfrågan eller över ett år. */
  readonly coverDays: number | null;
  /** Saldon under 0 som räknats som 0 (lagerplatser). */
  readonly negativeStockLocations: number;
  readonly text: string;
  readonly evidence: PlanEvidence;
}

/** Resultatet av `inventoryValuation`. */
export interface InventoryValuation {
  readonly today: IsoDate;
  readonly titles: readonly TitleInventoryValue[];
  readonly valueOre: number;
  readonly warehouseValueOre: number;
  readonly machineValueOre: number;
  readonly onOrderValueOre: number;
  readonly capitalTiedOre: number;
  /** Titlar med lager men utan inköpspris (värdet räknas inte). */
  readonly titlesWithoutCost: readonly string[];
  readonly text: string;
  readonly evidence: PlanEvidence;
}
