/**
 * Typer för Prognos & inköp på servern: leverantörer, leverantörsartiklar och
 * inköpsorder som de läses ur databasen, plus sidans samlade indata.
 *
 * Konventioner som i src/domain: belopp i öre (heltal), affärsdatum 'ÅÅÅÅ-MM-DD' i
 * organisationens tidszon. Alla typer är serialiserbara (kan skickas till klienten).
 */

import type { ForecastResult } from "@/analytics/forecast/types";
import type { LostSalesResult } from "@/analytics/lost-sales/types";
import type {
  InventoryValuation,
  PurchaseOrderStatus,
  PurchasePlan,
} from "@/analytics/purchasing/types";
import type { IsoDate, Period } from "@/domain";
import type { DataScope } from "@/server/data/core/types";

export type { PurchaseOrderStatus };

/** Leverantör (suppliers). */
export interface SupplierRecord {
  readonly id: string;
  readonly name: string;
  readonly contactName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly defaultLeadTimeDays: number | null;
  readonly archived: boolean;
}

/** Leverantörsartikel (supplier_items). */
export interface SupplierItemRecord {
  readonly id: string;
  readonly supplierId: string;
  readonly titleId: string;
  readonly packSize: number;
  readonly minOrderQty: number;
  readonly leadTimeDays: number | null;
  readonly unitCostOre: number;
}

/** Rad i en inköpsorder. */
export interface PurchaseOrderLineRecord {
  readonly id: string;
  readonly titleId: string;
  readonly quantity: number;
  readonly unitCostOre: number;
  readonly receivedQuantity: number;
}

/** Inköpsorder med rader. */
export interface PurchaseOrderRecord {
  readonly id: string;
  readonly supplierId: string;
  readonly status: PurchaseOrderStatus;
  readonly orderedOn: IsoDate | null;
  readonly expectedOn: IsoDate | null;
  readonly receivedOn: IsoDate | null;
  readonly note: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly lines: readonly PurchaseOrderLineRecord[];
}

/** Veckosumma ur utfallet (order), för prognosdiagrammets historik. */
export interface HistoryWeek {
  readonly period: Period;
  /** Sålda pack (en order = ett pack). */
  readonly units: number;
  /** Intäkt exkl. moms (src/domain revenue). */
  readonly revenueOre: number;
}

/** Allt sidan Prognos & inköp behöver, räknat på servern. */
export interface PrognosData {
  /** Dagens affärsdatum. Prognosen börjar i dag. */
  readonly today: IsoDate;
  /** Sista hela dag med data (i går). */
  readonly asOf: IsoDate;
  /** Historiken som prognosen anpassas på (8 veckor t.o.m. `asOf`), för länkar till orderna. */
  readonly forecastHistory: Period;
  /**
   * Underlaget för efterfrågan per titel i inköpsplanen (hela organisationen): antal serier
   * (automater) och hur många av dem som har lite data, med deras andel av prognosen.
   */
  readonly demandBasis: readonly {
    readonly titleId: string;
    readonly series: number;
    readonly lowDataSeries: number;
    readonly lowDataUnitsMilli: number;
    readonly unitsMilli: number;
  }[];
  /** Perioden som förlorad försäljning räknas för (periodvalet, högst t.o.m. i går). */
  readonly lostPeriod: Period;
  readonly scope: DataScope;
  readonly canEdit: boolean;
  readonly titles: readonly { readonly id: string; readonly name: string }[];
  readonly machines: readonly {
    readonly id: string;
    readonly name: string;
    readonly code: string;
  }[];
  readonly lostSales: LostSalesResult;
  /** Prognosen för filtret (butik/automat). */
  readonly forecast: ForecastResult;
  /** Utfall per vecka före prognosen (samma veckor som backtesten). */
  readonly history: readonly HistoryWeek[];
  /** Inköpsplanen (hela organisationen: centrallagret är gemensamt). */
  readonly plan: PurchasePlan;
  readonly valuation: InventoryValuation;
  readonly suppliers: readonly SupplierRecord[];
  readonly supplierItems: readonly SupplierItemRecord[];
  readonly purchaseOrders: readonly PurchaseOrderRecord[];
  /** Centrallagret finns (krävs för mottagning). */
  readonly hasCentralWarehouse: boolean;
}

/** Nyckeltalet för Hem och prioriteringen i Att göra. */
export interface LostSalesSummary {
  readonly period: Period;
  /** Förlorad intäkt exkl. moms i perioden. */
  readonly lostRevenueOre: number;
  /** Förlorat bruttoresultat (intäkt − inköp) för perioder med inköpspris. */
  readonly lostGrossProfitOre: number;
  /** Förlorade pack, i tusendelar. */
  readonly lostUnitsMilli: number;
  /** Slutsålda dagar, summerad vikt i bp (10 000 = en dag). */
  readonly stockoutDayWeightBp: number;
  /** T.ex. "Slutsålt kostade ca 3 200 kr i oktober." (eller för perioden). */
  readonly text: string;
  /** Per månad, med analytics egna texter. */
  readonly months: readonly {
    readonly month: string;
    readonly lostRevenueOre: number;
    readonly partial: boolean;
    readonly text: string;
  }[];
  /**
   * Per titel × automat, största först. `key` = 'refill:<automat>:<titel>', samma nyckel
   * som påfyllningspunkterna i Att göra.
   */
  readonly series: readonly {
    readonly key: string;
    readonly machineId: string;
    readonly titleId: string;
    readonly lostRevenueOre: number;
    readonly lostUnitsMilli: number;
    /** Slutsålt nu (perioden pågår vid periodens slut). */
    readonly ongoing: boolean;
    /** Senaste slutsålda periodens första dag. */
    readonly since: IsoDate;
  }[];
  /** Filtret siffran gäller (null = hela organisationen). */
  readonly scope: DataScope;
  /** Länk till underlaget: sektionen Förlorad försäljning med samma period och filter. */
  readonly href: string;
}
