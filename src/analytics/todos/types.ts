/**
 * Typer för "Att göra" och gemensamma typer för underlag (evidence) och indata,
 * som även används av "Värt att veta" (src/analytics/insights).
 *
 * Konventioner som i src/domain: belopp i öre (heltal), andelar i bp, affärsdatum
 * 'ÅÅÅÅ-MM-DD' i Europe/Stockholm. Tidpunkter är ISO 8601-strängar med tidszon
 * ('2026-11-01T16:17:00Z' eller '…+01:00'), aldrig lokal tid utan zon.
 */

import type { SignableContract } from "@/analytics/contracts/signed";
import type { EconomicsSources, IsoDate, OrderLine, Period } from "@/domain";
import type { SlotPeriod } from "./assortment";

/** En order med betaltidpunkt. Tidpunkten behövs för regeln om automater som inte sålt på 48 timmar. */
export interface AnalyticsOrder extends OrderLine {
  /**
   * Betaltidpunkt (ISO 8601 med Z eller offset). Saknas den eller är ogiltig räknas ordern i
   * 48-timmarsregeln som såld i slutet av sin affärsdag (00:00 nästa dag, svensk tid).
   */
  readonly orderedAt?: string;
}

/** En titel (kanoniskt namn). */
export interface TitleRef {
  readonly id: string;
  readonly name: string;
  /** Arkiverad eller sammanslagen titel. Tas inte med i dubblettsökningen. */
  readonly archived?: boolean;
}

/** En automat. */
export interface MachineRef {
  readonly id: string;
  /** Visningsnamn, t.ex. "Automat 3". */
  readonly name: string;
  /** Kod, t.ex. "BL-003". */
  readonly code?: string;
  /** Första dag automaten är i drift. `null` = okänt (räknas som aktiv). */
  readonly activeFrom: IsoDate | null;
  /** Sista dag i drift (inklusive). `null` = i drift. */
  readonly activeTo: IsoDate | null;
  readonly archived?: boolean;
}

/** Lagersaldo för en titel i en automat (vyn stock_levels). */
export interface StockLevelRef {
  readonly machineId: string;
  readonly titleId: string;
  /** Pack i automaten just nu. */
  readonly onHand: number;
  /**
   * Senaste påfyllning eller inventering (tidpunkt eller datum). Används som fingerprint:
   * en avbockad påfyllningspunkt kommer tillbaka efter nästa påfyllning. Saknas den används
   * saldot, och punkten kommer då tillbaka redan efter nästa försäljning.
   */
  readonly lastRestockedAt?: string | null;
}

/** Larmgräns: saldo högst `alertAtUnits` pack i automaten ger en påfyllningspunkt. */
export interface SlotAlert {
  readonly machineId: string;
  readonly titleId: string;
  readonly alertAtUnits: number;
}

/** Butik (för namn i texter). */
export interface StoreRef {
  readonly id: string;
  readonly name: string;
}

/** Rapportmottagare (report_recipients). */
export interface ReportRecipientRef {
  readonly id: string;
  readonly name: string;
  readonly kind: "store" | "accountant" | "partner";
  /** Butiken som en butiksmottagare hör till. */
  readonly storeId: string | null;
  readonly active: boolean;
}

/** Rapporttyp (reports.kind). */
export type ReportKind =
  "store_statement" | "owner_statement" | "accountant_statement" | "profitability";

/** Status för ett utskick (report_deliveries.status). */
export type ReportDeliveryStatus = "queued" | "sent" | "delivered" | "failed" | "bounced";

/** Ett utskick av en rapport, sammanslaget med rapportens typ och period. */
export interface ReportDeliveryRef {
  readonly id: string;
  readonly recipientId: string | null;
  readonly reportKind: ReportKind;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly storeId: string | null;
  readonly status: ReportDeliveryStatus;
  /** Tidpunkt för utskicket (ISO 8601 med tidszon). */
  readonly sentAt?: string | null;
}

/** Ett rapportutkast som väntar på granskning (senaste versionen, inte godkänd, inte skickad). */
export interface ReportDraftRef {
  readonly id: string;
  readonly reportKind: ReportKind;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly storeId: string | null;
  /** När utkastet skapades (ISO 8601 med tidszon). */
  readonly generatedAt: string;
}

