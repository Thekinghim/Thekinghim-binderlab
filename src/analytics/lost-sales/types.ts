/**
 * Typer för förlorad försäljning: perioder när en titel varit slutsåld i en automat och vad
 * det kostade i uteblivna intäkter.
 *
 * Belopp i öre, andelar och dagvikter i bp (10 000 = en hel dag), antal pack i tusendelar.
 */

import type { IsoDate, IsoMonth, OrderLine, Period, PurchasePrice, Settings } from "@/domain";
import type { PlanEvidence } from "../forecast/common";
import type { MachineRef, TitleRef } from "../todos/types";
import type { StockEventRef } from "./stock";

/** Inställningar. Alla har standardvärden (`LOST_SALES_DEFAULTS`). */
export interface LostSalesOptions {
  /** Dagar före slutförsäljningen som takten räknas på. Standard 28. */
  readonly rateWindowDays?: number;
  /**
   * Minsta antal dagar med data i takten. Heuristiken (saldot okänt) drar ingen slutsats
   * med färre dagar; perioder enligt lagret räknas ändå men markeras (`rate.lowData`).
   * Standard 7.
   */
  readonly minRateDays?: number;
  /** Hur stor del av påfyllningsdagen som räknas som slutsåld, i bp. Standard 5 000 (en halv dag). */
  readonly refillDayShareBp?: number;
  /**
   * Längsta period som räknas, i dagar. Är titeln slutsåld längre antas den ha tagits ur
   * sortimentet, och dagarna därefter kostar inget. Standard 28.
   */
  readonly maxOpenDays?: number;
  /** Använd heuristiken när saldot är okänt. Standard true. */
  readonly heuristic?: boolean;
  /** Heuristik: minsta antal dagar i rad utan försäljning. Standard 2. */
  readonly heuristicMinDays?: number;
  /** Heuristik: minsta väntade försäljning under dagarna, i tusendelar. Standard 3 000 (3 pack). */
  readonly heuristicMinExpectedMilli?: number;
  /** Heuristik: automaten ska ha sålt annat minst denna andel av dagarna, i bp. Standard 5 000. */
  readonly heuristicMinOtherSalesBp?: number;
}

/** Indata till `lostSales`. */
export interface LostSalesInput {
  /** Order (ett pack per order). */
  readonly orders: readonly OrderLine[];
  /** Lagerhändelser, inklusive försäljning (`sale`). Centrallagrets händelser ignoreras. */
  readonly stockEvents: readonly StockEventRef[];
  /** Perioden som kostnaden räknas för (t.ex. en eller flera hela månader). */
  readonly period: Period;
  /** Moms (intäkten räknas exklusive moms). */
  readonly settings: Settings;
  /** Inköpspriser, för förlorat bruttoresultat (intäkt − inköp). */
  readonly prices?: readonly PurchasePrice[];
  readonly titles?: readonly TitleRef[];
  readonly machines?: readonly MachineRef[];
  readonly options?: LostSalesOptions;
}

/**
 * Status för en dag:
 * - `available`: titeln fanns (saldo > 0 vid dagens början, eller försäljning skedde).
 * - `stockout`: saldo 0 hela dagen enligt lagerhändelserna.
 * - `refill-day`: saldo 0 vid dagens början, påfylld under dagen (räknas delvis).
 * - `probable-stockout`: saldot okänt, men heuristiken bedömer titeln som slutsåld.
 * - `unknown`: saldot okänt, ingen slutsats.
 * - `inactive`: automaten inte i drift, eller titeln ännu inte i automaten.
 */
export type StockDayStatus =
  "available" | "stockout" | "refill-day" | "probable-stockout" | "unknown" | "inactive";

/** En slutsåld dag (för prognosen: dagen ska inte räknas som efterfrågan 0). */
export interface StockoutDay {
  readonly machineId: string;
  readonly titleId: string;
  readonly date: IsoDate;
  readonly status: "stockout" | "refill-day" | "probable-stockout";
  /** Hur stor del av dagen som räknas som slutsåld, i bp. */
  readonly weightBp: number;
}

