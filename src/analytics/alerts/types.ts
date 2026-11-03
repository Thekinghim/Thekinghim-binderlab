/**
 * Typer för larm: regler som ger kandidater, incidenter som samlar samma problem över tid,
 * aviseringar och prenumerationer per användare.
 *
 * Flödet:
 *   regler (health/lager/import/dag) → AlertCandidate[]
 *   reconcileAlerts(kandidater, tidigare incidenter, nu) → incidenter + AlertNotification[]
 *   routeNotifications(aviseringar, prenumerationer, nu) → AlertDelivery[] (en per användare och sändtid)
 *
 * Typvärdena (`AlertKind`) följer databasens format för alerts.kind (gemener och _), och
 * allvarlighetsgraderna är desamma som enum alert_severity.
 */

import type { IsoDate } from "@/domain";
import type { Evidence } from "@/analytics/todos/types";

export type { Evidence };

/** Allvar, som enum alert_severity i databasen. */
export type AlertSeverity = "info" | "warning" | "critical";

/** Typ av larm. */
export type AlertKind =
  | "machine_suspected_fault"
  | "machine_fault"
  | "machine_offline"
  | "low_stock"
  | "import_failed"
  | "day_anomaly"
  /** Ett rapportutskick eller månadsutkasten misslyckades (skrivs av src/server/monitoring). */
  | "report_failed"
  /** Ett schemalagt jobb (t.ex. larmjobbet) misslyckades (skrivs av src/server/monitoring). */
  | "job_failed"
  /** Awish har en automat som inte är kopplad till någon butik (managerpaket 8). */
  | "machine_discovered";

/**
 * Familj av larm. Typerna i en familj delar incident (t.ex. misstänkt fel som blir offline är
 * samma problem) och utvärderas tillsammans.
 *
 * `system` (misslyckade rapporter och jobb) har inga regler: incidenterna skrivs direkt när
 * felet inträffar och stängs när samma sak lyckas (src/server/monitoring). Larmjobbet
 * utvärderar aldrig familjen och stänger därför inte heller dess incidenter.
 */
export type AlertGroup = "machine" | "stock" | "import" | "sales" | "system";

/** Underlag för larm: som Evidence, plus importer och datakällor. */
export interface AlertEvidence extends Evidence {
  readonly importIds?: string[];
  readonly dataSourceIds?: string[];
}

/** En regel har hittat ett problem. Samma problem ger alltid samma `key`. */
export interface AlertCandidate {
  /** Incidentnyckel, t.ex. 'machine:<id>', 'low_stock:<automat>:<titel>', 'import:<källa>'. */
  readonly key: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly machineId: string | null;
  readonly titleId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly evidence: AlertEvidence;
  readonly link: string;
  /**
   * Engångslarm (t.ex. avvikande dag): incidenten stängs direkt efter aviseringen och samma
   * nyckel larmar aldrig igen.
   */
  readonly oneShot?: boolean;
}

/** Varför en avisering skickas. */
export type NotificationReason = "new" | "reminder" | "escalated" | "reopened" | "resolved";

/** Incident: ett problem över tid. Sparas av anroparen (t.ex. i tabellen alerts). */
export interface AlertIncident {
  /** `${key}@${openedAt}`. */
  readonly id: string;
  readonly key: string;
  readonly group: AlertGroup;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly status: "open" | "closed";
  readonly machineId: string | null;
  readonly titleId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly evidence: AlertEvidence;
  readonly link: string;
  readonly openedAt: string;
  /** Senaste gången en regel såg problemet. */
  readonly lastSeenAt: string;
  readonly closedAt: string | null;
  readonly lastNotifiedAt: string | null;
  /**
   * Allvaret i den senaste aviseringen (inte 'resolved'). Skärpning aviseras bara när allvaret
   * blir högre än detta, så att fladder mellan t.ex. misstänkt fel och offline inte larmar varje
   * gång allvaret går upp igen. `null` = inget aviserat.
   */
  readonly notifiedSeverity: AlertSeverity | null;
  readonly notifyCount: number;
  /** Antal utvärderingar där problemet fanns. */
  readonly occurrences: number;
  /** Antal gånger incidenten öppnats igen inom fönstret för fladder. */
  readonly reopenCount: number;
  readonly oneShot: boolean;
  /** Kvitterad: inga påminnelser, men skärpning aviseras fortfarande. */
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  /** Senaste gången 'resolved' aviserades. */
  readonly resolvedNotifiedAt: string | null;
  /**
   * Nyckeln till incidenten som förklarar det här larmet, om det ströks utan avisering (t.ex.
   * låg dag när automaten var offline). Strukna engångslarm sparas stängda, så att samma
   * nyckel inte larmar i en senare körning.
   */
  readonly suppressedBy: string | null;
}

/** En avisering om en incident. */
export interface AlertNotification {
  readonly incidentId: string;
  readonly key: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly reason: NotificationReason;
  readonly machineId: string | null;
  readonly titleId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly at: string;
  readonly evidence: AlertEvidence;
  readonly link: string;
}

