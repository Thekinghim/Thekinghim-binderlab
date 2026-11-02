/**
 * Sortimentsrekommendation per automat: vilka titlar och hur många fack.
 *
 * Underlag (se performance.ts): efterfrågan (pack per vecka) och bidrag per pack per titel i
 * automaten under mätperioden.
 *
 * Kapacitet: ett fack rymmer `slotCapacity` pack (standard 10) och fylls på var
 * `refillIntervalDays` dag (standard 7). Ett fack kan alltså sälja högst
 *   kap = slotCapacity × 7 / refillIntervalDays pack per vecka.
 * Med k fack säljer en titel min(efterfrågan, k × kap) pack per vecka, och bidraget per vecka är
 * det × bidrag per pack. Ett extra fack ger bara något när efterfrågan inte ryms i de fack titeln
 * har (avtagande nytta).
 *
 * Kandidater:
 * - titlar i automaten nu. Saknar en sådan titel inköpspris eller har den för få
 *   exponeringsdagar behåller den sina fack (låst) och räknas inte om.
 * - titlar som säljer i liknande automater (de `similarCount` mest lika enligt
 *   försäljningsmixen, eller `similarMachineIds`) men inte finns här. Efterfrågan här =
 *   medianen över de liknande automaterna av deras efterfrågan × (den här automatens pack per
 *   fackdag / den automatens pack per fackdag), så att en svagare plats inte får en starkare
 *   plats siffror. Bidrag per pack = Σ bidrag / prissatta pack i de liknande automaterna.
 *
 * Fördelning (girig, optimal eftersom nyttan avtar): de fack som inte är låsta delas ut ett i
 * taget till den titel där nästa fack ger mest bidrag per vecka. Lika → titel som redan har
 * fler fack nu, sedan högre efterfrågan, sedan id. Ger inget fack mer bidrag fylls resten
 * tillbaka till titlar som hade fler fack nu (med positivt bidrag); resten blir lediga.
 *
 * Effekt = Σ bidrag per vecka med föreslagna fack − Σ med nuvarande fack (samma modell).
 * Är effekten under `minEffectPerWeekOre` (standard 2 000 = 20 kr/vecka) blir rådet att
 * behålla sortimentet. Då är raderna (`recommendedSlots`), `fingerprint` och `freeSlots` den
 * nuvarande fördelningen, så att inget i resultatet motsäger rådet; bästa omfördelningen finns
 * kvar som underlag i `potentialSlots` och `potentialEffectPerWeekOre`.
 */

import { assertPeriod, type EconomicsSources, type OrderLine, type Period } from "@/domain";
import { fig, Ratio, signedKr } from "../expansion/common";
import { nameLookup } from "../todos/common";
import { krExact, periodText, plural } from "../todos/text";
import type { MachineRef } from "../todos/types";
import {
  compareStrings,
  listText,
  marketEvidence,
  tenthsOf,
  tenthsText,
  type MarketEvidence,
  intOption,
} from "../pricing/common";
import type { NamedRef } from "../pricing/market";
import { median } from "../pricing/robust";
import {
  similarMachines,
  slotKey,
  slotPerformance,
  type MachineSimilarity,
  type SlotAssignment,
  type SlotPerformance,
} from "./performance";

/** Inställningar. */
export interface AssortmentOptions {
  /** Pack per fack. Standard 10. */
  readonly slotCapacity?: number;
  /** Dagar mellan påfyllningar. Standard 7. */
  readonly refillIntervalDays?: number;
  /** Minsta exponeringsdagar. Standard 14. */
  readonly minExposureDays?: number;
  /** Antal liknande automater. Standard 3. */
  readonly similarCount?: number;
  /** Minsta effekt för att föreslå en ändring, i öre per vecka. Standard 2 000. */
  readonly minEffectPerWeekOre?: number;
}

/** Indata till `recommendAssortment`. */
export interface AssortmentInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly machines: readonly MachineRef[];
  readonly titles?: readonly NamedRef[];
  readonly assignments: readonly SlotAssignment[];
  /** Mätperioden (t.ex. de senaste 28 dagarna). */
  readonly period: Period;
  /** Antal fack per automat. Standard: Σ fack periodens sista dag. */
  readonly capacityByMachine?: Readonly<Record<string, number>>;
  /** Liknande automater per automat (ersätter likheten enligt försäljningsmixen). */
  readonly similarMachineIds?: Readonly<Record<string, readonly string[]>>;
  /** Bara dessa automater. Standard: alla med fack eller kapacitet. */
  readonly machineIds?: readonly string[];
  readonly options?: AssortmentOptions;
}

