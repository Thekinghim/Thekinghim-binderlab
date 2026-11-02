/**
 * Försäljning per plats (fack): hur mycket varje titel säljer och tjänar per fack och vecka
 * i varje automat, och vilka automater som liknar varandra.
 *
 * Fackfördelningen (planogrammet) anges som perioder: titel X hade N fack i automat A från
 * och med `from` till och med `to` (`null` = fortfarande). Två perioder för samma automat och
 * titel får inte överlappa.
 *
 * Per automat och titel i perioden:
 *   exponeringsdagar = dagar med minst ett fack
 *   fackdagar        = Σ fack per dag
 *   efterfrågan      = pack × 7 / exponeringsdagar        (pack per vecka; räknas bara när
 *                      exponeringsdagarna ≥ minExposureDays, annars för lite data)
 *   pack per fack och vecka = pack × 7 / fackdagar
 *   bidrag per pack  = Σ bidrag / prissatta pack, där bidrag = nettointäkt − inköp −
 *                      kortavgift − provision (domänens regler; hyran är fast och ingår inte)
 * Order på dagar då titeln inte hade något fack räknas separat (`unassignedUnits`): de tyder
 * på att fackfördelningen inte är uppdaterad.
 *
 * Likhet mellan automater: försäljningsmixen (andel av automatens pack per titel, i bp)
 * jämförs. likhet = 10 000 − Σ |andel_a − andel_b| / 2. Samma mix = 10 000, inga gemensamma
 * titlar = 0.
 */

import {
  addDays,
  assertIsoDate,
  assertPeriod,
  DomainError,
  eachDay,
  type EconomicsSources,
  type IsoDate,
  type OrderLine,
  type Period,
} from "@/domain";
import { Ratio } from "../expansion/common";
import { bpOf, compareStrings, floorRatio, orderContributions } from "../pricing/common";

/** Fack för en titel i en automat under en period. */
export interface SlotAssignment {
  readonly machineId: string;
  readonly titleId: string;
  /** Antal fack (≥ 0). */
  readonly slots: number;
  readonly from: IsoDate;
  /** Sista dag (inklusive), `null` = fortfarande. */
  readonly to: IsoDate | null;
}

/** Indata till `slotPerformance`. */
export interface SlotPerformanceInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly assignments: readonly SlotAssignment[];
  /** Mätperioden, t.ex. de senaste 28 dagarna. */
  readonly period: Period;
  /** Minsta exponeringsdagar för att efterfrågan ska räknas. Standard 14. */
  readonly minExposureDays?: number;
}

/** Försäljning för en titel i en automat. */
export interface SlotPerformance {
  readonly machineId: string;
  readonly titleId: string;
  /** Fack periodens sista dag. */
  readonly currentSlots: number;
  readonly exposureDays: number;
  readonly slotDays: number;
  /** Sålda pack på dagar med fack. */
  readonly units: number;
  /** Sålda pack på dagar utan fack enligt fackfördelningen. */
  readonly unassignedUnits: number;
  readonly pricedUnits: number;
  /** Σ bidrag för prissatta pack, i öre. */
  readonly contributionOre: number;
  /** Pack per vecka, `null` vid för få exponeringsdagar. */
  readonly demandPerWeek: Ratio | null;
  /** Bidrag per pack, `null` utan prissatta pack. */
  readonly contributionPerPack: Ratio | null;
  /** Pack per fack och vecka i tiondelar, `null` utan fackdagar. */
  readonly unitsPerSlotWeekTenths: number | null;
  readonly orderIds: readonly string[];
}

/** Automatens totala nivå: pack per fackdag över alla titlar. */
export interface MachineLevel {
  readonly machineId: string;
  readonly units: number;
  readonly slotDays: number;
}

/** Resultat av `slotPerformance`. */
export interface SlotPerformanceResult {
  readonly period: Period;
  /** Per automat och titel, sorterat på automat och titel. */
  readonly rows: readonly SlotPerformance[];
  readonly machines: readonly MachineLevel[];
}