/** Inställningar för incidenthanteringen. */
export interface ReconcileOptions {
  /**
   * Påminnelse efter så många timmar utan avisering, per allvar. `null` = ingen påminnelse.
   * Standard: critical 4, warning 24, info null.
   */
  readonly renotifyAfterHours?: Partial<Record<AlertSeverity, number | null>>;
  /** En incident som inte setts på så här länge stängs. Standard 30 minuter. */
  readonly resolveAfterMinutes?: number;
  /** Kommer samma problem tillbaka inom så här lång tid öppnas den gamla incidenten igen. Standard 120 minuter. */
  readonly reopenWithinMinutes?: number;
  /**
   * Familjer som utvärderades i den här körningen. Incidenter i andra familjer lämnas orörda.
   * Standard: alla.
   */
  readonly evaluatedGroups?: readonly AlertGroup[];
  /** Tidszon för affärsdatum (låg dag jämförs med incidenter under dagen). Standard 'Europe/Stockholm'. */
  readonly timeZone?: string;
}

/** Resultat av `reconcileAlerts`. */
export interface ReconcileResult {
  /** Alla incidenter efter körningen (öppna först). */
  readonly incidents: AlertIncident[];
  /** Aviseringar att skicka. */
  readonly notifications: AlertNotification[];
}

// ---------------------------------------------------------------------------
// Prenumerationer
// ---------------------------------------------------------------------------

/** Tysta timmar i lokal tid, 'TT:MM'. start > end betyder över midnatt (22:00–07:00). */
export interface QuietHours {
  readonly start: string;
  readonly end: string;
}

/**
 * Tid då en användare vill ha aviseringar, i lokal tid: veckodagar (1 = måndag … 7 = söndag)
 * och klockslag [start, end). start > end betyder över midnatt och hör till startdagen
 * ({ days: [5], start: '18:00', end: '02:00' } = fredag 18:00 till lördag 02:00).
 * start = end betyder hela dygnet.
 */
export interface DeliveryWindow {
  readonly days: readonly number[];
  readonly start: string;
  readonly end: string;
}

/** En användares prenumeration på larm. */
export interface AlertSubscription {
  readonly userId: string;
  readonly kinds: readonly AlertKind[] | "all";
  /** Automater. Gäller larm som hör till en automat; larm utan automat påverkas inte. */
  readonly machineIds: readonly string[] | "all";
  /** Lägsta allvar. Standard 'warning'. */
  readonly minSeverity?: AlertSeverity;
  readonly quietHours?: QuietHours | null;
  /**
   * Tider då aviseringar skickas (t.ex. vardagar 07:00–18:00). Utanför dem skjuts aviseringen
   * upp till nästa tid. `null`/utelämnat = alla tider. Tysta timmar gäller dessutom.
   */
  readonly deliveryWindows?: readonly DeliveryWindow[] | null;
  /** Tidszon för tysta timmar och tider. Standard 'Europe/Stockholm'. */
  readonly timeZone?: string;
  /** Kritiska larm skickas även under tysta timmar och utanför tiderna. Standard true. */
  readonly criticalDuringQuietHours?: boolean;
  /** Avisering när problemet är löst. Standard false. */
  readonly notifyResolved?: boolean;
  /** Påminnelser om öppna incidenter. Standard true. */
  readonly reminders?: boolean;
  /** Avstängd prenumeration. Standard true (aktiv). */
  readonly active?: boolean;
}

/** Ett utskick till en användare: alla aviseringar med samma sändtid samlade. */
export interface AlertDelivery {
  readonly userId: string;
  /** När det ska skickas (ISO 8601 UTC). Lika med nu, eller slutet av de tysta timmarna. */
  readonly sendAt: string;
  /** Sant om utskicket skjutits upp av tysta timmar. */
  readonly deferred: boolean;
  /** Ämnesrad, t.ex. "3 larm: Automat 3 är offline med flera". */
  readonly subject: string;
  readonly items: AlertNotification[];
}

// ---------------------------------------------------------------------------
// Indata till reglerna
// ---------------------------------------------------------------------------

/** Status för en import (enum import_status). */
export type ImportStatus = "pending" | "running" | "succeeded" | "failed";

/** En import (tabellen imports). */
export interface ImportRunRef {
  readonly id: string;
  readonly dataSourceId: string;
  readonly status: ImportStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly rowsTotal: number;
  readonly rowsError: number;
  readonly rowsConflict: number;
  readonly fileName?: string | null;
  /** Felmeddelande, om importen sparar ett. */
  readonly message?: string | null;
}

/** En datakälla (tabellen data_sources). */
export interface DataSourceRef {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly status: "active" | "paused" | "error";
  readonly lastSyncedAt: string | null;
  /**
   * Förväntat intervall mellan importer, i minuter (gRPC: 10; CSV som laddas upp varje dag:
   * 2 160). `null` = inget larm för utebliven import.
   */
  readonly expectedIntervalMinutes?: number | null;
  /** Sant för källor som laddas upp för hand: aktualiteten bedöms på datat, inte hämtningen. */
  readonly manual?: boolean;
  /** Senaste importerade försäljning i källan (ISO 8601 UTC), om känd. */
  readonly dataUntil?: string | null;
}

/** Prognos för en dag: förväntat antal pack i tiondelar (125 = 12,5). */
export interface DayForecast {
  /** 'all' för hela organisationen eller en automat. */
  readonly scope: string;
  readonly date: IsoDate;
  readonly expectedTenths: number;
}