/** En titel i rekommendationen. */
export interface AssortmentLine {
  readonly titleId: string;
  readonly currentSlots: number;
  /** Fack enligt rådet: vid "behåll" samma som `currentSlots`. */
  readonly recommendedSlots: number;
  /**
   * Fack i bästa omfördelningen, även när den ger för lite för att föreslås. Skiljer sig från
   * `recommendedSlots` bara vid "behåll" och visas då som ett underlag, inte som ett råd.
   */
  readonly potentialSlots: number;
  /** Var efterfrågan kommer ifrån. */
  readonly source: "observed" | "similar";
  /** Låst: behåller sina fack (saknar pris eller har för lite data). */
  readonly locked: "missing-price" | "too-little-data" | null;
  /** Efterfrågan i pack per vecka, tiondelar. `null` om okänd. */
  readonly demandPerWeekTenths: number | null;
  readonly contributionPerPackOre: number | null;
  /** Väntat bidrag per vecka med nuvarande respektive rådets fack, i öre. */
  readonly currentContributionPerWeekOre: number | null;
  readonly recommendedContributionPerWeekOre: number | null;
  /** Automater som efterfrågan bygger på (liknande automater för nya titlar). */
  readonly basisMachineIds: readonly string[];
}

/** En ändring. */
export interface AssortmentChange {
  readonly titleId: string;
  readonly kind: "add" | "remove" | "increase" | "decrease";
  readonly fromSlots: number;
  readonly toSlots: number;
  readonly effectPerWeekOre: number;
  readonly text: string;
}

/** Rekommendation för en automat. */
export interface MachineAssortmentRecommendation {
  /** Stabil nyckel 'assortment:<automat>'. */
  readonly key: string;
  /**
   * Rådets fördelning som text ('titel:fack', sorterat), ändras när rekommendationen ändras.
   * Vid "behåll" är det den nuvarande fördelningen.
   */
  readonly fingerprint: string;
  readonly machineId: string;
  readonly action: "change" | "keep";
  readonly capacity: number;
  /** Lediga fack enligt rådet (vid "behåll": kapacitet − nuvarande fack). */
  readonly freeSlots: number;
  readonly lines: readonly AssortmentLine[];
  readonly changes: readonly AssortmentChange[];
  /** Väntad effekt i öre per vecka (0 vid "behåll"). */
  readonly effectPerWeekOre: number;
  /** Effekten av bästa omfördelningen, även om den är för liten. */
  readonly potentialEffectPerWeekOre: number;
  readonly similar: readonly MachineSimilarity[];
  readonly text: string;
  readonly evidence: MarketEvidence;
}

interface Candidate {
  titleId: string;
  currentSlots: number;
  source: AssortmentLine["source"];
  locked: AssortmentLine["locked"];
  demand: Ratio | null;
  contribution: Ratio | null;
  basis: string[];
  slots: number;
  orderIds: readonly string[];
}

/**
 * Sant om `c` ska få nästa fack före `best`: större vinst; lika → titeln som hade fler fack
 * nu (stabilitet), sedan högre efterfrågan, sedan lägre id.
 */
function prefer(c: Candidate, gain: Ratio, best: Candidate | null, bestGain: Ratio): boolean {
  if (best === null) return true;
  const cmp = gain.compare(bestGain);
  if (cmp !== 0) return cmp > 0;
  const keepC = c.currentSlots > c.slots;
  const keepBest = best.currentSlots > best.slots;
  if (keepC !== keepBest) return keepC;
  const d = c.demand!.compare(best.demand!);
  if (d !== 0) return d > 0;
  return compareStrings(c.titleId, best.titleId) < 0;
}