/** En månadsavräkning till en butik som inte är markerad som betald (store_settlements). */
export interface SettlementRef {
  readonly id: string;
  readonly storeId: string;
  /** Månadens första dag. */
  readonly month: IsoDate;
  /** Att betala ut, öre. Högst 0 = inget att betala (ingen punkt). */
  readonly amountOre: number;
}

/** Allvar för ett larm (enum alert_severity). */
export type AlertSeverityRef = "info" | "warning" | "critical";

/** Ett öppet larm (tabellen alerts, incidenten från @/analytics/alerts). */
export interface AlertRef {
  readonly id: string;
  /** Incidentnyckeln, t.ex. 'machine:<id>' eller 'import:<källa>'. */
  readonly key: string;
  /** Typ (alerts.kind), t.ex. 'machine_offline', 'import_failed'. */
  readonly kind: string;
  readonly severity: AlertSeverityRef;
  readonly machineId: string | null;
  readonly titleId: string | null;
  readonly title: string;
  readonly detail: string;
  /** När incidenten öppnades (ISO 8601 med tidszon). */
  readonly openedAt: string;
  /** Kvitterat av någon: då tar någon hand om det och det står inte i Att göra. */
  readonly acknowledged: boolean;
}

/** Förlorad försäljning per titel och automat (@/analytics/lost-sales via servern). */
export interface LostSalesRef {
  /** Samma nyckel som påfyllningspunkten: 'refill:<automat>:<titel>'. */
  readonly key: string;
  /** Uppskattad förlorad intäkt i perioden, öre. */
  readonly lostRevenueOre: number;
}

// ---------------------------------------------------------------------------
// Underlag
// ---------------------------------------------------------------------------

/** Enhet för ett tal i underlaget. */
export type FigureUnit = "ore" | "bp" | "count" | "packs" | "days" | "hours" | "tenths";

/** Ett namngivet tal som ett resultat bygger på. */
export interface EvidenceFigure {
  /** Stabil nyckel, t.ex. 'revenueOre'. */
  readonly key: string;
  /** Svensk etikett, t.ex. "Intäkt i perioden". */
  readonly label: string;
  /** Heltal i angiven enhet ('tenths' = tiondelar, 14 = 1,4). */
  readonly value: number;
  readonly unit: FigureUnit;
}

/**
 * Underlaget för ett resultat: vilken regel, vilka order, dagar, titlar, automater och tal
 * det bygger på. Listorna är sorterade och utan dubbletter, så att UI kan länka dit.
 */
export interface Evidence {
  /** Regeln i klartext, t.ex. "Lagret räcker under 2,5 dagar vid snittförsäljningen de senaste 14 dagarna." */
  readonly rule: string;
  /** Perioden som talen avser, om någon. */
  readonly period: Period | null;
  readonly orderIds: string[];
  readonly dates: IsoDate[];
  readonly titleIds: string[];
  readonly machineIds: string[];
  readonly storeIds: string[];
  readonly recipientIds: string[];
  readonly figures: EvidenceFigure[];
}

// ---------------------------------------------------------------------------
// Att göra
// ---------------------------------------------------------------------------

/** Typ av punkt. */
export type TodoKind =
  | "refill"
  | "missing-price"
  | "duplicate-title"
  | "stale-machine"
  | "silent-title"
  | "report-due"
  | "report-review"
  | "contract"
  | "alert"
  | "settlement";

/** Brådskenivå: 'now' (gör i dag), 'soon' (de närmaste dagarna), 'later' (när tid finns). */
export type TodoLevel = "now" | "soon" | "later";

/** Åtgärd som kan göras direkt från punkten. */
export interface TodoAction {
  readonly kind:
    | "register-refill"
    | "add-price"
    | "merge-titles"
    | "send-report"
    | "review-report"
    | "open-contract"
    | "open-alert"
    | "open-machine";
  /** Knapptext, verbet först. */
  readonly label: string;
  readonly params: Readonly<Record<string, string>>;
}

