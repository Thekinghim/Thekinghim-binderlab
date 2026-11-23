/**
 * Typerna som orderlistan skickar mellan server och klient. Belopp i öre, tidpunkter som
 * ISO 8601 (Z), affärsdatum 'ÅÅÅÅ-MM-DD' i organisationens tidszon.
 */

import type { IsoDate, Period } from "@/domain";
import type { MachineLook } from "@/lib/machine-look";

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
  /** Markerad som testköp: står i listan men räknas inte i antal och summa. */
  readonly testPurchase: boolean;
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
  /** Utseende (machines.appearance, läses bara): automatens bild i listan. */
  readonly appearance: MachineLook;
}

export interface StoreOption {
  readonly id: string;
  readonly name: string;
  /** Butikstyp (fritext) och ort, för butikssymbolen. Utelämnat = okänt. */
  readonly storeType?: string | null;
  readonly city?: string | null;
}

/** Antal och summa (utan testköp) för en affärsdag, för listans dagsrubriker. */
export interface OrderDayTotal {
  readonly date: IsoDate;
  readonly count: number;
  readonly amountOre: number;
}

/** Namn att slå upp radernas id i. */
export interface OrderRefs {
  readonly titles: readonly TitleOption[];
  readonly machines: readonly MachineOption[];
  readonly stores: readonly StoreOption[];
}

/** Antal och summa för det som matchar filtret (utan testköp). */
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
  /** Snittorder (nettointäkt per order, @/domain averageOrderValueOre), öre, eller null. */
  readonly averageOrderValueOre: number | null;
  /** Organisationen har minst en order (oavsett filter och period). */
  readonly hasOrders: boolean;
  /** Senaste ordern som matchar filtret, utan periodgräns (ISO), eller null. */
  readonly latestOrderAt: string | null;
  /** Första affärsdagen med en order som matchar filtret, utan periodgräns, eller null. */
  readonly firstOrderDate: IsoDate | null;
  /** Första raderna i vald sortering. */
  readonly rows: readonly OrderRow[];
  /** Offset för nästa sida, eller null när allt är laddat. */
  readonly nextOffset: number | null;
  readonly refs: OrderRefs;
  /** Antal och summa per dag i perioden (nyaste först), för dagsrubrikerna. */
  readonly days: readonly OrderDayTotal[];
  /** De mest sålda titlarna i urvalet (utan titelfiltret), för titelchipsen. */
  readonly topTitleIds: readonly string[];
}

export interface OrderPage {
  readonly rows: readonly OrderRow[];
  readonly nextOffset: number | null;
}

/** Var nästa sida börjar: offset, och i tidsordning även sista radens id (markör). */
export interface OrderPageStart {
  readonly offset: number;
  readonly afterId: string | null;
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
  /** Orderns månad är stängd nu: testköp kan inte ändras (saknas = öppen). */
  readonly monthClosed?: boolean;
  readonly createdAt: string;
  /** Markerad som testköp: när (ISO) och av vem (namn, om det finns), annars null. */
  readonly testPurchase: { readonly at: string; readonly by: string | null } | null;
}
