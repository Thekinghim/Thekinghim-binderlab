/**
 * Typer för maskinhälsa och tidslinje per automat.
 *
 * Konventioner som i src/domain och src/analytics/todos: affärsdatum 'ÅÅÅÅ-MM-DD' i
 * organisationens tidszon (standard Europe/Stockholm), tidpunkter som ISO 8601-strängar med
 * tidszon ('2026-11-01T16:17:00Z' eller '…+01:00'). Sannolikheter anges i bp (10 000 = 100 %),
 * förväntade antal i tusendelar ("milli", 6 200 = 6,2 pack), så att allt som visas är heltal.
 */

import type { IsoDate } from "@/domain";
import type { AnalyticsOrder, Evidence, MachineRef, StockLevelRef } from "@/analytics/todos/types";

export type { AnalyticsOrder, Evidence, MachineRef, StockLevelRef };

// ---------------------------------------------------------------------------
// Leverantörens maskindata (gemensamt indataformat)
// ---------------------------------------------------------------------------

/**
 * Typ av maskinhändelse från leverantören, oavsett källa (Awish gRPC, webhook, CSV …).
 * - `online` / `offline`: anslutningen ändrades.
 * - `heartbeat`: automaten hörde av sig (räknas som online).
 * - `fault` / `fault_cleared`: ett fel uppstod / åtgärdades (t.ex. myntmekanism, spiral, kortläsare).
 */
export type MachineSignalKind = "online" | "offline" | "heartbeat" | "fault" | "fault_cleared";

/**
 * En maskinhändelse i det gemensamma formatet. Adaptern för varje leverantör översätter sina
 * egna fält hit; allt efter adaptern är gemensamt.
 */
