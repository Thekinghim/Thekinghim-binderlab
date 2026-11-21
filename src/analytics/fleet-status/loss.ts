/**
 * "Kräver åtgärd": ungefär hur mycket vinst per dag som går förlorad tills någon gör något
 * (V2, docs/design/v2/byggplan.md avsnitt 3.6; reglerna står i docs/berakningar.md). Ren
 * funktion, öre. Raderna på Hem sorteras på talet (störst först); påfyllaren får samma
 * ordning men aldrig talet (servern skickar det inte).
 *
 *   offline      automatens vinst per aktiv dag (rangordningen, 30 d)
 *   tom/fack     Σ över titlar som är slut i automaten: takten före × vinst per pack.
 *                Vinst per pack = automatens vinst per dag ÷ sålda pack per dag (samma
 *                rangordning, efter inköp och kortavgift) när titelns egen saknas.
 *                Är automaten helt tom: hela vinsten per dag.
 *   tom inom 1 d hälften av automatens vinst per dag (prototypens regel)
 *   startklar    medianens vinst per dag ("en vanlig automat")
 *   pris         (vinst per pack vid föreslaget pris − nu) × pack per dag (prisrådet)
 *   ström av     0 (säljer inte enligt schemat, inget att göra)
 *
 * Gäller flera regler tas den största. Med "Visa butikernas andel" multipliceras talet med
 * den del vi behåller (`keepBp`), som på övriga sidor. Okänt (ingen vinstdata) = null.
 */

import type { FleetStatus } from "./status";

/** Raden visar "tappar ca X kr vinst/dag" först från så här mycket (5 kr). */
export const LOSS_SHOW_MIN_ORE = 500;

/** En titel som är slut i automaten nu. */
export interface EmptyTitleLoss {
  /** Takten före (tusendelar pack per dag). */
  readonly unitsPerDayMilli: number;
  /** Titelns vinst per pack (öre). null = okänd, då används automatens snitt. */
  readonly profitPerPackOre?: number | null;
}

export interface LossInput {
  readonly status: FleetStatus;
  /** Automatens vinst per aktiv dag (öre). null = okänd (ny, eller ingen ekonomi). */
  readonly profitPerDayOre: number | null;
  /** Automatens sålda pack per dag (tusendelar). */
  readonly unitsPerDayMilli: number;
  /** Medianens vinst per dag (öre), för startklara automater. */
  readonly medianProfitPerDayOre: number | null;
  /** Titlar som är slut nu (tomma fack). */
  readonly emptyTitles?: readonly EmptyTitleLoss[];
  /** Hela dagar till tom. */
  readonly daysLeft: number | null;
  /** Andel vi behåller efter butikernas andel (bp). Utelämnad = 10 000 (före andelen). */
  readonly keepBp?: number;
}

const clampLoss = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Vinst per pack ur automatens snitt (öre), eller null. */
export function profitPerPackOre(
  profitPerDayOre: number | null,
  unitsPerDayMilli: number,
): number | null {
  if (profitPerDayOre === null || !(unitsPerDayMilli > 0)) return null;
  return Math.round((profitPerDayOre * 1_000) / unitsPerDayMilli);
}

/** Förlorad vinst per dag (öre), eller null när den inte går att räkna. */
export function lossProfitPerDayOre(input: LossInput): number | null {
  const keep = input.keepBp ?? 10_000;
  const scale = (v: number | null) => (v === null ? null : clampLoss((v * keep) / 10_000));
  const perDay = input.profitPerDayOre;
  switch (input.status) {
    case "strom-av":
      return 0;
    case "offline":
      return scale(perDay);
    case "startklar":
      return scale(input.medianProfitPerDayOre);
    case "tom":
      return scale(perDay);
    default: {
      if (perDay === null) return null;
      const avgPack = profitPerPackOre(perDay, input.unitsPerDayMilli);
      let empty = 0;
      for (const t of input.emptyTitles ?? []) {
        const per = t.profitPerPackOre ?? avgPack;
        if (per === null) continue;
        empty += (t.unitsPerDayMilli * per) / 1_000;
      }
      const soon = input.daysLeft !== null && input.daysLeft <= 1 ? perDay / 2 : 0;
      // Aldrig mer än hela automatens vinst per dag.
      return scale(Math.min(Math.max(empty, soon), Math.max(perDay, 0)));
    }
  }
}

/** Ett prisråd som går med förlust: vad ett höjt pris ger per dag (öre). */
export function priceLossPerDayOre(args: {
  readonly profitPerPackNowOre: number;
  readonly profitPerPackSuggestedOre: number;
  readonly unitsPerDayMilli: number;
  readonly keepBp?: number;
}): number {
  const diff = args.profitPerPackSuggestedOre - args.profitPerPackNowOre;
  return clampLoss(((diff * args.unitsPerDayMilli) / 1_000) * ((args.keepBp ?? 10_000) / 10_000));
}

/**
 * Ordningen i Kräver åtgärd: störst förlust först, sedan kortast tid till tom, sedan kod.
 * Okänd förlust (null) räknas som 0.
 */
export function compareByLoss(
  a: { readonly lossOre: number | null; readonly daysLeft: number | null; readonly code: string },
  b: { readonly lossOre: number | null; readonly daysLeft: number | null; readonly code: string },
): number {
  return (
    (b.lossOre ?? 0) - (a.lossOre ?? 0) ||
    (a.daysLeft ?? 9_999) - (b.daysLeft ?? 9_999) ||
    a.code.localeCompare(b.code, "sv")
  );
}

/** Visas talet på raden? (från LOSS_SHOW_MIN_ORE) */
export function showsLoss(lossOre: number | null | undefined): lossOre is number {
  return typeof lossOre === "number" && lossOre >= LOSS_SHOW_MIN_ORE;
}
