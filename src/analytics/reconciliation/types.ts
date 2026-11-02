/**
 * Typer för avstämningen av leverantörens utbetalningar mot försäljningen.
 *
 * Belopp i öre (heltal), affärsdatum 'ÅÅÅÅ-MM-DD' i Europe/Stockholm, perioder inklusive
 * i båda ändar. Tidpunkter (orderns betaltid) är ISO 8601-strängar MED tidszon.
 */

import type { IsoDate, IsoMonth, Period, Settings } from "@/domain";
import type { AnalyticsOrder } from "../todos/types";
import type { FinanceEvidence } from "./common";

/** En rad i leverantörens utbetalningsspecifikation (om den finns): en betald order. */
export interface PayoutLine {
  /** Ordernumret i källan (Awish "Order No."), samma som `OrderLine.externalId`. */
  readonly externalId: string;
  /** Belopp som leverantören räknat för ordern, i öre (inkl. moms). */
  readonly amountOre: number;
}

/** En utbetalning från leverantören (betalväxeln) för en försäljningsperiod. */
export interface Payout {
  /** Leverantörens referens. Ska vara unik; samma referens två gånger räknas som dubblett. */
  readonly reference: string;
  /** Försäljningsperioden som utbetalningen avser: { start, end } eller en månad 'ÅÅÅÅ-MM'. */
  readonly period: Period | IsoMonth;
  /** Utbetalt belopp i öre (efter avgifter och återbetalningar). Kan vara negativt. */
  readonly amountOre: number;
  /** Avgifter som leverantören drog, i öre. */
  readonly feesOre: number;
  /**
   * Återbetalningar som leverantören drog, i öre. Saknas värdet antas leverantören ha dragit
   * precis de återbetalningar vi känner till (`refunds`) i perioden.
   */
  readonly refundsOre?: number;
  /** Dagen då pengarna kom in (för kassaflödet). Saknas den används periodens sista dag. */
  readonly paidOn?: IsoDate | null;
  /** Specifikation per order, om leverantören lämnar en. Ger exakta förklaringar per order. */
  readonly lines?: readonly PayoutLine[];
}

/** En återbetalning till en kund. (Förekommer inte i dag, men avstämningen klarar dem.) */
export interface Refund {
  readonly id: string;
  /** Affärsdatum då återbetalningen gjordes; avgör vilken utbetalning den dras från. */
  readonly date: IsoDate;
  readonly amountOre: number;
  /** Ordern som återbetalades, om den är känd. */
  readonly orderId?: string | null;
}

/** Hur en avvikelse har hanterats. */
export type DeviationStatus = "open" | "investigated";

/** En sparad utredning ("status utredd") av en avvikelse. */
export interface DeviationResolution {
  /** Avvikelsens nyckel (`Deviation.key`). */
  readonly key: string;
  /**
   * Avvikelsens fingerprint när den utreddes. Anges det gäller utredningen bara så länge
   * avvikelsen är oförändrad (samma belopp och antal order). Utelämnat = gäller alltid.
   */
  readonly fingerprint?: string;
  /** Vad som kom fram, t.ex. "Leverantören krediterar i december". */
  readonly note: string;
  readonly resolvedBy?: string | null;
  /** Tidpunkt (ISO 8601) eller datum. Visas bara, används inte i beräkningen. */
  readonly resolvedAt?: string | null;
}

/** Typ av avvikelse. */
export type DeviationKind =
  /** Leverantörens avgifter skiljer sig från de avgifter inställningarna ger. */
  | "fee"
  /** Leverantörens återbetalningar skiljer sig från de återbetalningar vi känner till. */
  | "refund"
  /** Order som leverantören betalat ut men som saknas i vår import. */
  | "missing-in-sales"
  /** Order som finns i vår import men som leverantören inte betalat ut. */
  | "missing-in-payout"
  /** Samma order två gånger i vår import (samma ordernummer, olika id). */
  | "duplicate-order"
  /** Samma utbetalning, rad eller dag betalad två gånger. */
  | "duplicate-payout"
  /** Ordern finns på båda sidor men med olika belopp. */
  | "amount-mismatch"
  /** Ordern hamnar i en annan period hos leverantören på grund av tidszonen (jämnas ut nästa period). */
  | "timezone-shift"
  /** Ordern hamnar i en annan period hos leverantören, men tidszonen förklarar det inte. */
  | "period-shift"
  /** Försäljning som ingen utbetalning täcker. */
  | "missing-payout"
  /** Det som återstår när allt annat är förklarat. */
  | "unexplained";

/** Hur säker förklaringen är. */
export type DeviationConfidence =
  /** Belagd order för order (utbetalningsspecifikation, dubblett, tidszon, avgift). */
  | "confirmed"
  /** Härledd ur beloppen (t.ex. skillnaden är exakt 3 order à 49 kr). */
  | "inferred";

/** En avvikelse med förklaring och underlag. */
export interface Deviation {
  /** Stabil nyckel: '<utbetalningens nyckel>:<typ>' eller 'missing-payout:<månad>'. */
  readonly key: string;
  /** Ändras när avvikelsens belopp eller antal order ändras; då gäller inte en tidigare utredning. */
  readonly fingerprint: string;
  /** Utbetalningens nyckel, `null` för försäljning utan utbetalning. */
  readonly payoutKey: string | null;
  readonly kind: DeviationKind;
  readonly confidence: DeviationConfidence;
  /**
   * Avvikelsens påverkan på skillnaden (utbetalt − väntat), i öre. Positivt = leverantören
   * betalade mer än väntat. Summan av en utbetalnings avvikelser + avrundning = skillnaden.
   */
  readonly impactOre: number;
  /** Antal order som avvikelsen gäller (0 om den inte gäller enskilda order). */
  readonly orderCount: number;
  /** Sant om någon behöver göra något (allt utom tidszonsförskjutning, som jämnas ut). */
  readonly requiresAction: boolean;
  /** Kort rubrik, t.ex. "2 order saknas i utbetalningen". */
  readonly title: string;
  /** Förklaringen med siffror. */
  readonly explanation: string;
  readonly status: DeviationStatus;
  readonly resolution: DeviationResolution | null;
  readonly evidence: FinanceEvidence;
}

