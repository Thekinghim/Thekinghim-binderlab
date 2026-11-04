/**
 * Typerna som de gemensamma serverladdarna (src/server/data/core) returnerar.
 *
 * Konventioner som i src/domain: belopp i öre (heltal), andelar i bp, affärsdatum
 * 'ÅÅÅÅ-MM-DD' i organisationens tidszon, tidpunkter som ISO 8601 med Z. Typerna är
 * byggda så att resultaten kan skickas rakt in i @/domain och @/analytics.
 */

import type { MachineRef, StockLevelRef, StoreRef, TitleRef } from "@/analytics/todos";
import type { PeriodKey, ResolvedPeriod } from "@/components/shell/period-state";
import type { MemberRole } from "@/db/schema";
import type { CostLines } from "@/lib/cost-lines";
import type {
  EconomicsSources,
  IsoDate,
  MachineInvestment,
  Period,
  ProfitabilityInput,
  Settings,
} from "@/domain";
import type { AnalyticsOrder } from "@/analytics/todos";

/** Roller som får se ekonomi (belopp, priser, avtal, vinst). Påfyllaren gör det aldrig. */
export const ECONOMY_ROLES = ["owner", "admin", "viewer"] as const satisfies readonly MemberRole[];
/** Roller som får ändra (priser, inställningar, lager utom påfyllning). */
export const OPERATOR_ROLES = ["owner", "admin"] as const satisfies readonly MemberRole[];
/** Alla roller. */
export const ALL_ROLES = [
  "owner",
  "admin",
  "refiller",
  "viewer",
] as const satisfies readonly MemberRole[];

export function canSeeEconomy(role: MemberRole): boolean {
  return (ECONOMY_ROLES as readonly MemberRole[]).includes(role);
}

/** Organisationens inställningar: det beräkningarna behöver plus räkenskapsårets start. */
export interface OrgSettings extends Settings {
  /** Första månaden i räkenskapsåret (1–12). */
  readonly fiscalYearStartMonth: number;
}

export interface ContextOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** IANA-tidszon, t.ex. 'Europe/Stockholm'. Avgör affärsdatum och "i dag". */
  readonly timezone: string;
}

export interface ContextUser {
  readonly id: string;
  readonly email: string;
  /** Profilens visningsnamn i organisationen, annars null. */
  readonly displayName: string | null;
}

/** Allt en sida behöver veta om vem som tittar och var. */
export interface AppContext {
  readonly user: ContextUser;
  readonly organization: ContextOrganization;
  readonly role: MemberRole;
  /** Alla organisationer användaren är medlem i (för växlaren), äldsta medlemskapet först. */
  readonly organizations: ReadonlyArray<ContextOrganization & { readonly role: MemberRole }>;
  /** Sant för ägare, admin och läsare. Falskt för påfyllare. */
  readonly canSeeEconomy: boolean;
  /** Sant för ägare och admin. */
  readonly canEdit: boolean;
  /** Inställningarna. null för påfyllare (de är ekonomi). */
  readonly settings: OrgSettings | null;
  /** = organization.timezone. */
  readonly timeZone: string;
  /** Tidpunkten förfrågan räknar från (ISO 8601, Z). */
  readonly now: string;
  /** Dagens affärsdatum i organisationens tidszon. */
  readonly today: IsoDate;
}

/** Globalt filter (?butik= ?automat=). Ogiltiga id:n (inte uuid) blir null. */
export interface DataScope {
  readonly storeId: string | null;
  readonly machineId: string | null;
}

/**
 * Periodvalet ur URL:en, tolkat i organisationens tidszon och med "Allt" = från första
 * ordern (för påfyllare: första försäljningen i lagret).
 */
export interface AppPeriod {
  readonly key: PeriodKey;
  /** Perioden. Alltid satt: "Allt" utan data blir bara i dag. */
  readonly period: Period;
  /** Jämförelseperioden (lika lång period direkt före, för "Denna månad" samma dagar förra månaden). null för "Allt". */
  readonly compare: Period | null;
  /** Antal dagar i perioden (båda ändar inräknade). */
  readonly days: number;
  /** Första dagen med data, eller null om det inte finns någon. */
  readonly dataStart: IsoDate | null;
  /** Filtret i URL:en. */
  readonly scope: DataScope;
  /** Vyknappen "Med VMB" (?vmb=1): vinsten visas efter VMB-moms. */
  readonly vmb: boolean;
  /** Skalets tolkning (Date vid lokal midnatt), för describePeriod och komponenter. */
  readonly resolved: ResolvedPeriod;
}

/** Titel. `archived` = arkiverad eller sammanslagen. */
export interface TitleRecord extends TitleRef {
  readonly series: string | null;
  readonly mergedIntoId: string | null;
  readonly archived: boolean;
  /** Egen produkt: vi packar den själva ("Packa" i stället för "Beställ"). */
  readonly ownProduct?: boolean;
}

