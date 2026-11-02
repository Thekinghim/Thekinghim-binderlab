/**
 * Efter ett släpp: utfall mot förslaget.
 *
 * Regler (horisont H dagar, förfluten tid e = min(H, dagar från släppdagen till och med asOf)):
 * - Väntat hittills per automat = föreslagna pack × släppkurvans andel till och med dag e
 *   (`curveCumulativeBp`), eller × e / H om kurva saknas (jämn försäljning).
 * - Avvikelse = (sålt − väntat) / väntat i bp. Inom ±`toleranceBp` (standard 2 000 = 20 %)
 *   är utfallet "i linje", över är det "före", under "efter".
 * - Slutsålt: automaten har sålt minst så många pack som den fick. Dagen då det skedde anges.
 *   En slutsåld automat kan ha sålt mer med mer lager: utfallet är då en undre gräns.
 * - Försäljning i automater utan förslag redovisas separat. Den ingår i totalen (`actual`,
 *   `diffBp`) men inte i jämförelsen lika mot lika (`plannedActual`, `plannedDiffBp`): sålt i
 *   automaterna med förslag mot väntat för just dem. Riktningen (`pace`) och procenten i
 *   texten bygger på jämförelsen lika mot lika, så att oplanerad försäljning inte blåser upp
 *   avvikelsen.
 */

import {
  addDays,
  assertIsoDate,
  daysBetween,
  DomainError,
  type IsoDate,
  type OrderLine,
  type Period,
} from "@/domain";
import { fig, Ratio, signedPct } from "../expansion/common";
import { nameLookup } from "../todos/common";
import { day, plural } from "../todos/text";
import {
  byDateThenId,
  compareStrings,
  listText,
  marketEvidence,
  pctAbs,
  relativeChangeBp,
  tenthsOf,
  tenthsText,
  type MarketEvidence,
} from "../pricing/common";
import type { NamedRef } from "../pricing/market";
import { horizonOf } from "./curve";

/** Indata till `releaseOutcome`. */
export interface ReleaseOutcomeInput {
  readonly orders: readonly OrderLine[];
  readonly titleId: string;
  readonly releaseDate: IsoDate;
  readonly asOf: IsoDate;
  readonly horizonDays?: number;
  /** Förslaget (eller det som faktiskt lades i automaterna). */
  readonly allocations: readonly { readonly machineId: string; readonly units: number }[];
  /** Släppkurvan från förslaget (andel till och med dag d, i bp). */
  readonly curveCumulativeBp?: readonly number[];
  /** Tolerans i bp. Standard 2 000. */
  readonly toleranceBp?: number;
  readonly titles?: readonly NamedRef[];
  readonly machines?: readonly NamedRef[];
}

/** Utfallets riktning. */
export type ReleasePace = "ahead" | "on-track" | "behind";

/** Utfall per automat. */
export interface ReleaseMachineOutcome {
  readonly machineId: string;
  readonly allocated: number;
  readonly expectedByNowTenths: number;
  readonly actual: number;
  readonly diffBp: number | null;
  readonly pace: ReleasePace | null;
  readonly soldOut: boolean;
  readonly soldOutDate: IsoDate | null;
}

/** Utfall för släppet. */
export interface ReleaseOutcome {
  readonly titleId: string;
  readonly status: "not-started" | "running" | "done";
  readonly elapsedDays: number;
  readonly horizonDays: number;
  readonly period: Period | null;
  readonly machines: readonly ReleaseMachineOutcome[];
  /** Försäljning i automater utan förslag. */
  readonly unplanned: readonly { readonly machineId: string | null; readonly actual: number }[];
  readonly allocated: number;
  /** Väntat hittills i automaterna med förslag, i tiondelar. */
  readonly expectedByNowTenths: number;
  /** Sålda pack i alla automater (även utan förslag). */
  readonly actual: number;
  /** (`actual` − väntat) / väntat i bp: total, inklusive automater utan förslag. */
  readonly diffBp: number | null;
  /** Sålda pack i automaterna med förslag. */
  readonly plannedActual: number;
  /** (`plannedActual` − väntat) / väntat i bp: lika mot lika. */
  readonly plannedDiffBp: number | null;
  /** Riktning enligt `plannedDiffBp`. */
  readonly pace: ReleasePace | null;
  readonly text: string;
  readonly evidence: MarketEvidence;
}

