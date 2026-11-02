/**
 * Uppföljning av en genomförd sortimentsändring: före/efter med samma längd.
 *
 * Regler:
 * - L = min(`windowDays` (standard 28), dagar från genomförandet till och med asOf).
 *   Före = de L dagarna före genomförandedagen, efter = genomförandedagen och L − 1 dagar framåt.
 * - Bidrag per vecka = Σ bidrag (nettointäkt − inköp − kortavgift − provision, prissatta
 *   order) × 7 / L, för automaten. Pack per vecka på samma sätt.
 * - Jämförelse: övriga automater (eller `controlMachineIds`) under samma dagar. Justerad
 *   förändring = efter − före × (övrigas bidrag efter / övrigas bidrag före), så att säsong och
 *   allmän efterfrågan räknas bort. Saknar jämförelsegruppen bidrag före används ojusterad.
 * - Utfall mot väntad effekt (från rekommendationen): justerad förändring / väntad, i bp.
 * - Status: 'too-early' när L < 7, 'running' när L < fönstret, annars 'done'.
 */

import {
  addDays,
  assertIsoDate,
  daysBetween,
  DomainError,
  type EconomicsSources,
  type IsoDate,
  type OrderLine,
  type Period,
} from "@/domain";
import { fig, Ratio, signedKr, signedPct } from "../expansion/common";
import { nameLookup } from "../todos/common";
import { day, kr, pct, plural } from "../todos/text";
import {
  bpOf,
  byDateThenId,
  compareStrings,
  marketEvidence,
  orderContributions,
  type MarketEvidence,
} from "../pricing/common";
import type { NamedRef } from "../pricing/market";

/** Indata till `assortmentFollowUp`. */
export interface AssortmentFollowUpInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly machineId: string;
  /** Dagen då ändringen gjordes (första dagen med det nya sortimentet). */
  readonly implementedOn: IsoDate;
  readonly asOf: IsoDate;
  /** Standard 28. */
  readonly windowDays?: number;
  /** Väntad effekt i öre per vecka (från rekommendationen). */
  readonly expectedEffectPerWeekOre?: number | null;
  /** Jämförelseautomater. Standard: alla andra automater med order. */
  readonly controlMachineIds?: readonly string[];
  /** Titlar som ändrades, för en uppdelning per titel. */
  readonly changedTitleIds?: readonly string[];
  readonly machines?: readonly NamedRef[];
  readonly titles?: readonly NamedRef[];
}

/** Uppföljningens resultat. */
export interface AssortmentFollowUp {
  readonly machineId: string;
  readonly status: "not-started" | "too-early" | "running" | "done";
  readonly windowDays: number;
  readonly before: Period | null;
  readonly after: Period | null;
  readonly unitsBefore: number;
  readonly unitsAfter: number;
  /** Order utan inköpspris (ingår inte i bidraget). */
  readonly unpricedBefore: number;
  readonly unpricedAfter: number;
  readonly contributionPerWeekBeforeOre: number;
  readonly contributionPerWeekAfterOre: number;
  readonly changePerWeekOre: number;
  /** Jämförelsegruppens förändring av bidraget i bp, `null` utan underlag. */
  readonly controlChangeBp: number | null;
  readonly adjustedChangePerWeekOre: number;
  readonly expectedEffectPerWeekOre: number | null;
  /** Justerad förändring / väntad effekt i bp. */
  readonly achievedBp: number | null;
  readonly titles: readonly {
    readonly titleId: string;
    readonly unitsBefore: number;
    readonly unitsAfter: number;
  }[];
  readonly text: string;
  readonly evidence: MarketEvidence;
}