/** Takten före slutförsäljningen. */
export interface PreStockoutRate {
  readonly window: Period;
  /** Sålda pack under dagar med data i fönstret. */
  readonly units: number;
  /** Dagar med data i fönstret (inte slutsålt, i drift). */
  readonly days: number;
  /** Takt i tusendelar pack per dag. */
  readonly perDayMilli: number;
  /** Färre dagar än `minRateDays`. */
  readonly lowData: boolean;
}

/** En period då titeln var slutsåld i automaten. */
export interface StockoutPeriod {
  /** Stabil nyckel: 'stockout:<automat>:<titel>:<start>'. */
  readonly key: string;
  readonly machineId: string;
  readonly titleId: string;
  /** Hela perioden (kan börja före och sluta efter analysperioden). */
  readonly start: IsoDate;
  readonly end: IsoDate;
  /** Dagar i perioden. */
  readonly days: number;
  /** 'stock' = enligt lagerhändelserna, 'heuristic' = saldot okänt, bedömt ur försäljningen. */
  readonly source: "stock" | "heuristic";
  /** Perioden pågår fortfarande vid analysperiodens slut. */
  readonly ongoing: boolean;
  /** Perioden var längre än `maxOpenDays`; dagarna därefter räknas inte. */
  readonly capped: boolean;
  /** Dagar som kostar (inom analysperioden och inom `maxOpenDays`), summerad vikt i bp. */
  readonly lostDayWeightBp: number;
  readonly rate: PreStockoutRate;
  /** Snittpris exkl. moms per pack. `null` = saknas (kostnaden blir 0). */
  readonly avgPriceOre: number | null;
  readonly priceSource: "series" | "title" | "series-history" | "none";
  /** Förlorade pack, i tusendelar. */
  readonly lostUnitsMilli: number;
  /** Förlorad intäkt exkl. moms. */
  readonly lostRevenueOre: number;
  /** Förlorad intäkt minus inköp. `null` när inköpspris saknas. */
  readonly lostGrossProfitOre: number | null;
  /** Förlorad intäkt per månad (summerar exakt till `lostRevenueOre`). */
  readonly byMonth: readonly {
    readonly month: IsoMonth;
    readonly lostRevenueOre: number;
    readonly weightBp: number;
  }[];
  readonly text: string;
  readonly evidence: PlanEvidence;
}

/** Summa för en månad. */
export interface LostSalesMonth {
  readonly month: IsoMonth;
  /** Den del av månaden som ingår i analysperioden. */
  readonly period: Period;
  readonly partial: boolean;
  readonly lostRevenueOre: number;
  /** Förlorad intäkt minus inköp, för perioder med inköpspris. */
  readonly lostGrossProfitOre: number;
  /** Perioder där kostnaden eller bruttoresultatet inte kunde räknas (takt, snittpris eller inköpspris saknas). */
  readonly periodsWithoutCost: number;
  readonly lostUnitsMilli: number;
  /** Slutsålda dagar (summerad vikt i bp, 10 000 = en dag). */
  readonly stockoutDayWeightBp: number;
  /** Den del av `lostRevenueOre` som kommer från heuristiken (saldot okänt). */
  readonly heuristicLostRevenueOre: number;
  readonly periodKeys: readonly string[];
  /** "Slutsålt kostade ca 3 200 kr i oktober." */
  readonly text: string;
  /** Detaljer: antal perioder, automater, största post. */
  readonly detail: string;
  readonly evidence: PlanEvidence;
}

/** Resultatet av `lostSales`. */
export interface LostSalesResult {
  readonly period: Period;
  readonly periods: readonly StockoutPeriod[];
  readonly months: readonly LostSalesMonth[];
  readonly total: {
    readonly lostRevenueOre: number;
    readonly lostGrossProfitOre: number;
    readonly lostUnitsMilli: number;
    readonly stockoutDayWeightBp: number;
    /** Den del av `lostRevenueOre` som kommer från heuristiken (saldot okänt). */
    readonly heuristicLostRevenueOre: number;
    readonly text: string;
    readonly evidence: PlanEvidence;
  };
  /** Alla slutsålda dagar (även före analysperioden, inom det som räknades), för prognosen. */
  readonly stockoutDays: readonly StockoutDay[];
  /** Dagar då order fanns trots saldo 0 enligt lagret (registreringar saknas troligen). */
  readonly mismatches: readonly {
    readonly machineId: string;
    readonly titleId: string;
    readonly date: IsoDate;
  }[];
}
