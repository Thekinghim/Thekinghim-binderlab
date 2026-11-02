/**
 * Vymodeller som Butikers sidor och klientkomponenter delar. Belopp i öre, datum
 * 'ÅÅÅÅ-MM-DD'. Allt räknas på servern (./model, @/domain); klienten formaterar bara.
 */

import type { IsoDate } from "@/domain";

/** Ersättningsmodellen i ett avtal. */
export type CompensationModel = "commission" | "rent" | "both";

/** Var ett avtal står i förhållande till i dag. */
export type AgreementState = "current" | "upcoming" | "ended";

/** En butik i registret (stamdata, alla fält som går att redigera). */
export interface StoreDetail {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly city: string | null;
  readonly contactName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly isExample: boolean;
  readonly archived: boolean;
}

/** Ett avtal (store_agreements) med färdiga texter. */
export interface AgreementView {
  readonly id: string;
  readonly storeId: string;
  readonly contractId: string | null;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly commissionBp: number | null;
  readonly monthlyRentOre: number | null;
  readonly note: string | null;
  readonly model: CompensationModel;
  readonly state: AgreementState;
  /** "Provision 12 % · hyra 750 kr/mån". */
  readonly termsLabel: string;
  /** "1 okt. 2026 – tills vidare". */
  readonly periodLabel: string;
}

/** En rad i butikslistan. */
export interface StoreRow {
  readonly id: string;
  readonly name: string;
  readonly place: string | null;
  readonly isExample: boolean;
  readonly archived: boolean;
  /** Automater som står i butiken i dag. */
  readonly machineCodes: readonly string[];
  readonly orders: number;
  /** Intäkt i perioden (alla order). */
  readonly revenueOre: number;
  /** Intäkt i jämförelseperioden, eller null utan jämförelse. */
  readonly previousRevenueOre: number | null;
  /** Förändring mot jämförelseperioden som andel (0,12 = +12 %), eller null. */
  readonly revenueChange: number | null;
  /** Butiksersättning i perioden (provision + hyra). */
  readonly compensationOre: number;
  /** Vinst för prissatta order i perioden. */
  readonly profitOre: number;
  /** Hittills intjänad ersättning denna månad. */
  readonly earnedMonthOre: number;
  /** Avtalet som gäller i dag, eller null. */
  readonly current: AgreementView | null;
  /** Något som kräver åtgärd (inget avtal trots automat). */
  readonly flag: string | null;
  readonly href: string;
}

/** Hittills intjänad ersättning denna månad för en butik. */
export interface MonthCompensation {
  /** "november 2026". */
  readonly monthLabel: string;
  /** Första dagen i månaden och i dag. */
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly days: number;
  readonly daysInMonth: number;
  readonly revenueOre: number;
  readonly orders: number;
  readonly commissionOre: number;
  readonly rentOre: number;
  readonly totalOre: number;
}

/** En automat som står eller har stått i butiken. */
export interface StoreMachineRow {
  readonly placementId: string;
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly from: IsoDate;
  readonly to: IsoDate | null;
  readonly current: boolean;
  readonly orders: number;
  readonly revenueOre: number;
  readonly href: string;
}

/** Rapportmottagare för butiken (report_recipients med kind = store). */
export interface RecipientView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly active: boolean;
  /** Senaste lyckade utskick (ISO 8601), eller null. */
  readonly lastSentAt: string | null;
}

/** Punkt som kräver åtgärd eller uppmärksamhet på butikens sida. */
export interface StoreIssue {
  readonly id: string;
  readonly level: "critical" | "warning" | "neutral";
  readonly text: string;
}

/** Nyckeltal (formateras i klienten). */
export interface KpiView {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly kind: "sek" | "int" | "percent";
  readonly primary?: boolean;
  readonly delta?: { readonly kind: "relative" | "absolute"; readonly value: number } | null;
  readonly trend?: readonly number[];
}

/** Intäkt en dag, i kronor (för diagrammet). */
export interface DailyPoint {
  readonly date: IsoDate;
  readonly value: number;
}
