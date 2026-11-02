/**
 * Typer för besöksplanen: vilka automater som behöver besök under veckan, vad som ska med
 * och i vilken ordning.
 */

import type { IsoDate, Period } from "@/domain";
import type {
  AnalyticsOrder,
  Evidence,
  MachineRef,
  StockLevelRef,
  TitleRef,
} from "@/analytics/todos/types";
import type { GeoPoint } from "./route";

export type { GeoPoint };

/** Automat med (valfri) plats. */
export interface VisitMachine extends MachineRef {
  readonly location?: GeoPoint | null;
}

/** Hur många pack av en titel som får plats i automaten (fack × djup). */
export interface MachineCapacity {
  readonly machineId: string;
  readonly titleId: string;
  readonly capacity: number;
}

/** Besök som behövs av annan orsak än lager, t.ex. misstänkt fel från maskinhälsan. */
export interface ExtraVisit {
  readonly machineId: string;
  /** Kort orsak, t.ex. "Misstänkt fel". */
  readonly reason: string;
  /** Senaste dag för besöket. */
  readonly needBy: IsoDate;
}

/** Inställningar för besöksplanen. */
export interface VisitPlanOptions {
  readonly timeZone?: string;
  /** Första dagen i planen. Standard: i dag. Planen omfattar 7 dagar. */
  readonly start?: IsoDate;
  /**
   * Dagen saldot gäller (standard: planens "i dag" från `now`). När takten räknas t.o.m. i
   * går men saldot är dagens, dras försäljning bara för dagarna från saldots dag till
   * besöket, så att ett besök i dag får samma packlista som Lager.
   */
  readonly stockDate?: IsoDate;
  /** Veckodagar då besök görs (1 = måndag). Standard måndag–fredag. */
  readonly visitWeekdays?: readonly number[];
  /** Högst så många besök per dag. Standard 8. */
  readonly maxStopsPerDay?: number;
  /** Fönster för försäljningstakten. Standard 14 dagar. */
  readonly windowDays?: number;
  /** Besök senast så här många dagar före beräknat slut. Standard 1. */
  readonly bufferDays?: number;
  /** Fyll för så här många dagars försäljning när kapaciteten är okänd. Standard 7. */
  readonly coverDays?: number;
  /** En dag med färre besök än så slås ihop med en tidigare besöksdag om det går. Standard 2. */
  readonly minStopsPerTrip?: number;
}

/** Indata till `planVisits`. */
export interface VisitPlanInput {
  readonly orders: readonly AnalyticsOrder[];
  readonly machines: readonly VisitMachine[];
  readonly titles: readonly TitleRef[];
  /** Lager i automaterna. */
  readonly stock: readonly StockLevelRef[];
  readonly capacities?: readonly MachineCapacity[];
  /** Lager i centrallagret. Utan det antas allt finnas. */
  readonly warehouseStock?: readonly { readonly titleId: string; readonly onHand: number }[];
  /** Startpunkt för rutten (t.ex. centrallagret). */
  readonly depot?: GeoPoint | null;
  readonly extraVisits?: readonly ExtraVisit[];
  readonly options?: VisitPlanOptions;
}

/** En rad i packlistan för ett besök. */
export interface PackLine {
  readonly titleId: string;
  readonly titleName: string;
  /** Pack att ta med. */
  readonly quantity: number;
  readonly onHandNow: number;
  /** Beräknat lager vid besöket. */
  readonly projectedAtVisit: number;
  /** Mål efter påfyllning (kapacitet, eller försäljning under coverDays). */
  readonly target: number;
  readonly capacity: number | null;
  /** Pack som saknas i centrallagret för att nå målet. */
  readonly shortBy: number;
  /** Beräknat slutdatum utan besök, om titeln säljer. */
  readonly stockoutDate: IsoDate | null;
}

/** Ett besök. */
export interface VisitStop {
  readonly machineId: string;
  readonly machineName: string;
  /** 1, 2, 3 … i dagens ordning. */
  readonly sequence: number;
  /** Senaste dag för besöket. */
  readonly needBy: IsoDate;
  /** Sant om besöket görs efter `needBy` (ingen besöksdag fanns i tid). */
  readonly late: boolean;
  /** Orsaker, t.ex. "30th Celebration tar slut tor 5 nov. (5 kvar, 2,0 pack/dag)". */
  readonly reasons: string[];
  readonly packs: PackLine[];
  readonly totalPacks: number;
  /** Sträcka från föregående stopp (eller depån), meter. `null` utan koordinater. */
  readonly distanceFromPreviousMeters: number | null;
  readonly evidence: Evidence;
  readonly link: string;
}

/** En besöksdag. */
export interface VisitDay {
  readonly date: IsoDate;
  readonly stops: VisitStop[];
  /** Allt som ska lastas, per titel. */
  readonly load: {
    readonly titleId: string;
    readonly titleName: string;
    readonly quantity: number;
  }[];
  readonly totalPacks: number;
  /** Total sträcka (meter), med återresa till depån. `null` om någon automat saknar koordinater. */
  readonly totalMeters: number | null;
  /** 'distance' = ordnad efter avstånd, 'urgency' = efter brådska (koordinater saknas). */
  readonly routeMethod: "distance" | "urgency";
  /** T.ex. "ons 4 nov.: 3 besök, 46 pack, 12,4 km". */
  readonly title: string;
}

/** Veckoplanen. */
export interface VisitPlan {
  readonly period: Period;
  /** Bara dagar med besök, i datumordning. */
  readonly days: VisitDay[];
  /** Automater som inte behöver besök under perioden, med beräknad senaste besöksdag. */
  readonly notNeeded: { readonly machineId: string; readonly needBy: IsoDate | null }[];
  /** Automater som inte fick plats (fler besök än maxStopsPerDay på de dagar som fanns). */
  readonly overflow: string[];
  readonly totalPacks: number;
  /** T.ex. "5 besök på 2 dagar, 74 pack". */
  readonly summary: string;
  readonly evidence: Evidence;
}
