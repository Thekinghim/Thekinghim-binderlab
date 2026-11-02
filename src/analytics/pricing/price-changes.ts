/**
 * Prisändringar: när ändrades försäljningspriset för en titel, och hur påverkades
 * försäljningen?
 *
 * Upptäckt (`detectPriceChanges`): för varje dag med försäljning tas dagens vanligaste belopp
 * (typvärde; lika många → lägst belopp). Priset räknas som ändrat den första dag då
 * typvärdet skiljer sig från det gällande priset, om det nya priset är typvärde även de
 * följande dagarna med försäljning, sammanlagt `minDays` dagar i rad (standard 3). Enstaka
 * avvikande dagar (en kampanj, en felinställd automat) blir alltså ingen ändring.
 *
 * Effekt (`priceChangeEffect`), enkel difference-in-differences:
 *
 *   L        = min(fönster, dagar från ändringen till och med asOf)   (samma längd före och efter)
 *   före     = L dagar före ändringsdagen, efter = ändringsdagen och L − 1 dagar framåt
 *   väntat   = titelns pack före × jämförelsegruppens pack efter / jämförelsegruppens pack före
 *   effekt   = (titelns pack efter − väntat) / väntat                 (i bp)
 *   elasticitet = effekt / prisändring                                (i hundradelar)
 *
 * Jämförelsegrupp: övriga titlar i de automater som sålde titeln både före och efter
 * (standard), eller samma titel i kontrollautomater (pristest, se `experiments.ts`). Så räknas
 * säsong, lönevecka och allmän efterfrågan bort. Övriga titlar som själva bytte pris (enligt
 * `detectPriceChanges` i samma automater) någon gång från första placeboperioden till och
 * med efterfönstret utesluts automatiskt (`autoExcludePriceChanges`, standard på), eftersom
 * deras försäljning då inte visar den allmänna efterfrågan. Uteslutna titlar redovisas i
 * `excludedTitleIds`.
 *
 * Bidragseffekt per vecka = (pack efter × bidrag per pack efter − väntat × bidrag per pack före)
 * × 7 / L, där bidrag = nettointäkt − inköp − kortavgift − provision (prissatta order).
 *
 * Vanlig variation (placebo): samma beräkning görs för upp till `placeboCount` lika långa
 * perioder före ändringen, där inget pris ändrades. Effekten räknas som tydlig bara om den är
 * större än den största placeboeffekten och båda fönstren har minst `minUnits` pack.
 *
 * Underlag: `evidence` har titelns egna order. Jämförelsegruppens order, titlar och automater
 * finns i `controlEvidence`, och placeboperiodernas fönster och antal i `placeboWindows`
 * (samt deras datum i `controlEvidence.dates`), så att UI kan visa vad jämförelsen bygger på.
 */

import {
  addDays,
  assertIsoDate,
  daysBetween,
  DomainError,
  minDate,
  type EconomicsSources,
  type IsoDate,
  type OrderLine,
  type Period,
} from "@/domain";
import { fig, hundredths, Ratio, signedKr, signedPct } from "../expansion/common";
import { nameLookup } from "../todos/common";
import { day, krExact, plural } from "../todos/text";
import {
  bpOf,
  byDateThenId,
  compareStrings,
  listText,
  marketEvidence,
  modalAmount,
  orderContributions,
  pctAbs,
  relativeChangeBp,
  signedTenths,
  tenthsText,
  type MarketEvidence,
} from "./common";
import type { NamedRef } from "./market";

// ---------------------------------------------------------------------------
// Upptäckt
// ---------------------------------------------------------------------------

/** En upptäckt prisändring. */
export interface PriceChangeEvent {
  /** Stabil nyckel 'price-change:<titel>:<datum>'. */
  readonly key: string;
  readonly titleId: string;
  /** Första dagen med det nya priset. */
  readonly date: IsoDate;
  readonly fromOre: number;
  readonly toOre: number;
  readonly changeBp: number;
  readonly text: string;
  readonly evidence: MarketEvidence;
}