/** Nyckel för automat + titel. */
export function slotKey(machineId: string, titleId: string): string {
  return `${machineId}\u0000${titleId}`;
}

function validateAssignments(assignments: readonly SlotAssignment[]): void {
  const groups = new Map<string, SlotAssignment[]>();
  for (const a of assignments) {
    if (
      !a ||
      typeof a.machineId !== "string" ||
      a.machineId === "" ||
      typeof a.titleId !== "string" ||
      a.titleId === ""
    ) {
      throw new DomainError("invalid_input", "Fackfördelningen saknar automat eller titel.");
    }
    if (!Number.isSafeInteger(a.slots) || a.slots < 0) {
      throw new DomainError(
        "invalid_input",
        `Antal fack måste vara ett heltal ≥ 0, fick ${a.slots}.`,
      );
    }
    assertIsoDate(a.from, "Fackens från-datum");
    if (a.to !== null) {
      assertIsoDate(a.to, "Fackens till-datum");
      if (a.to < a.from) {
        throw new DomainError(
          "invalid_period",
          `Fackperioden slutar (${a.to}) före den börjar (${a.from}).`,
        );
      }
    }
    const k = slotKey(a.machineId, a.titleId);
    const list = groups.get(k);
    if (list) list.push(a);
    else groups.set(k, [a]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => compareStrings(a.from, b.from));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      if (prev.to === null || prev.to >= list[i]!.from) {
        throw new DomainError(
          "invalid_input",
          `Fackperioderna för titel ${list[i]!.titleId} i automat ${list[i]!.machineId} överlappar (${list[i]!.from}).`,
        );
      }
    }
  }
}

/** Försäljning per automat och titel per fack (se modulens beskrivning). */
export function slotPerformance(input: SlotPerformanceInput): SlotPerformanceResult {
  assertPeriod(input.period);
  const minExposure = input.minExposureDays ?? 14;
  if (!Number.isSafeInteger(minExposure) || minExposure < 1) {
    throw new DomainError(
      "invalid_input",
      `Minsta exponering måste vara ett heltal ≥ 1, fick ${minExposure}.`,
    );
  }
  validateAssignments(input.assignments);
  const { period } = input;
  const days = eachDay(period.start, period.end);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  // Fack per dag för varje automat + titel.
  const slotsByKey = new Map<string, number[]>();
  for (const a of input.assignments) {
    const k = slotKey(a.machineId, a.titleId);
    let arr = slotsByKey.get(k);
    if (!arr) slotsByKey.set(k, (arr = new Array<number>(days.length).fill(0)));
    const start = a.from > period.start ? a.from : period.start;
    const end = a.to === null || a.to > period.end ? period.end : a.to;
    if (start > end) continue;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const i = dayIndex.get(d)!;
      arr[i] = arr[i]! + a.slots;
    }
  }

  const inPeriod = input.orders.filter(
    (o) => o.machineId !== null && o.businessDate >= period.start && o.businessDate <= period.end,
  );
  const contributions = orderContributions(inPeriod, input);
  interface Acc {
    units: number;
    unassigned: number;
    priced: number;
    contribution: bigint;
    orderIds: string[];
  }
  const acc = new Map<string, Acc>();
  for (const o of inPeriod) {
    const k = slotKey(o.machineId!, o.titleId);
    let a = acc.get(k);
    if (!a)
      acc.set(k, (a = { units: 0, unassigned: 0, priced: 0, contribution: 0n, orderIds: [] }));
    const slots = slotsByKey.get(k)?.[dayIndex.get(o.businessDate)!] ?? 0;
    a.orderIds.push(o.id);
    if (slots === 0) {
      a.unassigned++;
      continue;
    }
    a.units++;
    const c = contributions.get(o.id);
    if (c !== null && c !== undefined) {
      a.priced++;
      a.contribution += BigInt(c);
    }
  }

  const keys = new Set([...slotsByKey.keys(), ...acc.keys()]);
  const rows: SlotPerformance[] = [];
  const levels = new Map<string, { units: number; slotDays: number }>();
  for (const k of keys) {
    const [machineId, titleId] = k.split("\u0000") as [string, string];
    const arr = slotsByKey.get(k) ?? [];
    const a = acc.get(k) ?? { units: 0, unassigned: 0, priced: 0, contribution: 0n, orderIds: [] };
    const exposureDays = arr.filter((s) => s > 0).length;
    const slotDays = arr.reduce((s, v) => s + v, 0);
    const lv = levels.get(machineId) ?? { units: 0, slotDays: 0 };
    lv.units += a.units;
    lv.slotDays += slotDays;
    levels.set(machineId, lv);
    rows.push({
      machineId,
      titleId,
      currentSlots: arr[arr.length - 1] ?? 0,
      exposureDays,
      slotDays,
      units: a.units,
      unassignedUnits: a.unassigned,
      pricedUnits: a.priced,
      contributionOre: floorRatio(new Ratio(a.contribution)),
      demandPerWeek: exposureDays >= minExposure ? new Ratio(a.units * 7, exposureDays) : null,
      contributionPerPack: a.priced > 0 ? new Ratio(a.contribution, a.priced) : null,
      unitsPerSlotWeekTenths: slotDays > 0 ? new Ratio(a.units * 70, slotDays).round() : null,
      orderIds: a.orderIds.sort(compareStrings),
    });
  }
  rows.sort(
    (a, b) => compareStrings(a.machineId, b.machineId) || compareStrings(a.titleId, b.titleId),
  );
  return {
    period,
    rows,
    machines: [...levels.entries()]
      .map(([machineId, v]) => ({ machineId, units: v.units, slotDays: v.slotDays }))
      .sort((a, b) => compareStrings(a.machineId, b.machineId)),
  };
}

