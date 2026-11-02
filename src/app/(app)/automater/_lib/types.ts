/**
 * Vymodeller för Automater (lista och detaljvy). Rena data, säkra att skicka till
 * klienten: belopp i öre, affärsdatum 'ÅÅÅÅ-MM-DD', tidpunkter ISO 8601 (Z).
 * Sidan är bara till för roller som ser ekonomi (ägare, admin, läsare); påfyllaren
 * skickas vidare av requireRoute innan något av detta byggs.
 */

import type { HealthStatus } from "@/analytics/health";
import type { IsoDate } from "@/domain";

/** Automatens läge i registret (active_from / active_to mot i dag). */
export type MachineLifecycle = "active" | "planned" | "decommissioned";

/** Statusetikettens form (samma som StatusTag). */
export type TagStatus = "ok" | "warning" | "critical" | "offline" | "neutral";

/** Status att visa: form, text och om den kräver åtgärd. */
export interface MachineStatusView {
  readonly status: TagStatus;
  readonly label: string;
  /** Kräver åtgärd (räknas i signalbudgeten). */
  readonly flagged: boolean;
  /** Hälsans status från @/analytics/health, eller null om automaten inte är i drift. */
  readonly health: HealthStatus | null;
  /** En mening om varför, t.ex. "Black Bolt är slut." eller hälsans detaljtext. */
  readonly reason: string | null;
}

/** En rad i listan över automater. */
export interface MachineListRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly href: string;
  readonly lifecycle: MachineLifecycle;
  readonly activeFrom: IsoDate | null;
  readonly activeTo: IsoDate | null;
  readonly storeId: string | null;
  readonly storeName: string | null;
  /** Första dagen i nuvarande placering. */
  readonly storeSince: IsoDate | null;
  readonly status: MachineStatusView;
  /** Nettointäkt, alla order (även utan inköpspris). */
  readonly revenueOre: number;
  /** Vinst för prissatta order (beräkningslagret). */
  readonly profitOre: number;
  readonly marginBp: number | null;
  readonly orders: number;
  /** Intäktens förändring mot jämförelseperioden som andel (0,12 = +12 %), eller null. */
  readonly revenueChange: number | null;
  /** Andel av periodens totala intäkt (0–1). */
  readonly revenueShare: number;
  readonly topTitle: { readonly name: string; readonly orders: number } | null;
  /** Titlar som behöver fyllas på nu / snart (Att göra-regeln). */
  readonly refillNow: number;
  readonly refillSoon: number;
  /** Pack i automaten just nu. */
  readonly packsOnHand: number;
  /** Senaste ordern (ISO 8601), oavsett period. */
  readonly lastOrderAt: string | null;
}

/** En rad utanför automaterna i listans summa (ej fördelad hyra, order utan automat). */
export interface OtherRow {
  readonly key: string;
  readonly label: string;
  readonly revenueOre: number;
  readonly profitOre: number;
  readonly orders: number;
}

/** Order utan inköpspris: står utanför vinsten (berakningar.md avsnitt 5). */
export interface UnpricedView {
  readonly orders: number;
  /** Nettointäkt för orderna utan pris. */
  readonly revenueOre: number;
  /** Andel av intäkten i bp. */
  readonly shareBp: number;
  /** Titlarna, störst intäkt först. */
  readonly titles: string[];
  /** Dit inköpspriset läggs in. */
  readonly href: string;
  /**
   * Butikshyran på orderna (för en automat): dras från organisationens vinst som ej
   * fördelad hyra, inte från automatens. 0 när den inte är aktuell.
   */
  readonly rentOre: number;
}

/** Rubrik och nyckeltal för listan. */
export interface MachinesOverview {
  readonly rows: MachineListRow[];
  /** Rader utanför automaterna; raderna + dessa = totals. */
  readonly others: OtherRow[];
  readonly unpriced: UnpricedView | null;
  readonly totals: {
    readonly revenueOre: number;
    readonly profitOre: number;
    readonly marginBp: number | null;
    readonly orders: number;
    /** Intäkt per automatdag (dagar i butik med data), i öre. */
    readonly revenuePerMachineDayOre: number | null;
    readonly revenueChange: number | null;
    readonly profitChange: number | null;
    readonly ordersChange: number | null;
    /** Jämförelseperiodens marginal (för marginalens förändring), eller null. */
    readonly previousMarginBp: number | null;
    readonly activeMachines: number;
  };
  readonly headline: { readonly title: string; readonly aside: string };
  /** Antal rader som kräver åtgärd. */
  readonly flagged: number;
}