/** Rekommendation per automat (se modulens regler), sorterad på automat-id. */
export function recommendAssortment(input: AssortmentInput): MachineAssortmentRecommendation[] {
  assertPeriod(input.period);
  const o = input.options ?? {};
  const slotCapacity = intOption(o.slotCapacity, 10, "Pack per fack", 1);
  const refillDays = intOption(o.refillIntervalDays, 7, "Dagar mellan påfyllningar", 1);
  const minExposureDays = intOption(o.minExposureDays, 14, "Minsta exponering", 1);
  const similarCount = intOption(o.similarCount, 3, "Antal liknande automater", 0);
  const minEffect = intOption(o.minEffectPerWeekOre, 2_000, "Minsta effekt", 0);
  const capPerWeek = new Ratio(slotCapacity * 7, refillDays);
  const titleName = nameLookup(input.titles ?? []);
  const machineName = nameLookup(input.machines);

  const perf = slotPerformance({ ...input, minExposureDays });
  const byKey = new Map(perf.rows.map((r) => [slotKey(r.machineId, r.titleId), r]));
  const rowsByMachine = new Map<string, SlotPerformance[]>();
  for (const r of perf.rows) {
    const list = rowsByMachine.get(r.machineId);
    if (list) list.push(r);
    else rowsByMachine.set(r.machineId, [r]);
  }
  const level = new Map(perf.machines.map((m) => [m.machineId, m]));
  const levelOf = (machineId: string): Ratio | null => {
    const m = level.get(machineId);
    return m && m.slotDays > 0 ? new Ratio(m.units, m.slotDays) : null;
  };

  const machineIds = (
    input.machineIds ?? [
      ...new Set([
        ...perf.rows.filter((r) => r.currentSlots > 0).map((r) => r.machineId),
        ...Object.keys(input.capacityByMachine ?? {}),
      ]),
    ]
  )
    .slice()
    .sort(compareStrings);

  const sales = (demand: Ratio, k: number): Ratio => {
    const cap = capPerWeek.mul(k);
    return demand.compare(cap) <= 0 ? demand : cap;
  };
  const value = (c: Candidate, k: number): Ratio =>
    c.demand && c.contribution ? sales(c.demand, k).mul(c.contribution) : new Ratio(0);

  const out: MachineAssortmentRecommendation[] = [];
  for (const machineId of machineIds) {
    const rows = rowsByMachine.get(machineId) ?? [];
    const currentSlotsTotal = rows.reduce((s, r) => s + r.currentSlots, 0);
    const capacity = intOption(
      input.capacityByMachine?.[machineId],
      currentSlotsTotal,
      `Kapaciteten för ${machineId}`,
      0,
    );

    const similar: MachineSimilarity[] = input.similarMachineIds?.[machineId]
      ? input.similarMachineIds[machineId]!.filter((id) => id !== machineId).map((id) => ({
          machineId: id,
          similarityBp: -1,
        }))
      : similarMachines(perf.rows, machineId, similarCount);
    const ownLevel = levelOf(machineId);

    const candidates: Candidate[] = [];
    for (const r of rows) {
      if (r.currentSlots === 0) continue;
      const locked: Candidate["locked"] =
        r.demandPerWeek === null
          ? "too-little-data"
          : r.contributionPerPack === null
            ? "missing-price"
            : null;
      candidates.push({
        titleId: r.titleId,
        currentSlots: r.currentSlots,
        source: "observed",
        locked,
        demand: r.demandPerWeek,
        contribution: r.contributionPerPack,
        basis: [machineId],
        slots: locked ? r.currentSlots : 0,
        orderIds: r.orderIds,
      });
    }
    const present = new Set(candidates.map((c) => c.titleId));
    const newTitles = new Set<string>();
    for (const s of similar) {
      for (const r of rowsByMachine.get(s.machineId) ?? []) {
        if (!present.has(r.titleId) && r.demandPerWeek !== null) newTitles.add(r.titleId);
      }
    }
    for (const titleId of [...newTitles].sort(compareStrings)) {
      const estimates: Ratio[] = [];
      const basis: string[] = [];
      let contribution = 0n;
      let priced = 0;
      const orderIds: string[] = [];
      for (const s of similar) {
        const r = byKey.get(slotKey(s.machineId, titleId));
        const otherLevel = levelOf(s.machineId);
        if (!r || r.demandPerWeek === null || !otherLevel || otherLevel.sign() === 0 || !ownLevel)
          continue;
        estimates.push(r.demandPerWeek.mul(ownLevel).div(otherLevel));
        basis.push(s.machineId);
        contribution += BigInt(r.contributionOre);
        priced += r.pricedUnits;
        orderIds.push(...r.orderIds);
      }
      const demand = median(estimates);
      if (demand === null || demand.sign() <= 0 || priced === 0) continue;
      candidates.push({
        titleId,
        currentSlots: 0,
        source: "similar",
        locked: null,
        demand,
        contribution: new Ratio(contribution, priced),
        basis,
        slots: 0,
        orderIds,
      });
    }

    // Girig fördelning av de fack som inte är låsta.
    const lockedSlots = candidates.filter((c) => c.locked).reduce((s, c) => s + c.slots, 0);
    let free = Math.max(capacity - lockedSlots, 0);
    const open = candidates.filter((c) => !c.locked);
    while (free > 0) {
      let best: Candidate | null = null;
      let bestGain = new Ratio(0);
      for (const c of open) {
        const gain = value(c, c.slots + 1).sub(value(c, c.slots));
        if (gain.sign() <= 0) continue;
        const better = prefer(c, gain, best, bestGain);
        if (better) {
          best = c;
          bestGain = gain;
        }
      }
      if (!best) break;
      best.slots++;
      free--;
    }
    // Rest tillbaka till titlar som hade fler fack nu (positivt bidrag), mest bidrag per pack först.
    const restore = open
      .filter(
        (c) => c.currentSlots > c.slots && c.contribution !== null && c.contribution.sign() > 0,
      )
      .sort(
        (a, b) => b.contribution!.compare(a.contribution!) || compareStrings(a.titleId, b.titleId),
      );
    for (const c of restore) {
      const give = Math.min(free, c.currentSlots - c.slots);
      c.slots += give;
      free -= give;
    }

    let potential = new Ratio(0);
    const lines: AssortmentLine[] = [];
    const changes: AssortmentChange[] = [];
    for (const c of candidates) {
      const cur = c.locked ? null : value(c, c.currentSlots);
      const rec = c.locked ? null : value(c, c.slots);
      if (cur && rec) potential = potential.add(rec.sub(cur));
      lines.push({
        titleId: c.titleId,
        currentSlots: c.currentSlots,
        recommendedSlots: c.slots,
        potentialSlots: c.slots,
        source: c.source,
        locked: c.locked,
        demandPerWeekTenths: c.demand ? tenthsOf(c.demand) : null,
        contributionPerPackOre: c.contribution ? c.contribution.round() : null,
        currentContributionPerWeekOre: cur ? cur.round() : null,
        recommendedContributionPerWeekOre: rec ? rec.round() : null,
        basisMachineIds: [...c.basis].sort(compareStrings),
      });
      if (c.slots === c.currentSlots || !cur || !rec) continue;
      const effect = rec.sub(cur).round();
      const name = titleName(c.titleId);
      const demandText = `${tenthsText(tenthsOf(c.demand!))} pack/vecka`;
      const perPack = `${krExact(c.contribution!.round())} kvar per pack`;
      let kind: AssortmentChange["kind"];
      let text: string;
      if (c.currentSlots === 0) {
        kind = "add";
        text = `Lägg till ${name} i ${plural(c.slots, "fack", "fack")}: väntas sälja ${demandText} här, enligt ${listText(c.basis.map(machineName))} justerat för platsens nivå; ${perPack} ger ${signedKr(effect)}/vecka.`;
      } else if (c.slots === 0) {
        kind = "remove";
        text = `Ta bort ${name} (${plural(c.currentSlots, "fack", "fack")}): säljer ${demandText} med ${perPack}, ${signedKr(effect)}/vecka; facken gör mer nytta för andra titlar.`;
      } else if (c.slots > c.currentSlots) {
        kind = "increase";
        text = `Ge ${name} ${c.slots} fack i stället för ${c.currentSlots}: säljer ${demandText} men ${plural(c.currentSlots, "fack", "fack")} rymmer ${tenthsText(tenthsOf(capPerWeek.mul(c.currentSlots)))} pack/vecka; ${signedKr(effect)}/vecka.`;
      } else {
        kind = "decrease";
        text = `Minska ${name} till ${plural(c.slots, "fack", "fack")} (från ${c.currentSlots}): ${demandText} ryms${effect === 0 ? "" : `, ${signedKr(effect)}/vecka`}.`;
      }
      changes.push({
        titleId: c.titleId,
        kind,
        fromSlots: c.currentSlots,
        toSlots: c.slots,
        effectPerWeekOre: effect,
        text,
      });
    }
    lines.sort(
      (a, b) =>
        b.recommendedSlots - a.recommendedSlots ||
        b.currentSlots - a.currentSlots ||
        compareStrings(a.titleId, b.titleId),
    );
    const kindOrder = { add: 0, increase: 1, decrease: 2, remove: 3 } as const;
    changes.sort(
      (a, b) =>
        kindOrder[a.kind] - kindOrder[b.kind] ||
        b.effectPerWeekOre - a.effectPerWeekOre ||
        compareStrings(a.titleId, b.titleId),
    );
    const potentialOre = potential.round();
    const action: MachineAssortmentRecommendation["action"] =
      changes.length > 0 && potentialOre >= minEffect ? "change" : "keep";
    if (action === "keep") {
      // Rådet är att behålla: raderna visar nuvarande fack, bästa omfördelningen bara i potentialSlots.
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        lines[i] = {
          ...l,
          recommendedSlots: l.currentSlots,
          recommendedContributionPerWeekOre: l.currentContributionPerWeekOre,
        };
      }
      lines.sort(
        (a, b) =>
          b.recommendedSlots - a.recommendedSlots ||
          b.potentialSlots - a.potentialSlots ||
          compareStrings(a.titleId, b.titleId),
      );
      free = Math.max(capacity - lines.reduce((s, l) => s + l.currentSlots, 0), 0);
    }
    const lockedLines = lines.filter((l) => l.locked);
    const mName = machineName(machineId);
    const parts: string[] = [];
    if (action === "change") {
      parts.push(
        `${mName}: ${plural(changes.length, "ändring", "ändringar")} i ${capacity} fack, väntad effekt ${signedKr(potentialOre)}/vecka.`,
      );
      parts.push(...changes.map((c) => c.text));
    } else if (changes.length === 0) {
      parts.push(
        `${mName}: behåll sortimentet; ingen omfördelning av de ${capacity} facken ger mer bidrag.`,
      );
    } else {
      parts.push(
        `${mName}: behåll sortimentet; bästa omfördelningen ger bara ${signedKr(potentialOre)}/vecka (gräns ${signedKr(minEffect)}).`,
      );
    }
    if (free > 0)
      parts.push(
        action === "change"
          ? `${plural(free, "fack", "fack")} blir lediga: ingen titel med känt bidrag behöver dem.`
          : `${plural(free, "fack", "fack")} står lediga: ingen titel med känt bidrag behöver dem.`,
      );
    if (lockedLines.length > 0) {
      parts.push(
        `Oförändrade: ${listText(lockedLines.map((l) => `${titleName(l.titleId)} (${l.locked === "missing-price" ? "saknar inköpspris" : `under ${minExposureDays} dagar i automaten`})`))}.`,
      );
    }
    const fingerprint = lines
      .filter((l) => l.recommendedSlots > 0)
      .map((l) => `${l.titleId}:${l.recommendedSlots}`)
      .sort(compareStrings)
      .join(",");
    out.push({
      key: `assortment:${machineId}`,
      fingerprint,
      machineId,
      action,
      capacity,
      freeSlots: free,
      lines,
      changes: action === "change" ? changes : [],
      effectPerWeekOre: action === "change" ? potentialOre : 0,
      potentialEffectPerWeekOre: potentialOre,
      similar,
      text: parts.join(" "),
      evidence: marketEvidence({
        rule: `Efterfrågan per titel (pack/vecka under ${periodText(input.period)}) och bidrag per pack; ett fack rymmer ${slotCapacity} pack per påfyllning var ${refillDays}:e dag (${tenthsText(tenthsOf(capPerWeek))} pack/vecka). Facken fördelas där nästa fack ger mest bidrag per vecka.`,
        period: input.period,
        orderIds: candidates.flatMap((c) => c.orderIds),
        titleIds: candidates.map((c) => c.titleId),
        machineIds: [machineId, ...similar.map((s) => s.machineId)],
        figures: [
          fig("capacity", "Fack i automaten", capacity, "count"),
          fig("slotCapacity", "Pack per fack", slotCapacity, "packs"),
          fig("refillIntervalDays", "Dagar mellan påfyllningar", refillDays, "days"),
          fig("effectPerWeekOre", "Väntad effekt per vecka", potentialOre, "ore"),
          fig("minEffectPerWeekOre", "Minsta effekt för ändring", minEffect, "ore"),
        ],
      }),
    });
  }
  return out;
}
