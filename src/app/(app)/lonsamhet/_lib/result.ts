/**
 * Lönsamhet efter vinsten: återbetalningar och fasta kostnader som egna rader under
 * vattenfallet, utan att ändra det.
 *
 *   vinst                         = profitability() (samma som vattenfallet och tabellen)
 *   − återbetalningar             = @/domain/refunds (applyRefunds): på återbetalningsdagen,
 *                                   automaten och butiken där automaten stod den dagen
 *   = vinst efter återbetalningar
 *   − gratis-pack                 = koder i Awish (free_pack_batches): inköpspris × antal på
 *                                   skapelsedagen, automaten och butiken den dagen
 *   − fasta kostnader             = @/analytics/cashflow (profitabilityWithFixedCosts):
 *                                   periodiserade, gemensamma fördelade efter nettointäkt
 *   = resultat
 *
 * Intäkt, inköp, avgifter och butiksersättning ändras inte, så vattenfallet och tabellerna
 * på sidan går fortfarande ihop. Per automat summerar raderna till totalen (testas).
 *
 * Filter: med automatfilter (även när butiken också står i adressen) gäller automatens återbetalningar och dess del av de fasta
 * kostnaderna (fördelningen räknas alltid på hela organisationen, `organization`). Med
 * butiksfilter gäller butikens återbetalningar; fasta kostnader fördelas per automat, inte
 * per butik, och visas därför inte (`fixedCost: null`).
 */

import {
  profitabilityWithFixedCosts,
  type FixedCost,
  type FixedCostAllocation,
} from "@/analytics/cashflow";
import {
  DomainError,
  profitability,
  ratioBp,
  sumOre,
  type IsoDate,
  type ProfitabilityInput,
} from "@/domain";
import { applyRefunds, summarizeRefunds, type Refund } from "@/domain/refunds";

/** Gratis-pack i samma form som en återbetalning (samma fördelning per automat och butik). */
function asRefunds(packs: readonly FreePackCost[]): Refund[] {
  return packs.map((p) => ({
    id: p.id,
    machineId: p.machineId,
    titleId: p.titleId,
    refundedOn: p.day,
    amountOre: p.costOre,
  }));
}

/** Gratis-pack som kostnad (free_pack_batches med status created och pris). */
export interface FreePackCost {
  readonly id: string;
  readonly machineId: string;
  readonly titleId: string | null;
  /** Skapelsedagen (affärsdatum). */
  readonly day: IsoDate;
  /** Inköpspris × antal, öre. */
  readonly costOre: number;
  /** Antal pack. */
  readonly packs: number;
}

export interface ResultMachineRow {
  /** Automatens id, eller 'none' / 'unallocated' / 'no-machine' för rader utan automat. */
  readonly key: string;
  readonly profitOre: number;
  readonly refundOre: number;
  readonly freePackOre: number;
  readonly fixedCostOre: number;
  readonly resultOre: number;
}

export interface ResultAfterProfit {
  readonly profitOre: number;
  readonly refundOre: number;
  readonly refundCount: number;
  readonly profitAfterRefundsOre: number;
  /** Gratis-pack (inköpspris) i urvalet och antal pack. */
  readonly freePackOre: number;
  readonly freePackCount: number;
  /** Vinst − återbetalningar − gratis-pack. */
  readonly profitAfterGiveawaysOre: number;
  /** Periodens fasta kostnader i urvalet, eller null med butiksfilter / när de inte gick att räkna. */
  readonly fixedCostOre: number | null;
  /** Varav gemensamma (fördelade) respektive direkt på automaten. */
  readonly sharedFixedOre: number | null;
  readonly directFixedOre: number | null;
  /** Vinst − återbetalningar − gratis-pack − fasta kostnader (fasta = 0 när de inte visas). */
  readonly resultOre: number;
  /** Resultatet på intäkten med inköpspris (som vinstmarginalen), bp. */
  readonly resultMarginBp: number | null;
  /** Varför fasta kostnader saknas, om de gör det. */
  readonly fixedNote: string | null;
  /** Fördelningens text, t.ex. "Gemensamma fasta kostnader … fördelas efter nettointäkt". */
  readonly fixedSummary: string | null;
  /** Per automat (utan filter, eller automaten med automatfilter). Summerar till totalen. */
  readonly machines: ResultMachineRow[];
}

export interface ResultInput {
  /** Urvalets indata (filtrerat på butik eller automat), samma som vattenfallet. */
  readonly current: ProfitabilityInput;
  /** Hela organisationens indata för perioden (för fördelningen av fasta kostnader). */
  readonly organization: ProfitabilityInput;
  readonly refunds: readonly Refund[];
  readonly fixedCosts: readonly FixedCost[];
  /** Gratis-pack i perioden (saknas = inga). */
  readonly freePacks?: readonly FreePackCost[];
  readonly scope: { readonly storeId: string | null; readonly machineId: string | null };
  readonly machines?: readonly { readonly id: string; readonly name: string }[];
}