/** Ett nyckeltal i detaljvyn (formateras på klienten efter `kind`). */
export interface KpiView {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly kind: "sek" | "int" | "percent" | "months";
  /** Förändring som andel (relativ) eller i procentenheter (absolut, för marginal). */
  readonly delta: { readonly value: number; readonly kind: "relative" | "absolute" } | null;
  readonly primary?: boolean;
  readonly trend?: readonly number[];
}

/** Dagsserie för diagrammet. */
export interface DailyPoint {
  readonly date: IsoDate;
  /** Nettointäkt i kronor (diagrammet ritar kronor). */
  readonly value: number;
}

export interface TitleShare {
  readonly titleId: string;
  readonly name: string;
  readonly orders: number;
  readonly revenueOre: number;
  /** Andel av automatens intäkt (0–1). */
  readonly share: number;
}

export interface HeatmapView {
  /** values[veckodag 0 = mån][kolumn] = antal köp. */
  readonly values: number[][];
  /** Heltalsgränser för stegen (heatThresholds). */
  readonly thresholds: number[];
  readonly rowLabels: string[];
  /** Klockslag "08", "09" … */
  readonly colLabels: string[];
  /** Första timmen i kolumnerna (0–23). */
  readonly firstHour: number;
  readonly total: number;
  readonly peak: { readonly weekday: number; readonly hour: number; readonly count: number } | null;
}

/** En titel i automatens lager. */
export interface StockLine {
  readonly titleId: string;
  readonly name: string;
  readonly onHand: number;
  /** Sålda pack per dag (14 hela dagar t.o.m. i går), eller null utan försäljning. */
  readonly perDay: number | null;
  /** Hela dagar lagret räcker, eller null när takten är 0. */
  readonly daysLeft: number | null;
  readonly stockoutDate: IsoDate | null;
  readonly lastRestockedAt: string | null;
  /** Påfyllningsregelns nivå: nu (< 1 dag), snart (< 2,5 dagar) eller ingen. */
  readonly level: "now" | "soon" | null;
}

export interface RecentOrder {
  readonly id: string;
  readonly externalId: string;
  readonly orderedAt: string;
  readonly titleName: string;
  readonly amountOre: number;
  readonly paymentMethod: string | null;
}

export interface PlacementLine {
  readonly id: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly from: IsoDate;
  readonly to: IsoDate | null;
  readonly current: boolean;
  /** Dagar i butiken (t.o.m. i dag eller slutdagen). */
  readonly days: number;
}

/** Enhetsekonomi (fas 6b): investering, avskrivning och återbetalning. */
export interface UnitEconomicsView {
  readonly investmentOre: number;
  readonly bookValueOre: number;
  readonly monthlyDepreciationOre: number;
  readonly profitPerMonthOre: number | null;
  readonly profitPerMonthAfterDepreciationOre: number | null;
  readonly paybackMonths: number | null;
  readonly activeDays: number;
}

export interface StoreOption {
  readonly id: string;
  readonly name: string;
}

/** Det som formulären behöver om automaten. */
export interface MachineEditable {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly serial: string | null;
  readonly activeFrom: IsoDate | null;
  readonly activeTo: IsoDate | null;
  readonly storeId: string | null;
  readonly lifecycle: MachineLifecycle;
  /** Första och sista orderdag (för gränser i formulären). */
  readonly firstOrderDate: IsoDate | null;
  readonly lastOrderDate: IsoDate | null;
  /** Senaste placeringens första dag (en flytt måste ligga efter den). */
  readonly lastPlacementFrom: IsoDate | null;
  /** Första placeringens första dag (driftstarten får inte ligga efter den). */
  readonly firstPlacementFrom: IsoDate | null;
}
