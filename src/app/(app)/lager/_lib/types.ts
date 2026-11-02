/**
 * Vymodellen för Lager. Allt här skickas till klienten och innehåller därför bara
 * antal, datum och namn: inga belopp, priser eller avtal, för någon roll.
 * Testet i test/db/lager-data.test.ts kontrollerar det för påfyllaren.
 */

import type { IsoDate } from "@/domain";

/** Status i en cell. Alltid med text i vyn (Kritisk, Låg, OK). */
export type StockStatus = "critical" | "low" | "ok";

export interface LagerMachine {
  readonly id: string;
  /** "BL-002" */
  readonly code: string;
  readonly name: string;
  /** Butikens namn i dag, eller null. */
  readonly storeName: string | null;
}

export interface LagerTitle {
  readonly id: string;
  readonly name: string;
}

/** En cell i matrisen: en titel i en automat. */
export interface StockCell {
  readonly machineId: string;
  readonly titleId: string;
  /** false = titeln finns inte i automaten (ingen saldorad och ingen försäljning). */
  readonly stocked: boolean;
  /** Pack i automaten nu (aldrig under 0 i vyn). */
  readonly onHand: number;
  /** Försäljningstakt i pack per dag, tiondelar (23 = 2,3), eller null utan försäljning. */
  readonly perDayTenths: number | null;
  /** Hela dagar lagret räcker (domain.daysOfStockLeft), eller null när takten är 0. */
  readonly daysLeft: number | null;
  /** Beräknat slutdatum, eller null. */
  readonly stockoutDate: IsoDate | null;
  readonly status: StockStatus;
  /** Pack att ta med enligt påfyllningslistan (besök i dag). */
  readonly suggested: number;
  /** Senaste påfyllning eller inventering (ISO 8601), eller null. */
  readonly lastRestockedAt: string | null;
}

/** En rad i centrallagret. */
export interface WarehouseRow {
  readonly titleId: string;
  readonly onHand: number;
  /** Alla automaters takt tillsammans (tiondelar pack per dag), eller null. */
  readonly perDayTenths: number | null;
  /** Hela dagar centrallagret räcker vid den takten, eller null. */
  readonly daysLeft: number | null;
  /** Pack som besöken den kommande veckan behöver (besöksplanen). */
  readonly weekNeed: number;
  /** Pack som saknas för veckans besök. */
  readonly shortBy: number;
  readonly status: StockStatus;
  readonly lastCountedAt: string | null;
}

/** En rad i påfyllningslistan. */
export interface PackListLine {
  readonly titleId: string;
  readonly titleName: string;
  /** Pack att ta med. */
  readonly quantity: number;
  readonly onHand: number;
  /** Mål efter påfyllning. */
  readonly target: number;
  /** Pack som saknas i centrallagret för att nå målet. */
  readonly shortBy: number;
}

/** Påfyllningslistan för en automat, för ett besök i dag. */
export interface PackList {
  readonly machineId: string;
  readonly lines: PackListLine[];
  readonly totalPacks: number;
  readonly shortBy: number;
  /** Senaste dag för nästa besök enligt veckoplanen, eller null om inget behövs. */
  readonly needBy: IsoDate | null;
  /** Planerad besöksdag i veckoplanen, eller null. */
  readonly plannedDay: IsoDate | null;
  /** Orsakerna ur besöksplanen, t.ex. "Black bolt tar slut tor 5 nov. (3 kvar, 1,2 pack/dag)". */
  readonly reasons: string[];
}

export type HistoryKind =
  "refill" | "count" | "waste" | "adjustment" | "transfer_in" | "transfer_out" | "receipt";

/** En rad i historiken. */
export interface HistoryEntry {
  readonly id: string;
  readonly kind: HistoryKind;
  /** Förändring, eller räknat antal vid inventering. */
  readonly quantity: number;
  readonly occurredAt: string;
  readonly titleId: string;
  readonly titleName: string;
  /** Automaten, eller null för centrallagret. */
  readonly machineId: string | null;
  /** Automatens kod ("BL-002"), eller null för centrallagret. */
  readonly machineCode: string | null;
  /** Namnet på den som registrerade, eller null om okänt. */
  readonly performer: string | null;
  /** Sant om det var den inloggade användaren. */
  readonly isSelf: boolean;
  readonly note: string | null;
  /** Påfyllning som drogs ur centrallagret. */
  readonly fromWarehouse: boolean;
}

/** Allt sidan visar. */
export interface LagerView {
  readonly today: IsoDate;
  readonly now: string;
  readonly timeZone: string;
  /** Takten räknas över de här dagarna (t.o.m. i går). */
  readonly window: { readonly start: IsoDate; readonly end: IsoDate; readonly days: number };
  /** Gränsen för Låg i tiondelar dagar (25 = 2,5 dagar). */
  readonly lowThresholdTenths: number;
  readonly machines: LagerMachine[];
  readonly titles: LagerTitle[];
  /** cells[i][j] = titles[i] i machines[j]. */
  readonly cells: StockCell[][];
  readonly hasWarehouse: boolean;
  readonly warehouse: WarehouseRow[];
  readonly packLists: PackList[];
  readonly history: HistoryEntry[];
  /** Antal händelser i perioden (historiken visar högst HISTORY_LIMIT). */
  readonly historyTotal: number;
  readonly counts: { readonly critical: number; readonly low: number; readonly ok: number };
  /** Rättigheter: påfyllning och inventering (ägare, admin, påfyllare). */
  readonly canRegister: boolean;
}

export const HISTORY_LIMIT = 30;
