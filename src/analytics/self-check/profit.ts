/**
 * Kontroll 1, "Samma vinst överallt": varje sida som visar vår vinst för en period ska
 * visa exakt samma belopp (på öret) och samma marginal, både utan butikernas andel
 * (standard) och med den (vyknappen "Visa butikernas andel"). Och skillnaden mellan
 * lägena, vinsten före andelen minus vår del, ska vara exakt butikernas andel som
 * avräkningarna räknar den.
 *
 * Talen kommer från sidornas egna laddare (src/server/self-check/profit.ts). Den första
 * källan i varje läge är facit (Lönsamhets nyckeltal); de andra jämförs mot den.
 *
 * Avrundning: alla laddare räknar i öre och summerar i öre. En källa som avrundar per rad
 * (t.ex. hela kronor per rad) får en tolerans `toleranceOre` med en förklaring i
 * `toleranceReason`; i dag har ingen källa det, så toleransen är 0 överallt.
 */

import { countText, diffKr, kr, pct, resultOf } from "./common";
import type { CheckFigure, CheckFinding, CheckResult } from "./types";

export interface ProfitSource {
  /** Var talet visas, t.ex. "Hem nyckeltal", "Lönsamhet per titel". */
  readonly label: string;
  readonly profitOre: number;
  /** Marginalen i bp om sidan visar en (null = ingen marginal, t.ex. ingen intäkt). */
  readonly marginBp?: number | null;
  /** Tillåten skillnad i öre (bara för källor som avrundar per rad). Standard 0. */
  readonly toleranceOre?: number;
  readonly toleranceReason?: string;
}

export interface ShareEngine {
  /** T.ex. "Avräkningarna (oktober)". */
  readonly label: string;
  readonly amountOre: number;
}

export interface ProfitPeriodFigures {
  /** "Senaste 30 dagarna", "November". */
  readonly label: string;
  /** Utan butikernas andel. Första källan är facit. */
  readonly off: readonly ProfitSource[];
  /** Med butikernas andel. Första källan är facit. */
  readonly on: readonly ProfitSource[];
  /** Butikernas andel enligt avräkningsmotorn (en eller flera beräkningar). */
  readonly shares: readonly ShareEngine[];
  /**
   * Order utan inköpspris i perioden. Vinsten (och andelen på sidorna) räknas bara på order
   * med pris, avräkningen på all försäljning: då skiljer andelen, och fyndet säger varför.
   */
  readonly unpricedOrders?: number;
  /**
   * Vår vinst (före andelen) i automater utan butik. Butiker listar bara butikerna, så den
   * delen är redan lagd till Butikers rader; den ger en varning (koppla automaten).
   */
  readonly noStoreProfitOre?: number;
}

const MODE = { off: "utan butikernas andel", on: "med butikernas andel" } as const;

function compareMode(
  period: string,
  mode: keyof typeof MODE,
  sources: readonly ProfitSource[],
  out: CheckFinding[],
): void {
  const [ref, ...rest] = sources;
  if (!ref) return;
  for (const s of rest) {
    const diff = s.profitOre - ref.profitOre;
    const tolerance = Math.max(0, s.toleranceOre ?? 0);
    if (Math.abs(diff) > tolerance) {
      out.push({
        level: "fail",
        text: `${period}, ${MODE[mode]}: ${s.label} visar ${kr(s.profitOre)}, ${ref.label} ${kr(ref.profitOre)} (${diffKr(diff)}).`,
      });
    }
    if (s.marginBp !== undefined && ref.marginBp !== undefined && s.marginBp !== ref.marginBp) {
      out.push({
        level: "fail",
        text: `${period}, ${MODE[mode]}: marginalen på ${s.label} är ${pct(s.marginBp)}, på ${ref.label} ${pct(ref.marginBp)}.`,
      });
    }
  }
}

export function profitConsistency(periods: readonly ProfitPeriodFigures[]): CheckResult {
  const findings: CheckFinding[] = [];
  const figures: CheckFigure[] = [];
  let compared = 0;
  // En varning om automater utan butik räcker (den första perioden som har dem).
  const noStore = periods.find((p) => (p.noStoreProfitOre ?? 0) !== 0);
  if (noStore) {
    findings.push({
      level: "warn",
      text: `${noStore.label}: ${kr(noStore.noStoreProfitOre ?? 0)} vinst i automater utan butik syns inte på Butiker. Koppla automaten till en butik.`,
      link: "/automater",
    });
  }
  for (const p of periods) {
    compareMode(p.label, "off", p.off, findings);
    compareMode(p.label, "on", p.on, findings);
    compared += Math.max(0, p.off.length - 1) + Math.max(0, p.on.length - 1);
    const before = p.off[0]?.profitOre;
    const ours = p.on[0]?.profitOre;
    if (before === undefined || ours === undefined) continue;
    const share = before - ours;
    figures.push(
      { label: `${p.label}: vår vinst före andel`, value: before, unit: "ore" },
      { label: `${p.label}: vår del`, value: ours, unit: "ore" },
      { label: `${p.label}: butikernas andel`, value: share, unit: "ore" },
    );
    for (const e of p.shares) {
      compared += 1;
      if (e.amountOre !== share) {
        const unpriced = p.unpricedOrders ?? 0;
        const why =
          unpriced > 0
            ? ` Troligen ${countText(unpriced, "order", "order")} utan inköpspris: lägg in priserna.`
            : "";
        findings.push({
          level: "fail",
          text: `${p.label}: vinsten före andel minus vår del är ${kr(share)}, men ${e.label} ger butikerna ${kr(e.amountOre)} (${diffKr(share - e.amountOre)}).${why}`,
          ...(unpriced > 0 ? { link: "/inkopspriser" } : {}),
        });
      }
    }
  }
  const fails = findings.filter((f) => f.level === "fail").length;
  const first = periods[0];
  const headline =
    first?.off[0] && first.on[0]
      ? ` ${first.label}: ${kr(first.off[0].profitOre)} före andel, ${kr(first.on[0].profitOre)} vår del.`
      : "";
  return resultOf("samma_vinst", {
    findings,
    figures,
    summary: {
      pass: `Alla sidor visar samma vinst och marginal (${compared} jämförelser).${headline}`,
      warn: `Alla sidor visar samma vinst och marginal (${compared} jämförelser), men en automat utan butik syns inte på Butiker.`,
      fail: `${countText(fails, "skillnad", "skillnader")} mellan sidorna.`,
    },
  });
}