/** Automat. */
export interface MachineRecord extends MachineRef {
  readonly code: string;
  readonly serial: string | null;
  /** Butiken automaten står i i dag (aktuell placering), annars null. */
  readonly storeId: string | null;
  readonly isExample: boolean;
  readonly archived: boolean;
}

/** Butik. */
export interface StoreRecord extends StoreRef {
  readonly address: string | null;
  readonly contactName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly isExample: boolean;
  readonly archived: boolean;
}

/** Placering (som @/domain Placement, med id). */
export interface PlacementRecord {
  readonly id: string;
  readonly machineId: string;
  readonly storeId: string;
  readonly from: IsoDate;
  readonly to: IsoDate | null;
}

/** Stamdata som alla roller får se (även påfyllare). */
export interface MasterData {
  readonly titles: TitleRecord[];
  readonly machines: MachineRecord[];
  readonly stores: StoreRecord[];
  readonly placements: PlacementRecord[];
}

/** Indata till beräkningarna för en period (och jämförelseperiod). */
export interface DomainInput extends MasterData {
  readonly period: Period;
  readonly compare: Period | null;
  readonly scope: DataScope;
  /**
   * Indata till profitability(), titleEconomics(), keyMetrics() m.fl. för perioden.
   * Orderna är filtrerade på perioden och filtret (butik: automatens placering på
   * orderns dag; automat: orderns automat). Vid butiksfilter gäller bara butikens
   * avtal och placeringar, vid automatfilter bara automatens placeringar och avtalen
   * för butikerna den stod i, så att andra butikers hyra inte kommer med.
   */
  readonly current: ProfitabilityInput & { readonly orders: readonly AnalyticsOrder[] };
  /** Samma för jämförelseperioden, eller null. */
  readonly previous: (ProfitabilityInput & { readonly orders: readonly AnalyticsOrder[] }) | null;
  /** Priser, avtal, placeringar och inställningar (filtrerade som ovan). */
  readonly sources: EconomicsSources;
  /** Investeringar (för unitEconomics), filtrerade på automat vid filter. */
  readonly investments: MachineInvestment[];
  readonly settings: OrgSettings;
  /**
   * Hyra och fasta kostnader finns i organisationen (hela organisationen, inte filtret).
   * Saknas = allt visas. Bara visning, se @/lib/cost-lines.
   */
  readonly costLines?: CostLines;
  readonly diagnostics: {
    /** Order i perioden som saknar titel (räknas inte, ska inte förekomma efter import). */
    readonly ordersWithoutTitle: number;
    /** Order i perioden utan kopplad automat (ingår, med machineId null). */
    readonly ordersWithoutMachine: number;
  };
}

/** En rad lagersaldo (vyn stock_levels) med lagerplatsens typ. */
export interface StockRow {
  readonly locationId: string;
  readonly locationName: string;
  readonly locationKind: "warehouse" | "machine";
  /** Standardlagret (ett av de egna lagren). Vårt lager är summan av alla egna lager. */
  readonly isCentral: boolean;
  /** Automaten för en automatplats, annars null. */
  readonly machineId: string | null;
  readonly titleId: string;
  /** Pack i lager (kan vara negativt om försäljning registrerats före påfyllning). */
  readonly onHand: number;
  readonly lastCountedAt: string | null;
  readonly lastEventAt: string | null;
  /** Senaste påfyllning eller inventering (ISO 8601). */
  readonly lastRestockedAt: string | null;
}

/** Lagret just nu. Tillåtet för alla roller (inga belopp). */
export interface StockSnapshot {
  /** Alla saldorader. */
  readonly rows: StockRow[];
  /** Automatplatserna i formen @/analytics/todos vill ha. */
  readonly machineStock: StockLevelRef[];
  /** Alla egna lager (Hemma, Kontoret …): en rad per lager och titel. Summan per titel: sumOwnStock. */
  readonly warehouse: StockRow[];
}

/** Sålda pack per dag, titel och automat (ur lagerhändelser av typen sale). Inga belopp. */
export interface SalesCountRow {
  readonly date: IsoDate;
  readonly titleId: string;
  readonly machineId: string | null;
  readonly units: number;
}

export interface SalesCounts {
  readonly period: Period;
  readonly scope: DataScope;
  readonly rows: SalesCountRow[];
  /** Summa sålda pack i perioden. */
  readonly units: number;
}

/** Synkstatus för skalet. */
export interface SyncInfo {
  /** Senaste lyckade synk över alla datakällor (ISO 8601), eller null. */
  readonly syncedAt: string | null;
  /** "no-orders": ansluten och synkad, men ingen order importerad än. */
  readonly state: "ok" | "stale" | "failed" | "no-orders";
  /** Antal aktiva (ej arkiverade) datakällor. */
  readonly sources: number;
}
