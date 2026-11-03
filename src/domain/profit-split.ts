/**
 * Vinstdelning med butiken (avtal med `commissionBase` 'profit_after_costs').
 *
 * Räknas per butik, kalendermånad och avtal (den del av månaden avtalet gällde), på
 * butikens order med inköpspris:
 *
 *   försäljning  = Σ belopp inkl. moms − återbetalningar till kunder (på återbetalningsdagen)
 *   VMB-moms     = 20 % av max(0, försäljning − inköp)        (25/125, vinstmarginalbeskattning)
 *                  om avtalet drar av VMB före delningen (`vmbBeforeSplit`), annars 0 (standard)
 *   vinst        = försäljning − VMB-moms − inköp − kortavgifter
 *   butikens del = round(vinst × andel / 10 000)               vinst ≥ 0
 *                = 0                                          vinst < 0, förlust 'zero' (standard)
 *                = round(vinst × andel / 10 000) (negativ)    vinst < 0, förlust 'proportional'
 *   vår del      = vinst − butikens del
 *
 * Avrundning: halva öre bort från noll, EN gång per butik, månad och avtal (inte per order).
 * Liggaren fördelar butikens del på orderna (ledger.ts) så att alla vyer summerar rätt.
 */

import { DomainError } from "./errors";
import { applyBp, assertBp, assertNonNegativeInteger } from "./money";
import type { LossTreatment, StoreAgreement } from "./types";
import { VMB_RATE_PERCENT, vmbVatOfMargin } from "./vmb";

export { vmbVatOfMargin };

/** VMB-momsen är 25/125 = 20 % av en positiv marginal (inkl. moms), se vmb.ts. */
export const VMB_VAT_PERCENT = VMB_RATE_PERCENT;

/** Standardvillkor för nya avtal: 50 % av vinsten efter kostnader, förlust ger 0. */
export const DEFAULT_PROFIT_SHARE_BP = 5_000;

/** Sant om avtalet är en vinstdelning. */
export function isProfitSplit(agreement: StoreAgreement | null | undefined): boolean {
  return agreement?.commissionBase === "profit_after_costs";
}

export interface ProfitSplitInput {
  /** Σ belopp inkl. moms. */
  readonly salesInclVatOre: number;
  /** Σ återbetalningar till kunder i butiken (dras från försäljningen). Standard 0. */
  readonly refundsOre?: number;
  /** Σ inköpspris för de sålda packen. */
  readonly purchasesOre: number;
  /** Σ kortavgifter. */
  readonly cardFeesOre: number;
  /** Butikens andel i bp (5 000 = 50 %). */
  readonly shareBp: number;
  readonly lossTreatment: LossTreatment;
  /** Dra av VMB-moms från vinsten före delningen. Standard falskt (ingen VMB). */
  readonly vmbBeforeSplit?: boolean;
}

export interface ProfitSplitResult {
  /** Σ belopp inkl. moms (före återbetalningar). */
  readonly salesInclVatOre: number;
  /** Återbetalningar till kunder (0 i ögonblicksbilder från före 1.2.0). */
  readonly refundsOre: number;
  /** Försäljning − återbetalningar − inköp (underlaget för VMB-momsen). */
  readonly marginOre: number;
  /** VMB-momsen som dras före delningen (0 när avtalet inte drar av den). */
  readonly vmbVatOre: number;
  /** Avtalets val: VMB dras före delningen (saknas i ögonblicksbilder före 1.3.0 = sant). */
  readonly vmbBeforeSplit?: boolean;
  readonly purchasesOre: number;
  readonly cardFeesOre: number;
  /** Vinst efter kostnader (kan vara negativ). */
  readonly profitOre: number;
  readonly shareBp: number;
  readonly lossTreatment: LossTreatment;
  /** Butikens del (0 vid förlust med 'zero', negativ vid förlust med 'proportional'). */
  readonly storeShareOre: number;
  /** Operatörens del = vinst − butikens del. */
  readonly operatorShareOre: number;
}

/** Vinstdelningen för en butik, månad och avtal (se filhuvudet). */
export function profitSplit(input: ProfitSplitInput): ProfitSplitResult {
  assertNonNegativeInteger(input.salesInclVatOre, "Försäljningen");
  const refundsOre = input.refundsOre ?? 0;
  assertNonNegativeInteger(refundsOre, "Återbetalningarna");
  assertNonNegativeInteger(input.purchasesOre, "Inköpen");
  assertNonNegativeInteger(input.cardFeesOre, "Kortavgifterna");
  assertBp(input.shareBp, "Butikens andel");
  if (input.lossTreatment !== "zero" && input.lossTreatment !== "proportional") {
    throw new DomainError("invalid_input", "Okänd förlusthantering i avtalet.");
  }
  const netSalesOre = input.salesInclVatOre - refundsOre;
  const marginOre = netSalesOre - input.purchasesOre;
  const vmbBeforeSplit = input.vmbBeforeSplit === true;
  const vmbVatOre = vmbBeforeSplit ? vmbVatOfMargin(marginOre) : 0;
  const profitOre = netSalesOre - vmbVatOre - input.purchasesOre - input.cardFeesOre;
  const storeShareOre =
    profitOre >= 0 || input.lossTreatment === "proportional"
      ? applyBp(profitOre, input.shareBp)
      : 0;
  return {
    salesInclVatOre: input.salesInclVatOre,
    refundsOre,
    marginOre,
    vmbVatOre,
    vmbBeforeSplit,
    purchasesOre: input.purchasesOre,
    cardFeesOre: input.cardFeesOre,
    profitOre,
    shareBp: input.shareBp,
    lossTreatment: input.lossTreatment,
    storeShareOre: storeShareOre === 0 ? 0 : storeShareOre,
    operatorShareOre: profitOre - storeShareOre,
  };
}
