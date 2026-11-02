/**
 * Typerna som orderlistan skickar mellan server och klient. Belopp i öre, tidpunkter som
 * ISO 8601 (Z), affärsdatum 'ÅÅÅÅ-MM-DD' i organisationens tidszon.
 */

import type { IsoDate, Period } from "@/domain";

/** En rad i listan. Namnen slås upp i OrderRefs (raden bär bara id). */
export interface OrderRow {
  readonly id: string;
  /** Ordernumret i källan (Awish "Order No."). */
  readonly externalId: string;
  readonly orderedAt: string;
  readonly businessDate: IsoDate;
  readonly titleId: string | null;
  /** Originaltiteln, bara när ordern saknar tolkad titel (annars null, den finns i detaljvyn). */
  readonly rawTitle: string | null;
  readonly machineId: string | null;
  /** Butiken där automaten stod orderns dag (placeringen), eller null. */
  readonly storeId: string | null;
  readonly amountOre: number;
}

export interface TitleOption {
  readonly id: string;
  readonly name: string;
  /** Arkiverad eller sammanslagen. */
  readonly archived: boolean;
}

export interface MachineOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface StoreOption {
  readonly id: string;
  readonly name: string;
}

/** Namn att slå upp radernas id i. */
export interface OrderRefs {
  readonly titles: readonly TitleOption[];
  readonly machines: readonly MachineOption[];
  readonly stores: readonly StoreOption[];
}

/** Antal och summa för det som matchar filtret. */
export interface OrderTotals {
  readonly count: number;
  /** Summa betalt belopp (inkl. moms), öre. */
  readonly amountOre: number;
}

export interface OrderList {
  readonly period: Period;
  readonly compare: Period | null;
  /** Det som matchar filtret i perioden. */
  readonly totals: OrderTotals;
  /** Samma filter i jämförelseperioden, eller null. */
  readonly compareTotals: OrderTotals | null;
  /** Senaste ordern i organisationen (oavsett filter), ISO, eller null. */
  readonly latestOrderAt: string | null;
  /** Första raderna i vald sortering. */
  readonly rows: readonly OrderRow[];
  /** Offset för nästa sida, eller null när allt är laddat. */
  readonly nextOffset: number | null;
  readonly refs: OrderRefs;
}

export interface OrderPage {
  readonly rows: readonly OrderRow[];
  readonly nextOffset: number | null;
}

/** Allt om en order, för detaljvyn. */
export interface OrderDetail {
  readonly id: string;
  readonly externalId: string;
  readonly orderedAt: string;
  readonly businessDate: IsoDate;
  readonly amountOre: number;
  readonly paymentMethod: string | null;
  /** Originaltiteln i källan, ändras aldrig. */
  readonly rawTitle: string;
  /** Den tolkade titeln, eller null. */
  readonly title: {
    readonly id: string;
    readonly name: string;
    readonly series: string | null;
  } | null;
  readonly machine: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly store: { readonly id: string; readonly name: string } | null;
  /** Automaten som källan namnger den ("Order Machine"). */
  readonly sourceMachine: {
    readonly externalId: string;
    readonly externalName: string | null;
    readonly deviceNo: string | null;
  } | null;
  readonly dataSource: { readonly id: string; readonly name: string; readonly provider: string };
  readonly import: {
    readonly id: string;
    readonly fileName: string | null;
    readonly trigger: string;
    readonly at: string;
    /** Radnumret i filen, om raden finns kvar i importloggen. */
    readonly rowNumber: number | null;
  } | null;
  /** Importerad till en redan stängd månad. */
  readonly lateInClosedPeriod: boolean;
  readonly createdAt: string;
}
