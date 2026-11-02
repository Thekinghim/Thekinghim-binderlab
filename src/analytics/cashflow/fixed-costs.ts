/**
 * Fasta kostnader: betalningstillfällen, periodisering och fördelning på automater.
 *
 * Regler:
 * - En fast kostnad betalas i förskott: `amountOre` på `start` och sedan var 1/3/12 månad
 *   på samma dag i månaden (kapad till månadens sista dag; dagen glider inte: 31 jan →
 *   28 feb → 31 mars). Sista betalningen är den sista med datum ≤ `end`.
 * - Varje betalning avser dagarna från betalningsdagen till dagen före nästa betalning,
 *   högst t.o.m. `end`. Slutar kostnaden mitt i ett intervall betalas ändå hela beloppet
 *   och periodiseras på de dagar som återstår.
 * - Periodisering: en betalnings del av en period = round(belopp × dagar i perioden /
 *   dagar betalningen avser), avrundat per betalning (halva öre uppåt).
 * - I lönsamheten dras periodens fasta kostnader från vinsten. Kostnader med `machineId`
 *   bärs av den automaten; övriga fördelas på automaterna efter nettointäkt (alla order)
 *   eller lika, med största-restmetoden så att summan stämmer på öret.
 */

import {
  addDays,
  allocateLargestRemainder,
  assertIsoDate,
  assertPeriod,
  DomainError,
  intersectPeriods,
  marginBp,
  periodDays,
  profitability,
  ratioBp,
  roundHalfUp,
  type IsoDate,
  type Period,
} from "@/domain";
import { nameLookup } from "../todos/common";
import { kr, periodText, pct } from "../todos/text";
import {
  addOre,
  assertId,
  assertOre,
  bpFigure,
  compareStrings,
  financeEvidence,
  oreFigure,
  shiftMonths,
} from "../reconciliation/common";
import type {
  AccruedFixedCost,
  FixedCost,
  FixedCostAccrual,
  FixedCostAllocation,
  FixedCostAllocationInput,
  FixedCostAllocationMethod,
  FixedCostInterval,
  FixedCostOccurrence,
  FixedCostRow,
} from "./types";

/** Månader per intervall. */
export const INTERVAL_MONTHS: Readonly<Record<FixedCostInterval, number>> = {
  month: 1,
  quarter: 3,
  year: 12,
};

const INTERVAL_TEXT: Readonly<Record<FixedCostInterval, string>> = {
  month: "per månad",
  quarter: "per kvartal",
  year: "per år",
};

/** Nyckel för gemensamma fasta kostnader när det inte finns någon automat att fördela på. */
export const FIXED_UNALLOCATED_KEY = "fixed-unallocated";

/** Kontrollerar en fast kostnad. Kastar `DomainError` med svensk text. */
export function assertFixedCost(cost: FixedCost): void {
  const id = assertId(cost?.id, "Den fasta kostnadens id");
  assertOre(cost.amountOre, `Beloppet för ${cost.name || id}`);
  if (!(cost.interval in INTERVAL_MONTHS)) {
    throw new DomainError(
      "invalid_input",
      `Intervallet för ${cost.name || id} måste vara month, quarter eller year, fick ${JSON.stringify(cost.interval)}.`,
    );
  }
  assertIsoDate(cost.start, `Startdag för ${cost.name || id}`);
  if (cost.end !== null) {
    assertIsoDate(cost.end, `Slutdag för ${cost.name || id}`);
    if (cost.end < cost.start) {
      throw new DomainError(
        "invalid_period",
        `${cost.name || id} slutar (${cost.end}) före den börjar (${cost.start}).`,
      );
    }
  }
}

/**
 * Betalningstillfällena för en fast kostnad vars datum ligger t.o.m. `until`, och vars
 * avsedda dagar (`coverage`) slutar på eller efter `from` (om angivet).
 * fixedCostOccurrences({ start: '2026-01-31', interval: 'month', … }, '2026-04-30')
 * → 31 jan, 28 feb, 31 mars, 30 apr.
 */
