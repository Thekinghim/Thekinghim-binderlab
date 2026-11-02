/**
 * Typer för avtal med butiker (tabellen `contracts`, fas 9): giltighet, uppsägningstid,
 * automatisk förlängning, påminnelser och hur stor del av intäkten som ligger på avtal
 * som snart löper ut.
 *
 * Datum är affärsdatum 'ÅÅÅÅ-MM-DD', intervall inklusive i båda ändar.
 */

import type { EconomicsSources, IsoDate, OrderLine, Period } from "@/domain";
import type { FinanceEvidence } from "../reconciliation/common";
import type { StoreRef } from "../todos/types";

/** Ett avtal med en butik. */
export interface Contract {
  readonly id: string;
  readonly storeId: string;
  /** Visningsnamn, t.ex. "Placeringsavtal 2026". */
  readonly name?: string | null;
  readonly validFrom: IsoDate;
  /** Sista dagen i avtalsperioden (inklusive), `null` = tills vidare. */
  readonly validTo: IsoDate | null;
  /** Uppsägningstid i hela månader före avtalets slut. */
  readonly noticeMonths?: number | null;
  /** Uppsägningstid i dagar (läggs till månaderna). */
  readonly noticeDays?: number | null;
  /**
   * Förlängs automatiskt med så många månader om det inte sägs upp i tid. `null`/utelämnad
   * = förlängs inte.
   */
  readonly renewalMonths?: number | null;
  /** Dag då avtalet sades upp (av oss eller butiken). Då förlängs det inte längre. */
  readonly terminatedOn?: IsoDate | null;
}

/** Var avtalet står i dag. */
export type ContractStatus =
  /** Avtalet har inte börjat gälla. */
  | "not-started"
  /** Gäller tills vidare, inget slutdatum. */
  | "open-ended"
  /** Påminnelsen ligger framåt i tiden. */
  | "scheduled"
  /** Påminnelsen har kommit: säg upp eller omförhandla före sista dagen. */
  | "due"
  /** Sista dagen för uppsägning har passerat; avtalet löper ut eller förlängs. */
  | "notice-passed"
  /** Uppsagt och upphör vid periodens slut. */
  | "terminated"
  /** Har gått ut. */
  | "expired";

/** Avtalets nuvarande period. */
export interface ContractTerm {
  readonly contractId: string;
  readonly storeId: string;
  /** Början på nuvarande avtalsperiod (efter eventuella förlängningar). */
  readonly termStart: IsoDate;
  /** Slutet på nuvarande avtalsperiod, `null` = tills vidare. */
  readonly currentEnd: IsoDate | null;
  /** Sista dag att säga upp för att avtalet ska sluta `currentEnd`. */
  readonly noticeDeadline: IsoDate | null;
  /** Dag då påminnelsen visas. */
  readonly reminderDate: IsoDate | null;
  /** Sant om avtalet förlängs automatiskt vid `currentEnd` (inte uppsagt). */
  readonly renews: boolean;
  /** Slut efter nästa förlängning, om avtalet förlängs. */
  readonly nextEnd: IsoDate | null;
  /** Antal förlängningar som redan skett. */
  readonly renewals: number;
}

/** Inställningar för påminnelser. */
export interface ContractReminderOptions {
  /** Dagar före sista dagen (eller slutet) som påminnelsen visas. Standard 90. */
  readonly reminderLeadDays?: number;
  /**
   * Vad påminnelsen räknas från: 'notice-deadline' (sista dag att säga upp, standard) eller
   * 'end' (avtalets slut). Med uppsägningstid 0 är de samma.
   */
  readonly reminderBasis?: "notice-deadline" | "end";
}

/** En påminnelse (eller status) för ett avtal. */
export interface ContractReminder {
  /** Stabil nyckel per avtal och avtalsperiod: 'contract:<id>:<slut>'. */
  readonly key: string;
  /** Ändras när status, slut eller sista uppsägningsdag ändras. */
  readonly fingerprint: string;
  readonly contractId: string;
  readonly storeId: string;
  readonly status: ContractStatus;
  readonly term: ContractTerm;
  /**
   * Redan tecknat avtal som tar vid utan lucka (se `contractSuccessor`), annars `null`.
   * Finns det och avtalet inte förlängs automatiskt behöver avtalet inte åtgärdas.
   */
  readonly successor: {
    readonly contractId: string;
    readonly validFrom: IsoDate;
    readonly currentEnd: IsoDate | null;
  } | null;
  /** Dagar kvar till sista uppsägningsdag (negativt = passerad). */
  readonly daysToDeadline: number | null;
  /** Dagar kvar till slutet (negativt = har gått ut). */
  readonly daysToEnd: number | null;
  readonly title: string;
  readonly detail: string;
  readonly evidence: FinanceEvidence;
}