/** Resultatet efter återbetalningar och fasta kostnader. Ren funktion. */
export function resultAfterProfit(input: ResultInput): ResultAfterProfit {
  const { current } = input;
  // Automatfiltret går först: skalet lägger alltid till automatens butik i adressen
  // (`?automat=…&butik=…`), och då gäller automatens återbetalningar och fasta kostnader.
  const scope = {
    storeId: input.scope.machineId ? null : input.scope.storeId,
    machineId: input.scope.machineId,
  };
  const period = current.period;
  const base = profitability(current, "machine");
  const profitOre = base.totals.profitOre;

  // Återbetalningar: per automat (applyRefunds på raderna), eller för butiken med
  // butiksfilter (placeringen på återbetalningsdagen).
  const lines = base.rows.map((r) => ({
    key: r.key,
    revenueOre: r.revenueOre,
    profitOre: r.profitOre,
  }));
  const refundRows = scope.storeId
    ? []
    : applyRefunds(
        lines,
        scope.machineId
          ? input.refunds.filter((r) => r.machineId === scope.machineId)
          : input.refunds,
        period,
        "machine",
      );
  const storeRefunds = scope.storeId
    ? summarizeRefunds(input.refunds, period, "store", input.organization.placements).rows.find(
        (r) => r.key === scope.storeId,
      )
    : undefined;
  const refundOre = scope.storeId
    ? (storeRefunds?.amountOre ?? 0)
    : sumOre(refundRows.map((r) => r.refundOre));
  const refundCount = scope.storeId
    ? (storeRefunds?.count ?? 0)
    : refundRows.reduce((n, r) => n + r.refundCount, 0);
  const profitAfterRefundsOre = sumOre([profitOre, -refundOre]);

  // Gratis-pack: samma regler som återbetalningarna (automat, eller butiken den dagen).
  const packs = input.freePacks ?? [];
  const packRows = scope.storeId
    ? []
    : applyRefunds(
        lines,
        asRefunds(scope.machineId ? packs.filter((p) => p.machineId === scope.machineId) : packs),
        period,
        "machine",
      );
  const storePacks = scope.storeId
    ? summarizeRefunds(asRefunds(packs), period, "store", input.organization.placements).rows.find(
        (r) => r.key === scope.storeId,
      )
    : undefined;
  const freePackOre = scope.storeId
    ? (storePacks?.amountOre ?? 0)
    : sumOre(packRows.map((r) => r.refundOre));
  const storePackIds = new Set(storePacks?.refundIds ?? []);
  const freePackCount = packs
    .filter((p) => p.day >= period.start && p.day <= period.end && p.costOre > 0)
    .filter((p) =>
      scope.storeId
        ? storePackIds.has(p.id)
        : scope.machineId === null || p.machineId === scope.machineId,
    )
    .reduce((n, p) => n + p.packs, 0);
  const profitAfterGiveawaysOre = sumOre([profitAfterRefundsOre, -freePackOre]);

  let allocation: FixedCostAllocation | null = null;
  let fixedNote: string | null = null;
  if (scope.storeId) {
    fixedNote =
      "Fasta kostnader fördelas per automat, inte per butik. Välj en automat eller hela organisationen.";
  } else {
    try {
      allocation = profitabilityWithFixedCosts(
        { ...input.organization, fixedCosts: input.fixedCosts, machines: input.machines ?? [] },
        "revenue",
      );
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      fixedNote = error.message;
    }
  }

  const fixedRows = allocation
    ? scope.machineId
      ? allocation.rows.filter((r) => r.key === scope.machineId)
      : allocation.rows
    : [];
  const fixedCostOre = allocation ? sumOre(fixedRows.map((r) => r.fixedCostOre)) : null;
  const sharedFixedOre = allocation ? sumOre(fixedRows.map((r) => r.sharedFixedOre)) : null;
  const directFixedOre = allocation ? sumOre(fixedRows.map((r) => r.directFixedOre)) : null;
  const resultOre = sumOre([profitAfterGiveawaysOre, -(fixedCostOre ?? 0)]);

  // Per automat (inte med butiksfilter): vinst, återbetalt, fasta och resultat.
  const machines: ResultMachineRow[] = [];
  if (!scope.storeId) {
    const keys = new Set<string>([
      ...refundRows.map((r) => r.key),
      ...packRows.map((r) => r.key),
      ...fixedRows.map((r) => r.key),
    ]);
    const refundBy = new Map(refundRows.map((r) => [r.key, r]));
    const packBy = new Map(packRows.map((r) => [r.key, r]));
    const fixedBy = new Map(fixedRows.map((r) => [r.key, r]));
    for (const key of [...keys].sort()) {
      const p = refundBy.get(key)?.profitOre ?? packBy.get(key)?.profitOre ?? 0;
      const refund = refundBy.get(key)?.refundOre ?? 0;
      const pack = packBy.get(key)?.refundOre ?? 0;
      const fixed = fixedBy.get(key)?.fixedCostOre ?? 0;
      machines.push({
        key,
        profitOre: p,
        refundOre: refund,
        freePackOre: pack,
        fixedCostOre: fixed,
        resultOre: sumOre([p, -refund, -pack, -fixed]),
      });
    }
  }

  return {
    profitOre,
    refundOre,
    refundCount,
    profitAfterRefundsOre,
    freePackOre,
    freePackCount,
    profitAfterGiveawaysOre,
    fixedCostOre,
    sharedFixedOre,
    directFixedOre,
    resultOre,
    resultMarginBp: ratioBp(resultOre, base.totals.revenueOre),
    fixedNote,
    fixedSummary: allocation && (fixedCostOre ?? 0) > 0 ? allocation.summary : null,
    machines,
  };
}