export function fixedCostOccurrences(
  cost: FixedCost,
  until: IsoDate,
  from?: IsoDate,
): FixedCostOccurrence[] {
  assertFixedCost(cost);
  assertIsoDate(until, "Slutdag");
  const step = INTERVAL_MONTHS[cost.interval];
  const last = cost.end === null || cost.end > until ? until : cost.end;
  const out: FixedCostOccurrence[] = [];
  for (let k = 0; ; k++) {
    const date = shiftMonths(cost.start, k * step);
    if (date > last) break;
    const next = shiftMonths(cost.start, (k + 1) * step);
    const coverageEnd =
      cost.end !== null && cost.end < addDays(next, -1) ? cost.end : addDays(next, -1);
    if (from !== undefined && coverageEnd < from) continue;
    out.push({
      costId: cost.id,
      date,
      amountOre: cost.amountOre,
      coverage: { start: date, end: coverageEnd },
    });
  }
  return out;
}

/**
 * Periodens del av de fasta kostnaderna. För varje betalning vars dagar överlappar perioden:
 * round(belopp × överlappande dagar / dagar betalningen avser). Kvartalskostnad 3 000 kr från
 * 1 okt. ger för november round(300 000 × 30 / 92) = 97 826 öre.
 */
export function accrueFixedCosts(costs: readonly FixedCost[], period: Period): FixedCostAccrual {
  assertPeriod(period);
  const seen = new Set<string>();
  const byCost: AccruedFixedCost[] = [];
  let total = 0;
  let shared = 0;
  let direct = 0;
  const sorted = [...costs].sort((a, b) => compareStrings(a?.id ?? "", b?.id ?? ""));
  for (const cost of sorted) {
    assertFixedCost(cost);
    if (seen.has(cost.id)) {
      throw new DomainError("invalid_input", `Den fasta kostnaden ${cost.id} finns två gånger.`);
    }
    seen.add(cost.id);
    const occurrences = fixedCostOccurrences(cost, period.end, period.start);
    let accrued = 0;
    const used: FixedCostOccurrence[] = [];
    for (const occ of occurrences) {
      const overlap = intersectPeriods(occ.coverage, period);
      if (overlap === null) continue;
      accrued = addOre(
        accrued,
        roundHalfUp(BigInt(occ.amountOre) * BigInt(periodDays(overlap)), periodDays(occ.coverage)),
      );
      used.push(occ);
    }
    if (used.length === 0) continue;
    const machineId = cost.machineId ?? null;
    byCost.push({
      costId: cost.id,
      name: cost.name,
      machineId,
      accruedOre: accrued,
      occurrences: used,
    });
    total = addOre(total, accrued);
    if (machineId === null) shared = addOre(shared, accrued);
    else direct = addOre(direct, accrued);
  }
  return {
    period,
    totalOre: total,
    sharedOre: shared,
    directOre: direct,
    byCost,
    evidence: financeEvidence({
      rule: "Varje betalning periodiseras per dag: round(belopp × dagar i perioden / dagar betalningen avser).",
      period,
      fixedCostIds: byCost.map((c) => c.costId),
      dates: byCost.flatMap((c) => c.occurrences.map((o) => o.date)),
      machineIds: byCost.flatMap((c) => (c.machineId === null ? [] : [c.machineId])),
      figures: [
        oreFigure("totalOre", "Fasta kostnader i perioden", total),
        oreFigure("sharedOre", "Gemensamma", shared),
        oreFigure("directOre", "Per automat", direct),
      ],
    }),
  };
}

/** Text för en kostnad: "Försäkring 1 200 kr per kvartal". */
export function fixedCostLabel(cost: FixedCost): string {
  return `${cost.name} ${kr(cost.amountOre)} ${INTERVAL_TEXT[cost.interval]}`;
}

/**
 * Lönsamhet per automat efter fasta kostnader.
 *
 * Vinsten före fasta kostnader är domänens lönsamhet per automat (samma siffror som vyn per
 * automat). Periodens fasta kostnader (`accrueFixedCosts`) dras sedan av:
 * - kostnader med `machineId` på den automaten,
 * - gemensamma kostnader fördelas på automaterna efter nettointäkt (alla order, även de utan
 *   inköpspris) med `method = 'revenue'`, eller lika per automat med `method = 'equal'`.
 *   Har ingen automat någon intäkt fördelas de lika. Automaterna är de som sålt, varit
 *   placerade någon dag i perioden eller angetts i `machineIds`.
 * Raderna 'no-machine' och 'unallocated' (ej fördelad hyra) följer med utan fasta kostnader,
 * så att Σ rader = totalen exakt. Finns ingen automat hamnar de gemensamma kostnaderna på
 * raden 'fixed-unallocated'.
 */