/** Indata till `contractReminders`. */
export interface ContractReminderInput {
  readonly contracts: readonly Contract[];
  /** I dag. */
  readonly asOf: IsoDate;
  readonly stores?: readonly StoreRef[];
  readonly options?: ContractReminderOptions;
}

/** Resultatet av `contractReminders`. */
export interface ContractReminderResult {
  /** Alla avtal, sorterade efter sista uppsägningsdag (eller slut). */
  readonly reminders: ContractReminder[];
  /** De som kräver något nu: status 'due', eller 'notice-passed' för avtal som inte förlängs. */
  readonly due: ContractReminder[];
  readonly summary: string;
}

/** Hur butikens intäkt klassas i översikten. */
export type ExpiringCategory =
  /** Gällande avtal löper ut inom horisonten. */
  | "expiring"
  /** Gällande avtal löper längre eller tills vidare. */
  | "secure"
  /** Butiken har intäkt men inget gällande avtal i dag. */
  | "no-contract";

/** En butik i översikten. */
export interface ExpiringStoreRow {
  readonly storeId: string;
  readonly category: ExpiringCategory;
  readonly contractId: string | null;
  /** Nettointäkt (alla order) i fönstret. */
  readonly revenueOre: number;
  /** Andel av total nettointäkt i fönstret, bp. */
  readonly shareBp: number | null;
  /** Slutet på det gällande avtalets nuvarande period. */
  readonly currentEnd: IsoDate | null;
  /**
   * Sista dagen butiken har avtal, med redan tecknade efterföljande avtal utan lucka
   * (`null` = tills vidare). Avgör kategorin.
   */
  readonly coveredUntil: IsoDate | null;
  /** Efterföljande avtal som redan är tecknade, i ordning. */
  readonly successorIds: string[];
  readonly noticeDeadline: IsoDate | null;
  /** Sant om det sista avtalet i kedjan förlängs automatiskt. */
  readonly renews: boolean;
  readonly evidence: FinanceEvidence;
}

/** Indata till `expiringRevenueOverview`. */
export interface ExpiringRevenueInput extends EconomicsSources {
  readonly contracts: readonly Contract[];
  readonly orders: readonly OrderLine[];
  /** I dag. Fönstret slutar i går. */
  readonly asOf: IsoDate;
  readonly stores?: readonly StoreRef[];
  /** Avtal som löper ut inom så många månader räknas. Standard 12. */
  readonly horizonMonths?: number;
  /** Intäkten de senaste så många månaderna. Standard 12. */
  readonly windowMonths?: number;
}

/** Resultatet av `expiringRevenueOverview`. */
export interface ExpiringRevenueOverview {
  /** Intäktsfönstret (t.ex. 2 nov. 2025 – 1 nov. 2026). */
  readonly window: Period;
  /** Avtal som slutar t.o.m. denna dag räknas som "löper ut". */
  readonly horizonEnd: IsoDate;
  readonly totalRevenueOre: number;
  readonly expiringRevenueOre: number;
  /** Andel av intäkten på avtal som löper ut inom horisonten, bp. `null` utan intäkt. */
  readonly expiringShareBp: number | null;
  /** Den del av `expiringRevenueOre` vars avtal förlängs automatiskt om ingen säger upp. */
  readonly renewingRevenueOre: number;
  readonly noContractRevenueOre: number;
  readonly noContractShareBp: number | null;
  /** Intäkt från automater utan butik (inte placerade eller inte kopplade). */
  readonly noStoreRevenueOre: number;
  /** Butiker med intäkt eller gällande avtal, störst intäkt först. */
  readonly stores: ExpiringStoreRow[];
  readonly summary: string;
  readonly evidence: FinanceEvidence;
}