/** Inställningar för `detectPriceChanges`. */
export interface DetectPriceChangeOptions {
  /** Antal dagar med försäljning i rad som det nya priset måste hålla. Standard 3. */
  readonly minDays?: number;
  /** Bara dessa titlar. */
  readonly titleIds?: readonly string[];
  /** Bara order från dessa automater (t.ex. när priset sätts per automat). */
  readonly machineIds?: readonly string[];
  readonly titles?: readonly NamedRef[];
}

/**
 * Prisändringar per titel ur orderna, sorterade på datum och titel. Exempel: typvärde
 * 59 kr 1–31 okt. och 64 kr 1–5 nov. → en ändring 1 nov. från 5 900 till 6 400 öre (+8 %).
 */
export function detectPriceChanges(
  orders: readonly OrderLine[],
  options: DetectPriceChangeOptions = {},
): PriceChangeEvent[] {
  const minDays = options.minDays ?? 3;
  if (!Number.isSafeInteger(minDays) || minDays < 1) {
    throw new DomainError(
      "invalid_input",
      `Antal dagar måste vara ett heltal ≥ 1, fick ${minDays}.`,
    );
  }
  const titleFilter = options.titleIds ? new Set(options.titleIds) : null;
  const machineFilter = options.machineIds ? new Set(options.machineIds) : null;
  const titleName = nameLookup(options.titles ?? []);

  const byTitle = new Map<string, Map<IsoDate, OrderLine[]>>();
  for (const o of orders) {
    assertIsoDate(o.businessDate, `Affärsdatum för order ${o.id}`);
    if (titleFilter && !titleFilter.has(o.titleId)) continue;
    if (machineFilter && (o.machineId === null || !machineFilter.has(o.machineId))) continue;
    let days = byTitle.get(o.titleId);
    if (!days) byTitle.set(o.titleId, (days = new Map()));
    const list = days.get(o.businessDate);
    if (list) list.push(o);
    else days.set(o.businessDate, [o]);
  }

  const out: PriceChangeEvent[] = [];
  for (const titleId of [...byTitle.keys()].sort(compareStrings)) {
    const days = byTitle.get(titleId)!;
    const dates = [...days.keys()].sort();
    const modal = dates.map((d) => modalAmount(days.get(d)!)!);
    let current = modal[0]!;
    for (let i = 1; i < dates.length; i++) {
      const candidate = modal[i]!;
      if (candidate === current) continue;
      if (i + minDays > dates.length) break;
      let held = true;
      for (let j = i; j < i + minDays; j++) if (modal[j] !== candidate) held = false;
      if (!held) continue;
      const confirmDates = dates.slice(i, i + minDays);
      const changeBp = relativeChangeBp(candidate, current);
      const date = dates[i]!;
      out.push({
        key: `price-change:${titleId}:${date}`,
        titleId,
        date,
        fromOre: current,
        toOre: candidate,
        changeBp: changeBp ?? 0,
        text: `${titleName(titleId)} ${candidate > current ? "höjdes" : "sänktes"} ${day(date)} från ${krExact(current)} till ${krExact(candidate)}${changeBp === null ? "" : ` (${signedPct(changeBp)})`}.`,
        evidence: marketEvidence({
          rule: `Vanligaste beloppet per dag; ett nytt pris räknas när det är vanligast ${plural(minDays, "dag", "dagar")} med försäljning i rad.`,
          dates: [dates[i - 1]!, ...confirmDates],
          titleIds: [titleId],
          orderIds: [dates[i - 1]!, ...confirmDates].flatMap((d) => days.get(d)!.map((o) => o.id)),
          figures: [
            fig("fromOre", "Pris före", current, "ore"),
            fig("toOre", "Pris efter", candidate, "ore"),
            ...(changeBp === null ? [] : [fig("changeBp", "Prisändring", changeBp, "bp")]),
          ],
        }),
      });
      current = candidate;
    }
  }
  return out.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : compareStrings(a.titleId, b.titleId),
  );
}

// ---------------------------------------------------------------------------
// Effekt
// ---------------------------------------------------------------------------

