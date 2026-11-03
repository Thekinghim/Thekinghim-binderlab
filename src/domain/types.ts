/**
 * Typer för beräkningslagret.
 *
 * Konventioner (gäller alla moduler i src/domain):
 * - Belopp anges i öre som heltal (`number`, alltid `Number.isSafeInteger`).
 *   Flyttal förekommer aldrig för pengar.
 * - Procentsatser anges i baspunkter (bp): 10 000 bp = 100 %, 2 500 bp = 25 %.
 * - Affärsdatum är strängar 'ÅÅÅÅ-MM-DD' (svensk kalenderdag, utan klockslag
 *   och utan tidszon). Månader är 'ÅÅÅÅ-MM'. Ingen funktion i lagret använder
 *   `Date`, så resultatet är detsamma oavsett processens tidszon.
 * - Alla intervall (perioder, avtal, placeringar) är inklusive i båda ändar:
 *   `to`/`validTo`/`end` är den sista dag som ingår. `null` betyder tills vidare.
 */

/** Affärsdatum 'ÅÅÅÅ-MM-DD' (svensk kalenderdag). */
export type IsoDate = string;

/** Kalendermånad 'ÅÅÅÅ-MM'. */
export type IsoMonth = string;

/** Belopp i öre (heltal). */
export type Ore = number;

/** Baspunkter (heltal), 10 000 = 100 %. */
export type Bp = number;

/** En order (alltid ett pack). Belopp inklusive eventuell moms, så som kunden betalade. */
export interface OrderLine {
  readonly id: string;
  /** Ordernumret i källan (Awish "Order No."). */
  readonly externalId: string;
  readonly titleId: string;
  /** Automaten. `null` om källans automat ännu inte är kopplad. */
  readonly machineId: string | null;
  /** Affärsdatum i Europe/Stockholm. */
  readonly businessDate: IsoDate;
  /** Betalt belopp inklusive moms, i öre. */
  readonly amountOre: Ore;
}

/** Inköpspris per order (= per pack) för en titel, giltigt från och med `validFrom`. */
export interface PurchasePrice {
  readonly titleId: string;
  readonly unitCostOre: Ore;
  readonly validFrom: IsoDate;
}

/**
 * Avtal med en butik. Minst en av provision och hyra är normalt satt; `null` räknas som 0.
 * `validTo` är sista giltiga dag (inklusive), `null` = tills vidare.
 */
export interface StoreAgreement {
  readonly storeId: string;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  /**
   * Andel i bp. Med `commissionBase` 'net_excl_vat' (standard när fältet saknas): provision
   * på nettointäkten per order. Med 'profit_after_costs': butikens andel av vinsten efter
   * kostnader, räknad per butik och månad (profit-split.ts).
   */
  readonly commissionBp: Bp | null;
  /** Månadshyra i öre. Delmånad räknas per dag. */
  readonly monthlyRentOre: Ore | null;
  /** Vad andelen räknas på. Saknas = 'net_excl_vat'. */
  readonly commissionBase?: CommissionBase;
  /** Vinstdelning med förlust: 'zero' (butiken får 0, standard) eller 'proportional'. */
  readonly lossTreatment?: LossTreatment;
}

/** Underlaget för butikens andel. */
export type CommissionBase = "net_excl_vat" | "profit_after_costs";

/** Vinstdelning när vinsten är negativ. */
export type LossTreatment = "zero" | "proportional";

/** Var en automat stod. `to` är sista dagen (inklusive), `null` = står kvar. */
export interface Placement {
  readonly machineId: string;
  readonly storeId: string;
  readonly from: IsoDate;
  readonly to: IsoDate | null;
}

/** Organisationens inställningar. */
export interface Settings {
  /** Momssats i bp (0 i dag). Beloppen i orderna antas inkludera momsen. */
  readonly vatRateBp: Bp;
  /** Kortavgift i bp på beloppet inklusive moms (0 i dag). */
  readonly cardFeeBp: Bp;
}

/** Period av hela affärsdagar, båda ändar inräknade. */
export interface Period {
  readonly start: IsoDate;
  readonly end: IsoDate;
}

/** Investering i en automat (inköp, installation …). */
export interface MachineInvestment {
  readonly machineId: string;
  readonly kind: "purchase" | "installation" | "other";
  readonly amountOre: Ore;
  readonly date: IsoDate;
  /** Linjär avskrivningstid i månader. `null` eller 0 = skrivs inte av. */
  readonly depreciationMonths: number | null;
}

/** Ägarandel i bp. Andelarna ska summera till 10 000. */
export interface OwnerShare {
  readonly id: string;
  readonly shareBp: Bp;
}

/** Hur lönsamheten grupperas. */
export type GroupBy = "title" | "machine" | "store" | "day" | "week" | "month";

/** Allt som behövs för att räkna ekonomin för en order. */
export interface EconomicsSources {
  readonly prices: readonly PurchasePrice[];
  readonly agreements: readonly StoreAgreement[];
  readonly placements: readonly Placement[];
  readonly settings: Settings;
  /**
   * Återbetalningar till kunder (kundärenden). Används bara av vinstdelningen: de dras från
   * butikens försäljning i den månad de betalades tillbaka (placeringen den dagen).
   * Saknas = inga återbetalningar.
   */
  readonly refunds?: readonly SourceRefund[];
}

/** En återbetalning som vinstdelningen drar från försäljningen (se refunds.ts). */
export interface SourceRefund {
  readonly machineId: string | null;
  readonly refundedOn: IsoDate;
  readonly amountOre: Ore;
}

/** Indata till lönsamhetsberäkningen. */
export interface ProfitabilityInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly period: Period;
}