export function profitabilityWithFixedCosts(
  input: FixedCostAllocationInput,
  method: FixedCostAllocationMethod,
): FixedCostAllocation {
  if (method !== "revenue" && method !== "equal") {
    throw new DomainError(
      "invalid_input",
      `Fördelningen måste vara 'revenue' eller 'equal', fick ${JSON.stringify(method)}.`,
    );
  }
  const { period } = input;
  const result = profitability(input, "machine");
  const accrual = accrueFixedCosts(input.fixedCosts, period);
  const name = nameLookup(input.machines ?? []);

  const machineIds = new Set<string>();
  for (const row of result.rows) if (row.kind === "item") machineIds.add(row.key);
  for (const p of input.placements) {
    if (p.from <= period.end && (p.to === null || p.to >= period.start))
      machineIds.add(p.machineId);
  }
  for (const id of input.machineIds ?? []) machineIds.add(assertId(id, "Automatens id"));
  for (const c of accrual.byCost) if (c.machineId !== null) machineIds.add(c.machineId);
  const machines = [...machineIds].sort(compareStrings);

  const rowByKey = new Map(result.rows.map((r) => [r.key, r]));
  const revenueOf = (key: string): number => {
    const r = rowByKey.get(key);
    return r ? r.revenueOre + r.unpricedRevenueOre : 0;
  };
  const weights = machines.map((id) => (method === "revenue" ? revenueOf(id) : 1));
  const shares = machines.length === 0 ? [] : allocateLargestRemainder(accrual.sharedOre, weights);
  const directByMachine = new Map<string, number>();
  const directCostIds = new Map<string, string[]>();
  for (const c of accrual.byCost) {
    if (c.machineId === null) continue;
    directByMachine.set(c.machineId, addOre(directByMachine.get(c.machineId) ?? 0, c.accruedOre));
    directCostIds.set(c.machineId, [...(directCostIds.get(c.machineId) ?? []), c.costId]);
  }
  const sharedCostIds = accrual.byCost.filter((c) => c.machineId === null).map((c) => c.costId);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const methodText =
    method === "revenue" && weightSum > 0 ? "efter nettointäkt" : "lika per automat";

  const rows: FixedCostRow[] = [];
  machines.forEach((id, i) => {
    const r = rowByKey.get(id);
    const revenue = revenueOf(id);
    const profit = r?.profitOre ?? 0;
    const sharedFixed = shares[i] ?? 0;
    const directFixed = directByMachine.get(id) ?? 0;
    const fixed = sharedFixed + directFixed;
    const after = profit - fixed;
    const shareBp = ratioBp(sharedFixed, accrual.sharedOre);
    rows.push({
      key: id,
      kind: "machine",
      revenueOre: revenue,
      profitOre: profit,
      sharedFixedOre: sharedFixed,
      directFixedOre: directFixed,
      fixedCostOre: fixed,
      profitAfterFixedOre: after,
      marginAfterFixedBp: marginBp(after, r?.revenueOre ?? 0),
      shareBp,
      evidence: financeEvidence({
        rule: `Gemensamma fasta kostnader fördelas ${methodText}; kostnader för en viss automat bärs av den.`,
        period,
        machineIds: [id],
        fixedCostIds: [...sharedCostIds, ...(directCostIds.get(id) ?? [])],
        figures: [
          oreFigure("revenueOre", `Nettointäkt ${name(id)}`, revenue),
          oreFigure("profitOre", "Vinst före fasta kostnader", profit),
          oreFigure("sharedFixedOre", "Andel av gemensamma fasta kostnader", sharedFixed),
          oreFigure("directFixedOre", "Egna fasta kostnader", directFixed),
          oreFigure("profitAfterFixedOre", "Vinst efter fasta kostnader", after),
          ...(shareBp === null ? [] : [bpFigure("shareBp", "Andel av gemensamma", shareBp)]),
        ],
      }),
    });
  });
  for (const r of result.rows) {
    if (r.kind !== "no-machine" && r.kind !== "unallocated") continue;
    rows.push({
      key: r.key,
      kind: r.kind,
      revenueOre: r.revenueOre + r.unpricedRevenueOre,
      profitOre: r.profitOre,
      sharedFixedOre: 0,
      directFixedOre: 0,
      fixedCostOre: 0,
      profitAfterFixedOre: r.profitOre,
      marginAfterFixedBp: marginBp(r.profitOre, r.revenueOre),
      shareBp: null,
      evidence: financeEvidence({
        rule:
          r.kind === "no-machine"
            ? "Order utan kopplad automat bär inga fasta kostnader."
            : "Ej fördelad hyra bär inga fasta kostnader.",
        period,
        figures: [oreFigure("profitOre", "Vinst", r.profitOre)],
      }),
    });
  }
  if (machines.length === 0 && accrual.sharedOre !== 0) {
    rows.push({
      key: FIXED_UNALLOCATED_KEY,
      kind: "fixed-unallocated",
      revenueOre: 0,
      profitOre: 0,
      sharedFixedOre: accrual.sharedOre,
      directFixedOre: 0,
      fixedCostOre: accrual.sharedOre,
      profitAfterFixedOre: -accrual.sharedOre,
      marginAfterFixedBp: null,
      shareBp: 10_000,
      evidence: financeEvidence({
        rule: "Det finns ingen automat i perioden att fördela de gemensamma fasta kostnaderna på.",
        period,
        fixedCostIds: sharedCostIds,
        figures: [oreFigure("fixedCostOre", "Gemensamma fasta kostnader", accrual.sharedOre)],
      }),
    });
  }

  const t = result.totals;
  const revenueAll = t.revenueOre + t.unpricedRevenueOre;
  const after = t.profitOre - accrual.totalOre;
  const totals = {
    revenueOre: revenueAll,
    profitOre: t.profitOre,
    fixedCostOre: accrual.totalOre,
    profitAfterFixedOre: after,
    marginAfterFixedBp: marginBp(after, t.revenueOre),
  };

  const parts: string[] = [];
  if (accrual.totalOre === 0) {
    parts.push(
      `Inga fasta kostnader i perioden (${periodText(period)}). Vinst ${kr(t.profitOre)}.`,
    );
  } else {
    parts.push(
      `Fasta kostnader ${kr(accrual.totalOre)} ${periodText(period)} (${accrual.byCost.length} st). Vinst ${kr(
        t.profitOre,
      )} före och ${kr(after)} efter fasta kostnader${
        totals.marginAfterFixedBp === null ? "" : ` (marginal ${pct(totals.marginAfterFixedBp)})`
      }.`,
    );
    const top = rows
      .filter((r) => r.kind === "machine" && r.sharedFixedOre > 0)
      .sort((a, b) => b.sharedFixedOre - a.sharedFixedOre || compareStrings(a.key, b.key))[0];
    if (top && accrual.sharedOre > 0 && machines.length > 1) {
      parts.push(
        `Gemensamma kostnader fördelas ${methodText}: ${name(top.key)} bär ${kr(top.sharedFixedOre)} (${pct(
          top.shareBp ?? 0,
        )}).`,
      );
    }
    const losers = rows.filter(
      (r) => r.kind === "machine" && r.profitOre > 0 && r.profitAfterFixedOre <= 0,
    );
    if (losers.length > 0) {
      parts.push(
        `Går med förlust efter fasta kostnader: ${losers
          .map((r) => `${name(r.key)} (${kr(r.profitAfterFixedOre)})`)
          .join(", ")}.`,
      );
    }
  }

  return {
    period,
    method,
    accrual,
    rows,
    totals,
    summary: parts.join(" "),
    evidence: financeEvidence({
      rule: "Vinst efter fasta kostnader = vinst enligt lönsamheten − periodens fasta kostnader.",
      period,
      machineIds: machines,
      fixedCostIds: accrual.byCost.map((c) => c.costId),
      figures: [
        oreFigure("profitOre", "Vinst före fasta kostnader", t.profitOre),
        oreFigure("fixedCostOre", "Fasta kostnader", accrual.totalOre),
        oreFigure("profitAfterFixedOre", "Vinst efter fasta kostnader", after),
      ],
    }),
  };
}
