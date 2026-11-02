/**
 * Förslag före ett släpp: hur många pack som ska köpas in och hur de fördelas per automat.
 *
 * Regler (horisont H dagar, standard 28):
 * 1. Jämförelsesläpp: kompletta tidigare släpp i samma serie, om det finns minst
 *    `minComparable` (standard 2); annars alla kompletta släpp.
 * 2. Förväntan per automat = medianen av vad automaten sålde de första H dagarna i de
 *    jämförda släppen där den var i drift hela horisonten ("historik"). Saknar automaten
 *    sådan historik används den typiska automaten: medianen av alla automaters värden i
 *    jämförelsesläppen ("typisk").
 * 3. Förväntan × `scaleBp` / 10 000 (standard 10 000 = oförändrat). Används för ett manuellt
 *    antagande, t.ex. 12 000 när släppet väntas bli 20 % större; antagandet syns i texten.
 * 4. Till automaterna: tak(Σ förväntan) pack, fördelade i proportion till förväntan med
 *    största-restmetoden (domänens `allocateLargestRemainder`), så att summan stämmer exakt.
 * 5. Inköp: (till automaterna − i lager) avrundat uppåt till hela lådor (`boxSize`) och minst
 *    `minOrderQty`; det som blir över går till centrallagret.
 * 6. Veckoplan: till automaterna fördelat efter släppkurvans veckoandelar.
 */

import {
  allocateLargestRemainder,
  assertIsoDate,
  ceilDiv,
  DomainError,
  type IsoDate,
} from "@/domain";
import { fig, Ratio } from "../expansion/common";
import { isMachineActive, nameLookup } from "../todos/common";
import { day, pct, plural } from "../todos/text";
import {
  ceilRatio,
  compareStrings,
  listText,
  marketEvidence,
  tenthsOf,
  tenthsText,
  type MarketEvidence,
} from "../pricing/common";
import { median } from "../pricing/robust";
import {
  horizonOf,
  releaseCurve,
  releaseProfiles,
  type ReleaseCurve,
  type ReleaseHistoryInput,
  type ReleaseProfile,
  type ReleaseRef,
} from "./curve";

/** Indata till `suggestReleasePurchase`. */
export interface ReleaseSuggestionInput extends ReleaseHistoryInput {
  /** Det kommande släppet. */
  readonly newRelease: ReleaseRef & { readonly releaseDate: IsoDate };
  /** Automater som ska få titeln. Standard: alla i drift på släppdagen. */
  readonly targetMachineIds?: readonly string[];
  /** Manuellt antagande om släppets storlek i bp. Standard 10 000 (= som tidigare släpp). */
  readonly scaleBp?: number;
  /** Pack per låda hos leverantören. Standard 1. */
  readonly boxSize?: number;
  /** Minsta beställning i pack. Standard 0. */
  readonly minOrderQty?: number;
  /** Pack av titeln som redan finns i lager. Standard 0. */
  readonly onHandUnits?: number;
  /** Minsta antal släpp i samma serie för att bara jämföra inom serien. Standard 2. */
  readonly minComparable?: number;
}

/** Förslag för en automat. */
export interface ReleaseAllocation {
  readonly machineId: string;
  /** Pack att lägga i automaten (för hela horisonten). */
  readonly units: number;
  /** Förväntad försäljning under horisonten, i tiondelar. */
  readonly expectedTenths: number;
  readonly source: "history" | "typical";
  /** Automatens försäljning i de jämförda släppen (tom vid "typisk"). */
  readonly historyUnits: readonly number[];
  readonly text: string;
}

/** Förslag före ett släpp. */
export interface ReleaseSuggestion {
  readonly titleId: string;
  readonly releaseDate: IsoDate;
  readonly status: "ok" | "no-history";
  readonly horizonDays: number;
  readonly basis: "series" | "all" | "none";
  readonly comparableTitleIds: readonly string[];
  readonly curve: ReleaseCurve | null;
  /** Typisk automat: median av alla automaters försäljning i jämförelsesläppen, i tiondelar. */
  readonly typicalUnitsPerMachineTenths: number | null;
  readonly scaleBp: number;
  readonly allocations: readonly ReleaseAllocation[];
  /** Pack till automaterna (Σ fördelning). */
  readonly machineUnits: number;
  readonly onHandUnits: number;
  /** Pack att köpa in. */
  readonly purchaseUnits: number;
  readonly boxSize: number;
  readonly boxes: number;
  /** Pack som blir kvar i centrallagret. */
  readonly warehouseUnits: number;
  /** Väntad försäljning per vecka (summerar till pack till automaterna). Tom utan kurva. */
  readonly weeklyUnits: readonly number[];
  readonly text: string;
  readonly evidence: MarketEvidence;
}