export interface MachineSignal {
  readonly id: string;
  /** Vår automat (efter koppling via source_machines). */
  readonly machineId: string;
  /** Tidpunkt, ISO 8601 med tidszon. */
  readonly at: string;
  readonly kind: MachineSignalKind;
  /** Leverantörens felkod, t.ex. "E21". */
  readonly code?: string | null;
  /** Leverantörens text, t.ex. "Spiral 4 fastnar". */
  readonly message?: string | null;
  /** Källa, t.ex. 'awish_grpc'. */
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Automatens status.
 * - `ok`: i drift.
 * - `suspected_fault`: misstänkt fel, härlett ur avvikande tystnad i försäljningen.
 * - `fault`: leverantören rapporterar ett fel som inte är åtgärdat.
 * - `offline`: leverantören rapporterar offline, eller tystnaden är avvikande och lång
 *   (härlett, när maskindata saknas).
 * - `empty`: lagret i automaten är 0 (tystnaden förklaras av att den är tom).
 * - `unknown`: för lite historik för att avgöra.
 * - `inactive`: automaten är inte i drift (före driftstart, efter slutdag eller arkiverad).
 */
export type HealthStatus =
  "ok" | "suspected_fault" | "fault" | "offline" | "empty" | "unknown" | "inactive";

/** Varifrån statusen kommer. */
export type HealthSource = "vendor" | "sales" | "stock" | "none";

/** Inställningar för hälsoberäkningen. Alla har standardvärden (`HEALTH_DEFAULTS`). */
export interface HealthOptions {
  /** Organisationens tidszon. Standard 'Europe/Stockholm'. */
  readonly timeZone?: string;
  /** Veckor historik som det normala mönstret räknas från. Standard 8. */
  readonly historyWeeks?: number;
  /** Larmgräns: sannolikheten för noll försäljning under tystnaden, i bp. Standard 100 (= 1 %). */
  readonly alarmProbabilityBp?: number;
  /** Minsta antal order i historiken för att tystnaden ska bedömas. Standard 20. */
  readonly minHistoryOrders?: number;
  /** Kortare tystnad än så här bedöms aldrig som fel. Standard 60 minuter. */
  readonly minSilenceMinutes?: number;
  /**
   * Avvikande tystnad som varat minst så här länge räknas som offline (härlett) när
   * leverantörsdata om anslutning saknas. Standard 24 timmar.
   */
  readonly offlineAfterHours?: number;
  /**
   * Om leverantören skickar heartbeat: så länge utan heartbeat räknas automaten som offline.
   * `null` (standard) = används inte.
   */
  readonly heartbeatTimeoutMinutes?: number | null;
}

/** Indata till `machineHealth`. */
export interface HealthInput {
  readonly orders: readonly AnalyticsOrder[];
  readonly machines: readonly MachineRef[];
  /** Leverantörens maskindata. Saknas den härleds statusen ur försäljningen. */
  readonly signals?: readonly MachineSignal[];
  /** Lagersaldon. Används för att skilja "tom" från "fel". */
  readonly stock?: readonly StockLevelRef[];
  /**
   * Hur långt den importerade försäljningen räcker per automat. Tystnaden räknas bara fram
   * till dit: försäljning som inte importerats än är en eftersläpning i datat, inte en tyst
   * automat. Saknas en automat här räknas tystnaden fram till nu.
   */
  readonly salesCoverage?: readonly SalesCoverage[];
  readonly options?: HealthOptions;
}

/** Försäljningsdatats täckning för en automat (ur datakällan som automatens order kommer från). */
export interface SalesCoverage {
  readonly machineId: string;
  /** Senaste tidpunkt som försäljningen är känd till (ISO 8601 UTC). */
  readonly until: string;
  /** Datakällans namn, för förklaringen. */
  readonly sourceName?: string | null;
}

/** En timme i veckan (1 = måndag … 7 = söndag, timme 0–23) och vad den bidrar med. */
export interface SlotContribution {
  readonly weekday: number;
  readonly hour: number;
  /** Förväntade pack från timmen under tystnaden, i tusendelar. */
  readonly expectedMilli: number;
  /** Sålda pack under samma veckodag och timme i historiken. */
  readonly historyOrders: number;
  /** Antal gånger timmen förekom i historiken. */
  readonly historyHours: number;
}

/** Bedömning av en tystnad: hur mycket automaten normalt säljer under samma veckodagar och timmar. */
export interface SilenceAnalysis {
  /** Senaste försäljning (eller driftstart), ISO 8601 UTC. */
  readonly from: string;
  /** Bedömningens tidpunkt, ISO 8601 UTC. */
  readonly to: string;
  readonly minutes: number;
  /** Förväntat antal pack under tystnaden, i tusendelar (6 200 = 6,2). */
  readonly expectedMilli: number;
  /** Sannolikheten för noll försäljning (Poisson, e^−förväntat), i bp. */
  readonly zeroProbabilityBp: number;
  /** Sant när sannolikheten är under larmgränsen och tystnaden är lång nog. */
  readonly anomalous: boolean;
  /** Historikens order och timmar (efter att tid före driftstart och känd offline-tid tagits bort). */
  readonly historyOrders: number;
  readonly historyHours: number;
  /** De timmar som bidrar mest till det förväntade antalet, högst tre. */
  readonly topSlots: SlotContribution[];
}

/** Hälsa för en automat. */
export interface MachineHealth {
  readonly machineId: string;
  readonly status: HealthStatus;
  /** Svensk etikett: "I drift", "Misstänkt fel" … */
  readonly label: string;
  readonly source: HealthSource;
  /** Sedan när statusen gäller (ISO 8601 UTC), om känt. */
  readonly since: string | null;
  readonly title: string;
  readonly detail: string;
  readonly silence: SilenceAnalysis | null;
  /** Den leverantörshändelse statusen bygger på. */
  readonly signal: MachineSignal | null;
  /**
   * När försäljningsdatat inte räcker fram till nu: hur långt det räcker (ISO 8601 UTC).
   * Tystnaden är då bedömd fram till den tidpunkten.
   */
  readonly dataUntil?: string | null;
  readonly evidence: Evidence;
  readonly link: string;
}

// ---------------------------------------------------------------------------
// Tidslinje
// ---------------------------------------------------------------------------

/** Lagerhändelse (stock_events) för en automats lagerplats. */
export interface MachineStockEvent {
  readonly id: string;
  readonly machineId: string;
  readonly titleId: string;
  readonly kind:
    | "refill"
    | "count"
    | "sale"
    | "waste"
    | "adjustment"
    | "transfer_in"
    | "transfer_out"
    | "receipt";
  /** Förändring, eller räknat antal vid `count`. */
  readonly quantity: number;
  /** Tidpunkt, ISO 8601 med tidszon. */
  readonly occurredAt: string;
  readonly performedBy?: string | null;
  readonly note?: string | null;
}

/** Ärende (incidents): fel som någon registrerat, med åtgärd. */
export interface MachineIncident {
  readonly id: string;
  readonly machineId: string;
  /** T.ex. 'jam', 'payment', 'power'. */
  readonly kind: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly description?: string | null;
  readonly actionTaken?: string | null;
}

/** Typ av rad i tidslinjen. */
export type TimelineKind =
  | "sales"
  | "refill"
  | "count"
  | "waste"
  | "adjustment"
  | "transfer"
  | "signal"
  | "incident_opened"
  | "incident_closed";

/**
 * Underlag för en rad i tidslinjen: som Evidence, plus id för händelsen raden bygger på, så att
 * UI kan länka till maskinhändelsen, lagerhändelsen eller ärendet.
 */
export interface TimelineEvidence extends Evidence {
  readonly signalIds?: string[];
  readonly stockEventIds?: string[];
  readonly incidentIds?: string[];
}

/** En rad i tidslinjen. */
export interface TimelineEntry {
  /** Stabil nyckel, t.ex. 'sales:2026-11-02T13' eller 'stock:<id>'. */
  readonly key: string;
  readonly kind: TimelineKind;
  /** Tidpunkt för raden (för försäljning: första ordern i gruppen), ISO 8601 UTC. */
  readonly at: string;
  /** Affärsdatum i organisationens tidszon. */
  readonly date: IsoDate;
  /** Klockslag 'TT:MM' i organisationens tidszon. */
  readonly time: string;
  readonly title: string;
  readonly detail: string;
  /** Positiv för påfyllning, negativ för svinn och försäljning; 0 annars. */
  readonly packs: number;
  readonly severity: "info" | "warning" | "critical";
  readonly evidence: TimelineEvidence;
}

/** Hur försäljning visas i tidslinjen. */
export type SalesGrouping = "order" | "hour" | "day";

/** Indata till `machineTimeline`. */
export interface TimelineInput {
  readonly machineId: string;
  readonly orders: readonly AnalyticsOrder[];
  readonly stockEvents?: readonly MachineStockEvent[];
  readonly signals?: readonly MachineSignal[];
  readonly incidents?: readonly MachineIncident[];
  /** Titelnamn för texterna. */
  readonly titles?: readonly { readonly id: string; readonly name: string }[];
}

/** Inställningar för tidslinjen. */
export interface TimelineOptions {
  /** Från och med (ISO 8601 med tidszon). */
  readonly from: string;
  /** Till (exklusive), ISO 8601 med tidszon. */
  readonly to: string;
  readonly timeZone?: string;
  /** Standard 'hour': en rad per timme med försäljning. */
  readonly salesGrouping?: SalesGrouping;
  /** Senaste först (standard) eller äldsta först. */
  readonly order?: "desc" | "asc";
}