function paceOf(diffBp: number | null, tolerance: number): ReleasePace | null {
  if (diffBp === null) return null;
  if (diffBp > tolerance) return "ahead";
  if (diffBp < -tolerance) return "behind";
  return "on-track";
}

/** Utfall mot förslag (se modulens regler). */
export function releaseOutcome(input: ReleaseOutcomeInput): ReleaseOutcome {
  assertIsoDate(input.releaseDate, "Släppdag");
  assertIsoDate(input.asOf, "Sista dag med data");
  const H = horizonOf(input.horizonDays);
  const tolerance = input.toleranceBp ?? 2_000;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new DomainError(
      "invalid_input",
      `Toleransen måste vara ett heltal ≥ 0, fick ${tolerance}.`,
    );
  }
  const curve = input.curveCumulativeBp;
  if (curve !== undefined && curve.length < H) {
    throw new DomainError(
      "invalid_input",
      `Släppkurvan har ${curve.length} dagar, horisonten ${H}.`,
    );
  }
  const allocated = new Map<string, number>();
  for (const a of input.allocations) {
    if (!Number.isSafeInteger(a.units) || a.units < 0) {
      throw new DomainError(
        "invalid_input",
        `Antalet för ${a.machineId} måste vara ett heltal ≥ 0.`,
      );
    }
    allocated.set(a.machineId, (allocated.get(a.machineId) ?? 0) + a.units);
  }
  const name = nameLookup(input.titles ?? [])(input.titleId);
  const machineName = nameLookup(input.machines ?? []);
  const totalAllocated = [...allocated.values()].reduce((s, u) => s + u, 0);
  const e = Math.min(H, daysBetween(input.releaseDate, input.asOf) + 1);

  if (e < 1) {
    return {
      titleId: input.titleId,
      status: "not-started",
      elapsedDays: 0,
      horizonDays: H,
      period: null,
      machines: [],
      unplanned: [],
      allocated: totalAllocated,
      expectedByNowTenths: 0,
      actual: 0,
      diffBp: null,
      plannedActual: 0,
      plannedDiffBp: null,
      pace: null,
      text: `${name} släpps ${day(input.releaseDate)}; inget utfall ännu.`,
      evidence: marketEvidence({
        rule: "Utfallet mäts från släppdagen.",
        titleIds: [input.titleId],
        dates: [input.releaseDate],
      }),
    };
  }

  const period: Period = { start: input.releaseDate, end: addDays(input.releaseDate, e - 1) };
  const orders = input.orders
    .filter(
      (o) =>
        o.titleId === input.titleId &&
        o.businessDate >= period.start &&
        o.businessDate <= period.end,
    )
    .sort(byDateThenId);
  const share = curve ? new Ratio(curve[e - 1]!, 10_000) : new Ratio(e, H);

  const machines: ReleaseMachineOutcome[] = [...allocated.keys()]
    .sort(compareStrings)
    .map((machineId) => {
      const alloc = allocated.get(machineId)!;
      const own = orders.filter((o) => o.machineId === machineId);
      const expected = new Ratio(alloc).mul(share);
      const diffBp = relativeChangeBp(new Ratio(own.length), expected);
      const soldOut = alloc > 0 && own.length >= alloc;
      return {
        machineId,
        allocated: alloc,
        expectedByNowTenths: tenthsOf(expected),
        actual: own.length,
        diffBp,
        pace: paceOf(diffBp, tolerance),
        soldOut,
        soldOutDate: soldOut ? own[alloc - 1]!.businessDate : null,
      };
    });
  const unplannedMap = new Map<string | null, number>();
  for (const o of orders) {
    if (o.machineId !== null && allocated.has(o.machineId)) continue;
    unplannedMap.set(o.machineId, (unplannedMap.get(o.machineId) ?? 0) + 1);
  }
  const unplanned = [...unplannedMap.entries()]
    .map(([machineId, actual]) => ({ machineId, actual }))
    .sort((a, b) => compareStrings(a.machineId ?? "", b.machineId ?? ""));

  const expectedTotal = new Ratio(totalAllocated).mul(share);
  const diffBp = relativeChangeBp(new Ratio(orders.length), expectedTotal);
  const unplannedUnits = unplanned.reduce((s, u) => s + u.actual, 0);
  const plannedActual = orders.length - unplannedUnits;
  const plannedDiffBp = relativeChangeBp(new Ratio(plannedActual), expectedTotal);
  const pace = paceOf(plannedDiffBp, tolerance);
  const status = e >= H ? "done" : "running";
  const paceText =
    pace === "ahead"
      ? "Före förslaget."
      : pace === "behind"
        ? "Efter förslaget."
        : pace === "on-track"
          ? "I linje med förslaget."
          : "";
  const soldText =
    unplannedUnits > 0
      ? `${plural(orders.length, "pack", "pack")} sålda, varav ${plannedActual} i automaterna med förslag`
      : `${plural(orders.length, "pack", "pack")} sålda`;
  const diffText = plannedDiffBp === null ? "" : ` (${signedPct(plannedDiffBp)})`;
  const parts = [
    status === "done"
      ? `${name} efter ${plural(H, "dag", "dagar")}: ${soldText} mot ${totalAllocated} föreslagna${diffText}.`
      : `${name} efter ${e} av ${H} dagar: ${soldText}, förslaget väntade ${tenthsText(tenthsOf(expectedTotal))} hittills${diffText}.`,
  ];
  if (paceText) parts.push(paceText);
  const soldOut = machines.filter((m) => m.soldOut);
  if (soldOut.length > 0) {
    parts.push(
      `Slutsålt: ${listText(soldOut.map((m) => `${machineName(m.machineId)} (${day(m.soldOutDate!)})`))}; där kunde mer ha sålts.`,
    );
  }
  if (unplannedUnits > 0) parts.push(`${unplannedUnits} pack såldes i automater utan förslag.`);

  return {
    titleId: input.titleId,
    status,
    elapsedDays: e,
    horizonDays: H,
    period,
    machines,
    unplanned,
    allocated: totalAllocated,
    expectedByNowTenths: tenthsOf(expectedTotal),
    actual: orders.length,
    diffBp,
    plannedActual,
    plannedDiffBp,
    pace,
    text: parts.join(" "),
    evidence: marketEvidence({
      rule: curve
        ? `Väntat hittills = föreslagna pack × släppkurvans andel efter ${e} dagar; avvikelse inom ±${pctAbs(tolerance)} är i linje.`
        : `Väntat hittills = föreslagna pack × ${e}/${H} (jämn försäljning); avvikelse inom ±${pctAbs(tolerance)} är i linje.`,
      period,
      orderIds: orders.map((o) => o.id),
      dates: soldOut.map((m) => m.soldOutDate!),
      titleIds: [input.titleId],
      machineIds: [
        ...allocated.keys(),
        ...unplanned.flatMap((u) => (u.machineId ? [u.machineId] : [])),
      ],
      figures: [
        fig("elapsedDays", "Dagar sedan släppet", e, "days"),
        fig("allocated", "Föreslagna pack", totalAllocated, "packs"),
        fig("expectedByNow", "Väntat hittills", tenthsOf(expectedTotal), "tenths"),
        fig("actual", "Sålda pack", orders.length, "packs"),
        fig("plannedActual", "Sålda pack i automater med förslag", plannedActual, "packs"),
        ...(plannedDiffBp === null
          ? []
          : [fig("plannedDiffBp", "Avvikelse lika mot lika", plannedDiffBp, "bp")]),
        ...(diffBp === null
          ? []
          : [fig("diffBp", "Avvikelse inklusive automater utan förslag", diffBp, "bp")]),
      ],
    }),
  };
}