/** Indata till `priceChangeEffect`. */
export interface PriceChangeEffectInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly titleId: string;
  /** Första dagen med det nya priset. */
  readonly changeDate: IsoDate;
  /** Sista dag med data. */
  readonly asOf: IsoDate;
  /** Fönstrets längd före och efter, i dagar. Standard 28. */
  readonly windowDays?: number;
  /** Pristest: automater med nytt pris. Anges de jämförs med `controlMachineIds` i stället för övriga titlar. */
  readonly testMachineIds?: readonly string[];
  readonly controlMachineIds?: readonly string[];
  /** Titlar som inte får ingå i jämförelsegruppen (t.ex. en kampanj som inte är en prisändring). */
  readonly excludeTitleIds?: readonly string[];
  /**
   * Uteslut övriga titlar som själva bytte pris under mätningen (se modulens beskrivning).
   * Standard `true`. Gäller bara jämförelse mot övriga titlar.
   */
  readonly autoExcludePriceChanges?: boolean;
  /** Antal placeboperioder. Standard 3. */
  readonly placeboCount?: number;
  /** Minsta antal pack i varje fönster för en tydlig slutsats. Standard 30. */
  readonly minUnits?: number;
  readonly titles?: readonly NamedRef[];
  readonly machines?: readonly NamedRef[];
}

/** Slutsats. */
export type PriceEffectVerdict = "clear" | "uncertain" | "too-early" | "no-data";

/** En placeboperiod. */
export interface PlaceboResult {
  readonly changeDate: IsoDate;
  /** Effekt i bp, `null` om titeln inte sålde före. */
  readonly effectBp: number | null;
}

/** En placeboperiods fönster och antal, som underlag till `PlaceboResult`. */
export interface PlaceboWindow {
  readonly changeDate: IsoDate;
  readonly before: Period;
  readonly after: Period;
  readonly unitsBefore: number;
  readonly unitsAfter: number;
  readonly controlUnitsBefore: number;
  readonly controlUnitsAfter: number;
  readonly effectBp: number | null;
}

/** Resultat. */
export interface PriceChangeEffect {
  readonly titleId: string;
  readonly changeDate: IsoDate;
  readonly verdict: PriceEffectVerdict;
  /** Skäl till att slutsatsen är osäker (svenska meningar). */
  readonly reasons: readonly string[];
  readonly control: "titles" | "machines" | "none";
  readonly windowDays: number;
  readonly before: Period | null;
  readonly after: Period | null;
  readonly machineIds: readonly string[];
  readonly fromOre: number | null;
  readonly toOre: number | null;
  readonly priceChangeBp: number | null;
  readonly unitsBefore: number;
  readonly unitsAfter: number;
  readonly controlUnitsBefore: number;
  readonly controlUnitsAfter: number;
  /** Väntade pack efter utan prisändringen, i tiondelar. */
  readonly expectedUnitsAfterTenths: number | null;
  readonly effectUnitsTenths: number | null;
  readonly effectBp: number | null;
  /** Elasticitet i hundradelar (−150 = −1,5). Kan matas in i prisscenariot. */
  readonly elasticityHundredths: number | null;
  readonly contributionPerPackBeforeOre: number | null;
  readonly contributionPerPackAfterOre: number | null;
  /** Bidragseffekt per vecka i öre. */
  readonly contributionEffectPerWeekOre: number | null;
  readonly placebos: readonly PlaceboResult[];
  /** Placeboperiodernas fönster och antal, i samma ordning som `placebos`. */
  readonly placeboWindows: readonly PlaceboWindow[];
  /** Största |placeboeffekt| i bp. `null` utan placeboperioder. */
  readonly noiseBp: number | null;
  /** Titlar i jämförelsegruppen (sålda före eller efter), sorterade. */
  readonly controlTitleIds: readonly string[];
  /** Titlar som uteslöts ur jämförelsegruppen: angivna och automatiskt (eget prisbyte). */
  readonly excludedTitleIds: readonly string[];
  readonly text: string;
  /** Titelns egna order före och efter. */
  readonly evidence: MarketEvidence;
  /** Jämförelsegruppens order, titlar och automater, samt placeboperiodernas datum. */
  readonly controlEvidence: MarketEvidence;
}

interface Arms {
  treated: OrderLine[];
  control: OrderLine[];
}

function inRange(date: IsoDate, p: Period): boolean {
  return date >= p.start && date <= p.end;
}