/** En punkt i Att göra. */
export interface TodoItem {
  /**
   * Stabil nyckel för orsaken, t.ex. 'refill:<automat>:<titel>'. Samma orsak ger alltid samma
   * nyckel, så att en avbockning kan sparas och punkten försvinner när orsaken är löst.
   */
  readonly key: string;
  /** Orsakens tillstånd. Ändras det (t.ex. ny påfyllning, lagret tog slut) gäller inte avbockningen längre. */
  readonly fingerprint: string;
  readonly kind: TodoKind;
  readonly level: TodoLevel;
  /** Sorteringsvärde, högst först: nivå × 10¹² + kronor i risk per vecka (öre). */
  readonly urgency: number;
  /** Uppskattad intäkt i risk under de närmaste 7 dagarna, i öre. `null` när punkten inte gäller pengar direkt. */
  readonly atStakeOre: number | null;
  /** Hela dagar kvar till lagret tar slut eller till sista dag. `null` om ingen tidsgräns finns. */
  readonly daysLeft: number | null;
  readonly title: string;
  readonly detail: string;
  readonly evidence: Evidence;
  readonly link: string;
  readonly action?: TodoAction;
}

/** Inställningar för reglerna. Alla har standardvärden. */
export interface TodoOptions {
  /** Organisationens tidszon. Standard 'Europe/Stockholm'. */
  readonly timeZone?: string;
  /** Fönster för snittförsäljningen vid påfyllning. Standard 14 dagar. */
  readonly refillWindowDays?: number;
  /** Gräns för påfyllning i hundradels dagar. Standard 250 (= 2,5 dagar). */
  readonly refillThresholdCentidays?: number;
  /** Timmar utan försäljning innan en automat flaggas. Standard 48. */
  readonly staleHours?: number;
  /** Fönster för saknade inköpspriser. Standard 30 dagar. */
  readonly unpricedWindowDays?: number;
  /** Sista dag i månaden att skicka förra månadens rapporter. `null` = månadens sista dag. */
  readonly reportDueDay?: number | null;
  /** Dagar före sista uppsägningsdag som ett avtal tas upp. Standard 90 (som /avtal). */
  readonly contractReminderDays?: number;
}

/** Indata till `computeTodos`. */
export interface TodoInput extends EconomicsSources {
  readonly orders: readonly AnalyticsOrder[];
  readonly titles: readonly TitleRef[];
  readonly machines: readonly MachineRef[];
  readonly stock: readonly StockLevelRef[];
  readonly stores?: readonly StoreRef[];
  readonly reportRecipients: readonly ReportRecipientRef[];
  readonly reportDeliveries: readonly ReportDeliveryRef[];
  /** Rapportutkast som inte godkänts (senaste versionen). Saknas = inga. */
  readonly reportDrafts?: readonly ReportDraftRef[];
  /**
   * Butiksavtal (inte arkiverade), för påminnelsen före sista uppsägningsdag och för
   * butiker med automat utan signerat kontrakt (mall och signering, se signed.ts).
   */
  readonly contracts?: readonly SignableContract[];
  /** Obetalda månadsavräkningar till butikerna. Saknas = inga. */
  readonly unpaidSettlements?: readonly SettlementRef[];
  /** Öppna larm. Bara okvitterade larm om automater och importer blir punkter. */
  readonly alerts?: readonly AlertRef[];
  /**
   * Sortimentets perioder (RPC:n lager_slot_periods). En utgången titel (se
   * ./assortment.ts) ger ingen påfyllningspunkt. Saknas = inga utgångna.
   */
  readonly slotPeriods?: readonly SlotPeriod[];
  /**
   * Larmgränser per automat och titel (tabellen slot_alerts). Saldo högst gränsen ger en
   * påfyllningspunkt även när takten inte flaggar. Saknas = inga gränser.
   */
  readonly slotAlerts?: readonly SlotAlert[];
  /**
   * Hur långt försäljningen är importerad per automat (som `salesCoverage` i maskinhälsan,
   * ISO 8601 UTC). En tyst automats tystnad räknas fram till dit i stället för till nu,
   * precis som på Drift, så att Att göra, Hem och Drift säger samma antal timmar.
   * Saknas = till nu.
   */
  readonly salesDataUntil?: readonly {
    readonly machineId: string;
    readonly until: string | null;
  }[];
  readonly options?: TodoOptions;
}

/** En sparad avbockning. Gäller så länge punktens fingerprint är oförändrat. */
export interface TodoDismissal {
  readonly key: string;
  readonly fingerprint: string;
  readonly dismissedAt?: string;
}
