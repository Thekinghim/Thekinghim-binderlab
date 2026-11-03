/**
 * Moms med vinstmarginalbeskattning (VMB), samlad beräkning per redovisningsperiod (här
 * kalendermånad). Rena funktioner, belopp i öre.
 *
 *   marginal = försäljning inkl. moms − inköp i perioden − underskott från förra perioden
 *
 *   marginal > 0: moms = 20 % av marginalen (= 25/125), avrundad till hela ören (halva bort
 *                 från noll), beskattningsunderlag = marginal − moms, inget underskott.
 *   marginal ≤ 0: ingen moms, underlaget 0, underskottet (−marginal) förs till nästa månad.
 *
 * Underskottet förs vidare månad för månad (vmbChain). Avrundning till hela kronor görs först
 * i momsdeklarationen (Talenom).
 */

import { mulDivRound } from "@/domain";

export const VMB_RATE_PERCENT = 20;

export interface VmbInput {
  /** Försäljning inkl. moms i månaden (kan vara negativ vid fler återbetalningar). */
  readonly salesInclVatOre: number;
  /** Inköp av VMB-varor i månaden (≥ 0). */
  readonly purchasesOre: number;
  /** Underskott från förra månaden (≥ 0). */
  readonly carryInOre: number;
}

export interface VmbResult extends VmbInput {
  readonly marginOre: number;
  /** Utgående moms VMB. */
  readonly vatOre: number;
  /** Beskattningsunderlag (marginalen exkl. moms). */
  readonly baseOre: number;
  /** Underskott till nästa månad (≥ 0). */
  readonly carryOutOre: number;
}

function assertInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} måste vara ett heltal i öre.`);
}

/** VMB för en månad (se filhuvudet). */
export function vmbVat(input: VmbInput): VmbResult {
  assertInt(input.salesInclVatOre, "Försäljningen");
  assertInt(input.purchasesOre, "Inköpen");
  assertInt(input.carryInOre, "Underskottet");
  if (input.purchasesOre < 0) throw new RangeError("Inköpen kan inte vara negativa.");
  if (input.carryInOre < 0) throw new RangeError("Underskottet kan inte vara negativt.");
  const marginOre = input.salesInclVatOre - input.purchasesOre - input.carryInOre;
  if (marginOre <= 0) {
    return { ...input, marginOre, vatOre: 0, baseOre: 0, carryOutOre: -marginOre || 0 };
  }
  const vatOre = mulDivRound(marginOre, VMB_RATE_PERCENT, 100);
  return { ...input, marginOre, vatOre, baseOre: marginOre - vatOre, carryOutOre: 0 };
}

export interface VmbMonthInput {
  readonly month: string;
  readonly salesInclVatOre: number;
  readonly purchasesOre: number;
  /**
   * Underskottet som redan redovisats ut från månaden (en skickad månad): nästa månad
   * fortsätter från det, även om siffrorna ändrats sedan.
   */
  readonly fixedCarryOutOre?: number | null;
}

/**
 * VMB för månaderna i ordning (äldst först), med underskottet fört vidare. `openingCarryOre`
 * är underskottet in i den första månaden.
 */
export function vmbChain(
  months: readonly VmbMonthInput[],
  openingCarryOre = 0,
): Map<string, VmbResult> {
  const sorted = [...months].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const out = new Map<string, VmbResult>();
  let carry = openingCarryOre;
  for (const m of sorted) {
    const r = vmbVat({
      salesInclVatOre: m.salesInclVatOre,
      purchasesOre: m.purchasesOre,
      carryInOre: carry,
    });
    out.set(m.month, r);
    carry =
      m.fixedCarryOutOre !== undefined && m.fixedCarryOutOre !== null
        ? m.fixedCarryOutOre
        : r.carryOutOre;
  }
  return out;
}