function int(value: number | undefined, fallback: number, label: string, min: number): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < min) {
    throw new DomainError("invalid_input", `${label} måste vara ett heltal ≥ ${min}, fick ${v}.`);
  }
  return v;
}

function normalizeSeries(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().toLocaleLowerCase("sv-SE").replace(/\s+/g, " ");
  return t === "" ? null : t;
}

/**
 * Förslag på inköpsmängd och fördelning per automat inför ett släpp (se modulens regler).
 * Utan jämförbara släpp blir `status` 'no-history' och inga pack föreslås.
 */
export function suggestReleasePurchase(input: ReleaseSuggestionInput): ReleaseSuggestion {
  const H = horizonOf(input.horizonDays);
  const release = input.newRelease;
  assertIsoDate(release.releaseDate, "Släppdag");
  const scaleBp = int(input.scaleBp, 10_000, "Antagandet om storlek", 0);
  const boxSize = int(input.boxSize, 1, "Pack per låda", 1);
  const minOrderQty = int(input.minOrderQty, 0, "Minsta beställning", 0);
  const onHandUnits = int(input.onHandUnits, 0, "Pack i lager", 0);
  const minComparable = int(input.minComparable, 2, "Minsta antal släpp i serien", 1);
  const titleName = nameLookup(input.titles ?? []);
  const machineName = nameLookup(input.machines);
  const name = titleName(release.titleId);

  const profiles = releaseProfiles({
    ...input,
    releases: input.releases.filter((r) => r.titleId !== release.titleId),
  }).filter((p) => p.complete);
  const series = normalizeSeries(release.series);
  const sameSeries =
    series === null ? [] : profiles.filter((p) => normalizeSeries(p.series) === series);
  const basis: ReleaseSuggestion["basis"] =
    profiles.length === 0 ? "none" : sameSeries.length >= minComparable ? "series" : "all";
  const comparable: ReleaseProfile[] = basis === "series" ? sameSeries : profiles;

  const targets = (
    input.targetMachineIds
      ? [...new Set(input.targetMachineIds)]
      : input.machines.filter((m) => isMachineActive(m, release.releaseDate)).map((m) => m.id)
  ).sort(compareStrings);

  const pooled = comparable.flatMap((p) => p.machines.map((m) => m.units));
  const typical = median(pooled);
  const curve = releaseCurve(comparable, H, input.titles ?? []);

  if (comparable.length === 0 || typical === null) {
    const text = `${name}: inget tidigare släpp har ${H} dagars försäljning att jämföra med, så inget förslag kan räknas fram. Lägg in mängden för hand.`;
    return {
      titleId: release.titleId,
      releaseDate: release.releaseDate,
      status: "no-history",
      horizonDays: H,
      basis: "none",
      comparableTitleIds: comparable.map((p) => p.titleId),
      curve: null,
      typicalUnitsPerMachineTenths: null,
      scaleBp,
      allocations: [],
      machineUnits: 0,
      onHandUnits,
      purchaseUnits: 0,
      boxSize,
      boxes: 0,
      warehouseUnits: onHandUnits,
      weeklyUnits: [],
      text,
      evidence: marketEvidence({
        rule: `Förslaget kräver minst ett tidigare släpp med ${H} dagars försäljning.`,
        titleIds: [release.titleId],
        dates: [release.releaseDate],
        machineIds: targets,
      }),
    };
  }

  const scale = new Ratio(scaleBp, 10_000);
  const expected = targets.map((machineId) => {
    const history = comparable
      .map((p) => p.machines.find((m) => m.machineId === machineId))
      .filter((m): m is { machineId: string; units: number } => m !== undefined)
      .map((m) => m.units);
    const m = median(history);
    return {
      machineId,
      history,
      source: (m === null ? "typical" : "history") as ReleaseAllocation["source"],
      value: (m ?? typical).mul(scale),
    };
  });
  const totalExpected = expected.reduce((s, e) => s.add(e.value), new Ratio(0));
  const machineUnits = ceilRatio(totalExpected);
  const units =
    machineUnits === 0
      ? expected.map(() => 0)
      : allocateLargestRemainder(
          machineUnits,
          expected.map((e) => e.value.mul(1000).round()),
        );

  const need = Math.max(machineUnits - onHandUnits, 0);
  let purchaseUnits = need === 0 ? 0 : Math.max(need, minOrderQty);
  purchaseUnits = ceilDiv(purchaseUnits, boxSize) * boxSize;
  const boxes = ceilDiv(purchaseUnits, boxSize);
  const warehouseUnits = onHandUnits + purchaseUnits - machineUnits;

  const weeklyUnits =
    curve && machineUnits > 0 ? allocateLargestRemainder(machineUnits, [...curve.weeklyBp]) : [];

  const allocations: ReleaseAllocation[] = expected.map((e, i) => {
    const u = units[i]!;
    const basisText =
      e.source === "history"
        ? `median av ${plural(e.history.length, "släpp", "släpp")}: ${e.history.join(", ")} pack`
        : `ingen egen släpphistorik, typisk automat ${tenthsText(tenthsOf(typical))} pack`;
    return {
      machineId: e.machineId,
      units: u,
      expectedTenths: tenthsOf(e.value),
      source: e.source,
      historyUnits: e.history,
      text: `${machineName(e.machineId)}: ${plural(u, "pack", "pack")} (${basisText}).`,
    };
  });

  const comparableNames = listText(comparable.map((p) => titleName(p.titleId)));
  const parts = [
    `Förslag för ${name} (${day(release.releaseDate)}): köp ${plural(purchaseUnits, "pack", "pack")}${boxSize > 1 ? ` (${plural(boxes, "låda", "lådor")} à ${boxSize})` : ""} och lägg ${machineUnits} i ${plural(targets.length, "automat", "automater")}${warehouseUnits > 0 ? `; ${warehouseUnits} blir kvar i lagret` : ""}.`,
    `Underlag: ${plural(comparable.length, "tidigare släpp", "tidigare släpp")}${basis === "series" ? " i samma serie" : ""} (${comparableNames}) sålde i median ${tenthsText(tenthsOf(typical))} pack per automat de första ${H} dagarna.`,
  ];
  if (curve) parts.push(`${pct(curve.weeklyBp[0]!)} brukar säljas första veckan.`);
  if (scaleBp !== 10_000)
    parts.push(`Antagande: släppet blir ${pct(scaleBp)} av ett vanligt släpp.`);
  if (onHandUnits > 0) parts.push(`${onHandUnits} pack finns redan i lager.`);

  return {
    titleId: release.titleId,
    releaseDate: release.releaseDate,
    status: "ok",
    horizonDays: H,
    basis,
    comparableTitleIds: comparable.map((p) => p.titleId),
    curve,
    typicalUnitsPerMachineTenths: tenthsOf(typical),
    scaleBp,
    allocations,
    machineUnits,
    onHandUnits,
    purchaseUnits,
    boxSize,
    boxes,
    warehouseUnits,
    weeklyUnits,
    text: parts.join(" "),
    evidence: marketEvidence({
      rule: `Förväntan per automat = median av automatens försäljning de första ${H} dagarna i jämförda släpp (typisk automat om historik saknas) × antagande; fördelning med största-restmetoden; inköp avrundat uppåt till hela lådor.`,
      orderIds: comparable.flatMap((p) => p.orderIds),
      dates: [release.releaseDate, ...comparable.map((p) => p.launchDate)],
      titleIds: [release.titleId, ...comparable.map((p) => p.titleId)],
      machineIds: targets,
      figures: [
        fig("comparableReleases", "Jämförda släpp", comparable.length, "count"),
        fig("typicalUnitsPerMachine", "Typisk automat", tenthsOf(typical), "tenths"),
        fig("scaleBp", "Antagande om storlek", scaleBp, "bp"),
        fig("machineUnits", "Pack till automaterna", machineUnits, "packs"),
        fig("onHandUnits", "Pack i lager", onHandUnits, "packs"),
        fig("purchaseUnits", "Pack att köpa", purchaseUnits, "packs"),
        fig("horizonDays", "Horisont", H, "days"),
      ],
    }),
  };
}