/** Status för en utbetalning. */
export type PayoutStatus =
  /** Utbetalningen stämmer exakt (inom toleransen) och inget behöver förklaras. */
  | "matched"
  /** Skillnaden förklaras helt av tidszonsförskjutning som jämnas ut. */
  | "explained"
  /** Det finns avvikelser som ingen har utrett. */
  | "deviation"
  /** Alla avvikelser är utredda. */
  | "investigated";

/** Väntade belopp för en utbetalning, räknade på vår försäljning. */
export interface ExpectedPayout {
  /** Antal order i perioden (dagar som inte redan täcks av en tidigare utbetalning). */
  readonly orders: number;
  /** Försäljning (betalt belopp inkl. moms). */
  readonly salesOre: number;
  readonly feesOre: number;
  readonly refundsOre: number;
  /** Väntad utbetalning = försäljning − avgifter − återbetalningar. */
  readonly payoutOre: number;
}

/** Leverantörens belopp. */
export interface ActualPayout {
  readonly payoutOre: number;
  readonly feesOre: number;
  readonly refundsOre: number;
  /** Försäljning enligt leverantören = utbetalt + avgifter + återbetalningar. */
  readonly salesOre: number;
}

/** Avstämningen av en utbetalning. */
export interface PayoutReconciliation {
  /** Referensen, eller '<referens>#2' för en andra utbetalning med samma referens. */
  readonly key: string;
  readonly reference: string;
  readonly period: Period;
  readonly paidOn: IsoDate;
  readonly status: PayoutStatus;
  readonly expected: ExpectedPayout;
  readonly actual: ActualPayout;
  /** Utbetalt − väntat, i öre. */
  readonly differenceOre: number;
  /** Den del av skillnaden som ligger inom toleransen och inte visas som avvikelse. */
  readonly roundingOre: number;
  readonly deviations: Deviation[];
  /** Referenser till tidigare utbetalningar vars period överlappar denna. */
  readonly overlapsWith: string[];
  /** Sammanfattning med siffror, t.ex. "1–30 nov.: utbetalt 1 234,00 kr, väntat …". */
  readonly summary: string;
  readonly evidence: FinanceEvidence;
}

/** Inställningar för avstämningen. */
export interface ReconciliationOptions {
  /**
   * Tidszonen som leverantören räknar perioder i (datakällans `source_timezone`, t.ex.
   * 'Asia/Shanghai'). `null`/utelämnad = samma kalenderdagar som vi; då letas ingen
   * tidszonsförskjutning.
   */
  readonly providerTimeZone?: string | null;
  /** Organisationens tidszon (för klockslag i texterna). Standard 'Europe/Stockholm'. */
  readonly timeZone?: string;
  /** Avgift i bp på belopp inkl. moms. Standard: inställningens `cardFeeBp`. */
  readonly feeBp?: number;
  /** Fast avgift per order i öre. Standard 0. */
  readonly fixedFeePerOrderOre?: number;
  /**
   * Skillnad (i öre, absolut) som räknas som avrundning och inte visas. Gäller avgiftsavvikelsen
   * och den oförklarade resten tillsammans (t.ex. leverantören avrundar avgiften på totalen och
   * vi per order); avvikelser på enskilda order visas alltid. Standard 0.
   */
  readonly toleranceOre?: number;
  /**
   * Intervall där all försäljning ska täckas av utbetalningar. Standard: från den första
   * utbetalningens start till den sista utbetalningens slut.
   */
  readonly coverage?: Period | IsoMonth | null;
  /** Högst så många order för att en skillnad ska tolkas som saknade order. Standard 20. */
  readonly maxInferredOrders?: number;
}

/** Indata till `reconcilePayouts`. */
export interface ReconciliationInput {
  /** Vår försäljning (alla order, även utanför perioderna: behövs för tidszon och dubbletter). */
  readonly orders: readonly AnalyticsOrder[];
  readonly payouts: readonly Payout[];
  readonly refunds?: readonly Refund[];
  /** Organisationens inställningar; kortavgiften är den väntade avgiften. */
  readonly settings: Settings;
  readonly resolutions?: readonly DeviationResolution[];
  readonly options?: ReconciliationOptions;
}

/** Resultatet av `reconcilePayouts`. */
export interface ReconciliationResult {
  readonly payouts: PayoutReconciliation[];
  /** Försäljning som ingen utbetalning täcker (per månad). */
  readonly uncovered: Deviation[];
  readonly totals: {
    readonly expectedOre: number;
    readonly actualOre: number;
    readonly differenceOre: number;
    /** Avvikelser som kräver åtgärd och inte är utredda. */
    readonly openDeviations: number;
    readonly investigatedDeviations: number;
    /** Utbetalningar per status. */
    readonly byStatus: Readonly<Record<PayoutStatus, number>>;
  };
  /**
   * Utredningar som inte längre gäller: avvikelsen har ändrats (annat fingerprint) eller
   * finns inte längre. UI kan visa "Avvikelsen har ändrats sedan den utreddes".
   */
  readonly staleResolutions: DeviationResolution[];
  /** En mening om läget, t.ex. "3 utbetalningar stämmer, 1 har avvikelser att utreda (−98,00 kr)". */
  readonly summary: string;
  readonly evidence: FinanceEvidence;
}