/** Effekt i bp och väntat antal enligt difference-in-differences. */
function didEffect(
  preT: number,
  postT: number,
  preC: number,
  postC: number,
  useControl: boolean,
): { expected: Ratio; effectBp: number } | null {
  if (preT === 0) return null;
  const expected = useControl && preC > 0 ? new Ratio(preT).mul(postC).div(preC) : new Ratio(preT);
  if (expected.sign() === 0) return null;
  return { expected, effectBp: bpOf(new Ratio(postT).sub(expected).div(expected)) };
}

/**
 * Effekten av en prisändring på försäljningen (se modulens beskrivning). Kastar
 * `DomainError` vid ogiltiga datum eller om test- och kontrollautomater överlappar.
 */
export function priceChangeEffect(input: PriceChangeEffectInput): PriceChangeEffect {
  assertIsoDate(input.changeDate, "Ändringsdag");
  assertIsoDate(input.asOf, "Sista dag med data");
  const windowDays = input.windowDays ?? 28;
  const placeboCount = input.placeboCount ?? 3;
  const minUnits = input.minUnits ?? 30;
  for (const [v, label, min] of [
    [windowDays, "Fönstret", 1],
    [placeboCount, "Antal placeboperioder", 0],
    [minUnits, "Minsta antal pack", 0],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < min) {
      throw new DomainError("invalid_input", `${label} måste vara ett heltal ≥ ${min}, fick ${v}.`);
    }
  }
  const machineMode = input.testMachineIds !== undefined || input.controlMachineIds !== undefined;
  const testSet = new Set(input.testMachineIds ?? []);
  const controlSet = new Set(input.controlMachineIds ?? []);
  if (machineMode) {
    if (testSet.size === 0) {
      throw new DomainError("invalid_input", "Pristestet saknar testautomater.");
    }
    for (const m of testSet) {
      if (controlSet.has(m)) {
        throw new DomainError("invalid_input", `Automat ${m} är både test- och kontrollautomat.`);
      }
    }
  }
  const excluded = new Set(input.excludeTitleIds ?? []);
  const titleName = nameLookup(input.titles ?? [])(input.titleId);
  const machineName = nameLookup(input.machines ?? []);
  const L = Math.min(windowDays, daysBetween(input.changeDate, input.asOf) + 1);

  const empty = (verdict: PriceEffectVerdict, text: string): PriceChangeEffect => ({
    titleId: input.titleId,
    changeDate: input.changeDate,
    verdict,
    reasons: [text],
    control: "none",
    windowDays: Math.max(L, 0),
    before: null,
    after: null,
    machineIds: [],
    fromOre: null,
    toOre: null,
    priceChangeBp: null,
    unitsBefore: 0,
    unitsAfter: 0,
    controlUnitsBefore: 0,
    controlUnitsAfter: 0,
    expectedUnitsAfterTenths: null,
    effectUnitsTenths: null,
    effectBp: null,
    elasticityHundredths: null,
    contributionPerPackBeforeOre: null,
    contributionPerPackAfterOre: null,
    contributionEffectPerWeekOre: null,
    placebos: [],
    placeboWindows: [],
    noiseBp: null,
    controlTitleIds: [],
    excludedTitleIds: [...excluded].sort(compareStrings),
    text,
    evidence: marketEvidence({
      rule: "Difference-in-differences: titelns försäljning före och efter mot en jämförelsegrupp.",
      titleIds: [input.titleId],
      dates: [input.changeDate],
    }),
    controlEvidence: marketEvidence({
      rule: "Jämförelsegrupp: ingen mätning gjordes.",
      dates: [input.changeDate],
    }),
  });

  if (L < 1) {
    return empty(
      "too-early",
      `${titleName}: prisändringen ${day(input.changeDate)} har inte börjat gälla ännu.`,
    );
  }

  const before: Period = {
    start: addDays(input.changeDate, -L),
    end: addDays(input.changeDate, -1),
  };
  const after: Period = { start: input.changeDate, end: addDays(input.changeDate, L - 1) };

  // Automater som ingår.
  let machines: string[];
  if (machineMode) {
    machines = [...testSet].sort(compareStrings);
  } else {
    const sold = (p: Period) =>
      new Set(
        input.orders
          .filter(
            (o) =>
              o.titleId === input.titleId && o.machineId !== null && inRange(o.businessDate, p),
          )
          .map((o) => o.machineId!),
      );
    const a = sold(before);
    const b = sold(after);
    machines = [...a].filter((m) => b.has(m)).sort(compareStrings);
  }
  const machineSet = new Set(machines);

  // Övriga titlar som själva bytte pris under hela mätningen (placebo + före + efter).
  if (!machineMode && (input.autoExcludePriceChanges ?? true)) {
    const spanStart = addDays(input.changeDate, -(placeboCount + 1) * L);
    const others = input.orders.filter(
      (o) =>
        o.titleId !== input.titleId &&
        o.machineId !== null &&
        machineSet.has(o.machineId) &&
        o.businessDate >= spanStart &&
        o.businessDate <= after.end,
    );
    for (const c of detectPriceChanges(others)) excluded.add(c.titleId);
  }
  const excludedTitleIds = [...excluded].sort(compareStrings);

  const arms = (p: Period): Arms => {
    const treated: OrderLine[] = [];
    const control: OrderLine[] = [];
    for (const o of input.orders) {
      if (o.machineId === null || !inRange(o.businessDate, p)) continue;
      if (machineMode) {
        if (o.titleId !== input.titleId) continue;
        if (testSet.has(o.machineId)) treated.push(o);
        else if (controlSet.has(o.machineId)) control.push(o);
      } else if (machineSet.has(o.machineId)) {
        if (o.titleId === input.titleId) treated.push(o);
        else if (!excluded.has(o.titleId)) control.push(o);
      }
    }
    treated.sort(byDateThenId);
    control.sort(byDateThenId);
    return { treated, control };
  };

  const pre = arms(before);
  const post = arms(after);
  if (pre.treated.length === 0 || post.treated.length === 0) {
    return {
      ...empty(
        "no-data",
        `${titleName}: för lite försäljning för att mäta prisändringen ${day(input.changeDate)} (${pre.treated.length} pack före, ${post.treated.length} efter i samma automater).`,
      ),
      windowDays: L,
      before,
      after,
      unitsBefore: pre.treated.length,
      unitsAfter: post.treated.length,
    };
  }
  const useControl = pre.control.length > 0;
  const control: PriceChangeEffect["control"] = useControl
    ? machineMode
      ? "machines"
      : "titles"
    : "none";
  const did = didEffect(
    pre.treated.length,
    post.treated.length,
    pre.control.length,
    post.control.length,
    useControl,
  )!;

  const fromOre = modalAmount(pre.treated)!;
  const toOre = modalAmount(post.treated)!;
  const priceChangeBp = relativeChangeBp(toOre, fromOre);
  const elasticityHundredths =
    priceChangeBp !== null && priceChangeBp !== 0
      ? new Ratio(did.effectBp * 100, priceChangeBp).round()
      : null;

  // Bidrag.
  const contributions = orderContributions([...pre.treated, ...post.treated], input);
  const avgContribution = (list: OrderLine[]): Ratio | null => {
    let sum = 0n;
    let n = 0;
    for (const o of list) {
      const c = contributions.get(o.id);
      if (c === null || c === undefined) continue;
      sum += BigInt(c);
      n++;
    }
    return n === 0 ? null : new Ratio(sum, n);
  };
  const cBefore = avgContribution(pre.treated);
  const cAfter = avgContribution(post.treated);
  const contributionEffectPerWeekOre =
    cBefore && cAfter
      ? cAfter.mul(post.treated.length).sub(cBefore.mul(did.expected)).mul(7).div(L).round()
      : null;

  // Placebo: lika långa perioder före ändringen.
  const firstDate = input.orders.reduce<IsoDate | null>(
    (m, o) => (m === null ? o.businessDate : minDate(m, o.businessDate)),
    null,
  );
  const placebos: PlaceboResult[] = [];
  const placeboWindows: PlaceboWindow[] = [];
  for (let k = 1; k <= placeboCount; k++) {
    const d = addDays(input.changeDate, -k * L);
    const pb: Period = { start: addDays(d, -L), end: addDays(d, -1) };
    if (firstDate === null || pb.start < firstDate) break;
    const pa: Period = { start: d, end: addDays(d, L - 1) };
    const a = arms(pb);
    const b = arms(pa);
    const r = didEffect(
      a.treated.length,
      b.treated.length,
      a.control.length,
      b.control.length,
      useControl,
    );
    placebos.push({ changeDate: d, effectBp: r ? r.effectBp : null });
    placeboWindows.push({
      changeDate: d,
      before: pb,
      after: pa,
      unitsBefore: a.treated.length,
      unitsAfter: b.treated.length,
      controlUnitsBefore: a.control.length,
      controlUnitsAfter: b.control.length,
      effectBp: r ? r.effectBp : null,
    });
  }
  const placeboValues = placebos.map((p) => p.effectBp).filter((v): v is number => v !== null);
  const noiseBp = placeboValues.length > 0 ? Math.max(...placeboValues.map(Math.abs)) : null;

  const reasons: string[] = [];
  if (L < windowDays)
    reasons.push(`Bara ${plural(L, "dag", "dagar")} sedan ändringen (fönstret är ${windowDays}).`);
  if (pre.treated.length < minUnits || post.treated.length < minUnits) {
    reasons.push(
      `Färre än ${minUnits} pack i ett fönster (${pre.treated.length} före, ${post.treated.length} efter).`,
    );
  }
  if (!useControl) reasons.push("Ingen jämförelsegrupp: bara före och efter.");
  if (noiseBp === null)
    reasons.push("Ingen tidigare period att jämföra den vanliga variationen med.");
  else if (Math.abs(did.effectBp) <= noiseBp) {
    reasons.push(
      `Effekten (${signedPct(did.effectBp)}) är inte större än den vanliga variationen (±${pctAbs(noiseBp)}).`,
    );
  }
  const verdict: PriceEffectVerdict = reasons.length === 0 ? "clear" : "uncertain";

  const controlOrders = [...pre.control, ...post.control];
  const controlTitleIds = [...new Set(controlOrders.map((o) => o.titleId))].sort(compareStrings);
  const controlMachineIds = machineMode
    ? [...controlSet].sort(compareStrings)
    : [...new Set(controlOrders.map((o) => o.machineId!))].sort(compareStrings);

  const effectUnits = new Ratio(post.treated.length).sub(did.expected);
  const tenths = (r: Ratio) => r.mul(10).round();
  const expectedText = tenthsText(tenths(did.expected));
  const raised = toOre > fromOre ? "höjningen" : toOre < fromOre ? "sänkningen" : "ändringen";
  const groupText =
    control === "machines"
      ? `Samma titel i kontrollautomaterna (${[...controlSet].sort(compareStrings).map(machineName).join(", ")}) ändrades ${signedPct(relativeChangeBp(post.control.length, pre.control.length) ?? 0)}`
      : control === "titles"
        ? `Övriga titlar i samma automater ändrades ${signedPct(relativeChangeBp(post.control.length, pre.control.length) ?? 0)}`
        : "Ingen jämförelsegrupp fanns";
  const parts = [
    `Efter ${raised} ${day(input.changeDate)} från ${krExact(fromOre)} till ${krExact(toOre)}${priceChangeBp === null ? "" : ` (${signedPct(priceChangeBp)})`} såldes ${plural(post.treated.length, "pack", "pack")} av ${titleName} på ${plural(L, "dag", "dagar")}, mot ${pre.treated.length} de ${L} dagarna före.`,
    `${groupText}, så utan ändringen väntades ${expectedText} pack.`,
    `Effekt: ${signedPct(did.effectBp)} (${signedTenths(tenths(effectUnits))} pack)${elasticityHundredths === null ? "" : `, elasticitet ${hundredths(elasticityHundredths)}`}.`,
  ];
  if (contributionEffectPerWeekOre !== null) {
    parts.push(`Bidrag: ${signedKr(contributionEffectPerWeekOre)}/vecka.`);
  }
  if (!machineMode && excludedTitleIds.length > 0) {
    const excludedName = nameLookup(input.titles ?? []);
    parts.push(`Utanför jämförelsen: ${listText(excludedTitleIds.map(excludedName))}.`);
  }
  if (noiseBp !== null) {
    parts.push(
      `Vanlig variation (${plural(placeboValues.length, "tidigare period", "tidigare perioder")}): ±${pctAbs(noiseBp)}.`,
    );
  }
  parts.push(verdict === "clear" ? "Slutsatsen är tydlig." : `Osäkert: ${reasons.join(" ")}`);

  return {
    titleId: input.titleId,
    changeDate: input.changeDate,
    verdict,
    reasons,
    control,
    windowDays: L,
    before,
    after,
    machineIds: machines,
    fromOre,
    toOre,
    priceChangeBp,
    unitsBefore: pre.treated.length,
    unitsAfter: post.treated.length,
    controlUnitsBefore: pre.control.length,
    controlUnitsAfter: post.control.length,
    expectedUnitsAfterTenths: tenths(did.expected),
    effectUnitsTenths: tenths(effectUnits),
    effectBp: did.effectBp,
    elasticityHundredths,
    contributionPerPackBeforeOre: cBefore ? cBefore.round() : null,
    contributionPerPackAfterOre: cAfter ? cAfter.round() : null,
    contributionEffectPerWeekOre,
    placebos,
    placeboWindows,
    noiseBp,
    controlTitleIds,
    excludedTitleIds,
    text: parts.join(" "),
    evidence: marketEvidence({
      rule: "Difference-in-differences: väntat = pack före × jämförelsegruppens pack efter / före; effekt = (pack efter − väntat) / väntat. Placeboperioder före ändringen visar den vanliga variationen.",
      period: { start: before.start, end: after.end },
      orderIds: [...pre.treated, ...post.treated].map((o) => o.id),
      dates: [input.changeDate],
      titleIds: [input.titleId],
      machineIds: machineMode ? [...machines, ...controlSet] : machines,
      figures: [
        fig("windowDays", "Dagar per fönster", L, "days"),
        fig("unitsBefore", "Pack före", pre.treated.length, "packs"),
        fig("unitsAfter", "Pack efter", post.treated.length, "packs"),
        fig("controlUnitsBefore", "Jämförelsegrupp före", pre.control.length, "packs"),
        fig("controlUnitsAfter", "Jämförelsegrupp efter", post.control.length, "packs"),
        fig("expectedUnitsAfter", "Väntade pack efter", tenths(did.expected), "tenths"),
        fig("effectBp", "Effekt", did.effectBp, "bp"),
        fig("fromOre", "Pris före", fromOre, "ore"),
        fig("toOre", "Pris efter", toOre, "ore"),
        ...(elasticityHundredths === null
          ? []
          : [fig("elasticity", "Elasticitet", elasticityHundredths, "hundredths")]),
        ...(contributionEffectPerWeekOre === null
          ? []
          : [
              fig(
                "contributionEffectPerWeekOre",
                "Bidragseffekt per vecka",
                contributionEffectPerWeekOre,
                "ore",
              ),
            ]),
        ...(noiseBp === null ? [] : [fig("noiseBp", "Vanlig variation", noiseBp, "bp")]),
      ],
    }),
    controlEvidence: marketEvidence({
      rule:
        control === "machines"
          ? "Jämförelsegrupp: samma titel i kontrollautomaterna, samma dagar före och efter. Datumen är ändringsdagen och placeboperiodernas tänkta ändringsdagar."
          : "Jämförelsegrupp: övriga titlar i samma automater, samma dagar före och efter, utom titlar som själva bytte pris. Datumen är ändringsdagen och placeboperiodernas tänkta ändringsdagar.",
      period: { start: before.start, end: after.end },
      orderIds: controlOrders.map((o) => o.id),
      dates: [input.changeDate, ...placeboWindows.map((p) => p.changeDate)],
      titleIds: controlTitleIds,
      machineIds: controlMachineIds,
      figures: [
        fig("controlUnitsBefore", "Jämförelsegrupp före", pre.control.length, "packs"),
        fig("controlUnitsAfter", "Jämförelsegrupp efter", post.control.length, "packs"),
        fig("placeboCount", "Placeboperioder", placeboWindows.length, "count"),
        fig("excludedTitles", "Uteslutna titlar", excludedTitleIds.length, "count"),
      ],
    }),
  };
}