/** Före/efter-mätning av en sortimentsändring (se modulens regler). */
export function assortmentFollowUp(input: AssortmentFollowUpInput): AssortmentFollowUp {
  assertIsoDate(input.implementedOn, "Genomförandedag");
  assertIsoDate(input.asOf, "Sista dag med data");
  const windowDays = input.windowDays ?? 28;
  if (!Number.isSafeInteger(windowDays) || windowDays < 1) {
    throw new DomainError(
      "invalid_input",
      `Fönstret måste vara ett heltal ≥ 1, fick ${windowDays}.`,
    );
  }
  const expected = input.expectedEffectPerWeekOre ?? null;
  if (expected !== null && !Number.isSafeInteger(expected)) {
    throw new DomainError("invalid_amount", "Väntad effekt måste vara ett heltal i öre.");
  }
  const machineName = nameLookup(input.machines ?? [])(input.machineId);
  const titleName = nameLookup(input.titles ?? []);
  const L = Math.min(windowDays, daysBetween(input.implementedOn, input.asOf) + 1);

  if (L < 1) {
    return {
      machineId: input.machineId,
      status: "not-started",
      windowDays: 0,
      before: null,
      after: null,
      unitsBefore: 0,
      unitsAfter: 0,
      unpricedBefore: 0,
      unpricedAfter: 0,
      contributionPerWeekBeforeOre: 0,
      contributionPerWeekAfterOre: 0,
      changePerWeekOre: 0,
      controlChangeBp: null,
      adjustedChangePerWeekOre: 0,
      expectedEffectPerWeekOre: expected,
      achievedBp: null,
      titles: [],
      text: `${machineName}: ändringen genomförs ${day(input.implementedOn)}; inget att mäta ännu.`,
      evidence: marketEvidence({
        rule: "Före/efter med samma längd.",
        machineIds: [input.machineId],
        dates: [input.implementedOn],
      }),
    };
  }

  const before: Period = {
    start: addDays(input.implementedOn, -L),
    end: addDays(input.implementedOn, -1),
  };
  const after: Period = { start: input.implementedOn, end: addDays(input.implementedOn, L - 1) };
  const control = input.controlMachineIds ? new Set(input.controlMachineIds) : null;
  const relevant = input.orders.filter(
    (o) => o.machineId !== null && o.businessDate >= before.start && o.businessDate <= after.end,
  );
  const contributions = orderContributions(relevant, input);

  interface Sum {
    units: number;
    unpriced: number;
    contribution: bigint;
    orders: OrderLine[];
  }
  const sum = (machineFilter: (m: string) => boolean, p: Period): Sum => {
    const s: Sum = { units: 0, unpriced: 0, contribution: 0n, orders: [] };
    for (const o of relevant) {
      if (!machineFilter(o.machineId!) || o.businessDate < p.start || o.businessDate > p.end)
        continue;
      s.units++;
      s.orders.push(o);
      const c = contributions.get(o.id);
      if (c === null || c === undefined) s.unpriced++;
      else s.contribution += BigInt(c);
    }
    s.orders.sort(byDateThenId);
    return s;
  };
  const own = (m: string) => m === input.machineId;
  const others = (m: string) => m !== input.machineId && (control === null || control.has(m));
  const b = sum(own, before);
  const a = sum(own, after);
  const cb = sum(others, before);
  const ca = sum(others, after);

  const perWeek = (c: bigint) => new Ratio(c * 7n, BigInt(L));
  const weekBefore = perWeek(b.contribution);
  const weekAfter = perWeek(a.contribution);
  const change = weekAfter.sub(weekBefore);
  const controlFactor = cb.contribution > 0n ? new Ratio(ca.contribution, cb.contribution) : null;
  const adjusted = controlFactor ? weekAfter.sub(weekBefore.mul(controlFactor)) : change;
  const controlChangeBp = controlFactor ? bpOf(controlFactor.sub(new Ratio(1))) : null;
  const achievedBp = expected !== null && expected !== 0 ? bpOf(adjusted.div(expected)) : null;
  const status: AssortmentFollowUp["status"] =
    L < 7 ? "too-early" : L < windowDays ? "running" : "done";

  const changed = [...new Set(input.changedTitleIds ?? [])].sort(compareStrings);
  const titles = changed.map((titleId) => ({
    titleId,
    unitsBefore: b.orders.filter((o) => o.titleId === titleId).length,
    unitsAfter: a.orders.filter((o) => o.titleId === titleId).length,
  }));

  const parts = [
    `${machineName} ${L} dagar före och efter ändringen ${day(input.implementedOn)}: bidraget gick från ${kr(weekBefore.round())}/vecka till ${kr(weekAfter.round())}/vecka (${signedKr(change.round())}), ${b.units} → ${plural(a.units, "pack", "pack")}.`,
  ];
  if (controlChangeBp !== null) {
    parts.push(
      `Övriga automater ändrades ${signedPct(controlChangeBp)} under samma dagar; justerat ${signedKr(adjusted.round())}/vecka.`,
    );
  }
  if (expected !== null && achievedBp !== null) {
    parts.push(`Väntad effekt var ${signedKr(expected)}/vecka: ${pct(achievedBp)} uppnått.`);
  }
  if (titles.length > 0) {
    parts.push(
      titles
        .map((t) => `${titleName(t.titleId)} ${t.unitsBefore} → ${t.unitsAfter} pack`)
        .join(", ") + ".",
    );
  }
  if (b.unpriced + a.unpriced > 0) {
    parts.push(
      `${plural(b.unpriced + a.unpriced, "order", "order")} saknar inköpspris och ingår inte i bidraget.`,
    );
  }
  if (status === "too-early")
    parts.push(`För tidigt för en slutsats: bara ${plural(L, "dag", "dagar")}.`);
  else if (status === "running") parts.push(`Mätningen pågår (${L} av ${windowDays} dagar).`);

  return {
    machineId: input.machineId,
    status,
    windowDays: L,
    before,
    after,
    unitsBefore: b.units,
    unitsAfter: a.units,
    unpricedBefore: b.unpriced,
    unpricedAfter: a.unpriced,
    contributionPerWeekBeforeOre: weekBefore.round(),
    contributionPerWeekAfterOre: weekAfter.round(),
    changePerWeekOre: change.round(),
    controlChangeBp,
    adjustedChangePerWeekOre: adjusted.round(),
    expectedEffectPerWeekOre: expected,
    achievedBp,
    titles,
    text: parts.join(" "),
    evidence: marketEvidence({
      rule: "Bidrag per vecka före och efter med samma antal dagar; justerat med övriga automaters förändring under samma dagar.",
      period: { start: before.start, end: after.end },
      orderIds: [...b.orders, ...a.orders].map((o) => o.id),
      dates: [input.implementedOn],
      titleIds: changed,
      machineIds: [input.machineId],
      figures: [
        fig("windowDays", "Dagar per fönster", L, "days"),
        fig("contributionPerWeekBeforeOre", "Bidrag per vecka före", weekBefore.round(), "ore"),
        fig("contributionPerWeekAfterOre", "Bidrag per vecka efter", weekAfter.round(), "ore"),
        ...(controlChangeBp === null
          ? []
          : [fig("controlChangeBp", "Övriga automaters förändring", controlChangeBp, "bp")]),
        fig("adjustedChangePerWeekOre", "Justerad förändring per vecka", adjusted.round(), "ore"),
        ...(expected === null
          ? []
          : [fig("expectedEffectPerWeekOre", "Väntad effekt per vecka", expected, "ore")]),
      ],
    }),
  };
}