/** Likhet mellan två automater. */
export interface MachineSimilarity {
  readonly machineId: string;
  /** 0–10 000. */
  readonly similarityBp: number;
}

/**
 * Försäljningsmix per automat: andel av automatens pack per titel som bråk.
 * Automater utan försäljning saknas.
 */
function salesMix(rows: readonly SlotPerformance[]): Map<string, Map<string, Ratio>> {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.machineId, (totals.get(r.machineId) ?? 0) + r.units);
  const mix = new Map<string, Map<string, Ratio>>();
  for (const r of rows) {
    const total = totals.get(r.machineId)!;
    if (total === 0 || r.units === 0) continue;
    let m = mix.get(r.machineId);
    if (!m) mix.set(r.machineId, (m = new Map()));
    m.set(r.titleId, new Ratio(r.units, total));
  }
  return mix;
}

/**
 * Automaterna som liknar `machineId` mest, enligt försäljningsmixen (se modulens
 * beskrivning). Mest lik först, lika → id. Högst `count` stycken.
 */
export function similarMachines(
  rows: readonly SlotPerformance[],
  machineId: string,
  count = 3,
): MachineSimilarity[] {
  const mix = salesMix(rows);
  const own = mix.get(machineId);
  if (!own) return [];
  const out: MachineSimilarity[] = [];
  for (const [other, m] of mix) {
    if (other === machineId) continue;
    let distance = new Ratio(0);
    for (const t of new Set([...own.keys(), ...m.keys()])) {
      const d = (own.get(t) ?? new Ratio(0)).sub(m.get(t) ?? new Ratio(0));
      distance = distance.add(d.sign() < 0 ? d.mul(-1) : d);
    }
    out.push({ machineId: other, similarityBp: 10_000 - bpOf(distance.div(2)) });
  }
  return out
    .sort((a, b) => b.similarityBp - a.similarityBp || compareStrings(a.machineId, b.machineId))
    .slice(0, count);
}
