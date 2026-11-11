/**
 * Samma besked på Vårt lager och Inköp: vad som ska göras med en titel, i vilken ordning,
 * och varför. Båda sidornas vymodeller anropar funktionerna här, så att de inte kan säga
 * olika saker om samma titel. Ren och klientsäker.
 *
 * - Mystery packs skrivs alltid i hela omgångar ("Packa 2 omgångar"), med antalet från
 *   mysteryBatchesToPack() i @/domain (samma tal som Mystery-sidorna).
 * - En titel under 0 hemma ska räknas om först: "1. Räkna om. 2. Packa 2 omgångar."
 * - Raden under titeln: "0 hemma · 9 i automaten · slut om 3 dagar".
 * - Den grå raden i rubriken säger varför något ska packas: "Mystery Pack är slut hemma."
 */

import { mysteryShare } from "@/analytics/purchasing/mystery-components";
import { mysteryBatchesToPack } from "@/domain";
import { formatInt, MINUS, NBSP } from "@/lib/format";

/** Det som ska packas eller beställas för en titel. */
export interface NeedAction {
  readonly kind: "pack" | "order";
  /** Talet på kortet: omgångar för mystery packs, annars pack. null = antalet är okänt. */
  readonly qty: number | null;
  /** Enheten efter talet: "st", "omgång" eller "omgångar". */
  readonly unit: string;
  /** Samma sak i pack (för länken till Mystery packs). null = okänt. */
  readonly packs: number | null;
  /** Hela omgångar för ett mystery pack, annars null. */
  readonly batches: number | null;
  /** "Packa 2 omgångar" · "Packa 11 st" · "Beställ 36 st" · "Packa" (utan antal). */
  readonly text: string;
  /**
   * Mystery pack med ett minus i hela omgångar hemma: lagret där allt packas (omgångarna som
   * rättar minuset ingår i antalet). Raden säger då "Packa", inte "Räkna om". Annars null.
   */
  readonly placeId: string | null;
}

/**
 * Ska titeln räknas om först? Under 0 hemma, utom när minuset är hela omgångar av ett
 * mystery pack som en packning rättar (`fixPlaceId`): då är beskedet "Packa N omgångar",
 * samma som på Mystery-sidan.
 */
export function countFirst(home: number, fixPlaceId: string | null | undefined): boolean {
  return home < 0 && !fixPlaceId;
}

const batchUnit = (n: number) => (n === 1 ? "omgång" : "omgångar");

/**
 * Vad som ska göras för att fylla på en titel hemma. `needQty` är Inköps antal i pack
 * (purchaseQty); null = planen kunde inte räknas, 0 = inget behövs (då null här).
 */
export function needAction(x: {
  readonly own: boolean;
  readonly needQty: number | null;
  readonly mysteryBatchSize?: number | null;
  /** Färdiga pack hemma (alla lager). */
  readonly home?: number | null;
  /** PurchaseLine.packNow.fixPlaceId: lagret där minuset rättas med en packning. */
  readonly fixPlaceId?: string | null;
}): NeedAction | null {
  const placeId = x.own ? (x.fixPlaceId ?? null) : null;
  const kind = x.own ? "pack" : "order";
  const verb = x.own ? "Packa" : "Beställ";
  if (x.needQty === null) {
    return { kind, qty: null, unit: "st", packs: null, batches: null, text: verb, placeId };
  }
  if (x.needQty <= 0) return null;
  const plan = x.own
    ? mysteryBatchesToPack({
        batchSize: x.mysteryBatchSize,
        planPacks: x.needQty,
        packedAtHome: x.home ?? null,
      })
    : null;
  if (plan && plan.batches > 0) {
    return {
      kind,
      qty: plan.batches,
      unit: batchUnit(plan.batches),
      packs: plan.packs,
      batches: plan.batches,
      text: `${verb} ${formatInt(plan.batches)} ${batchUnit(plan.batches)}`,
      placeId,
    };
  }
  return {
    kind,
    qty: x.needQty,
    unit: "st",
    packs: x.needQty,
    batches: null,
    text: `${verb} ${formatInt(x.needQty)}${NBSP}st`,
    placeId,
  };
}

/**
 * Båda stegen för en titel under 0 som också behöver fyllas på:
 * "1. Räkna om. 2. Packa 2 omgångar." Annars null (ett steg behöver ingen lista).
 */
export function stepsText(negative: boolean, action: NeedAction | null): string | null {
  if (!negative || !action) return null;
  return `1. Räkna om. 2. ${action.text}.`;
}

/** "slut nu" · "slut i dag" · "slut om 3 dagar". null = ingen takt att räkna på. */
export function runsOutText(x: {
  readonly home: number;
  readonly inMachines: number;
  /** Hela dagar tills hemma + automaterna är sålt (lastsDays), eller null. */
  readonly lastsDays: number | null;
}): string | null {
  if (Math.max(0, x.home) + Math.max(0, x.inMachines) <= 0) return "slut nu";
  if (x.lastsDays === null) return null;
  if (x.lastsDays <= 0) return "slut i dag";
  return `slut om ${formatInt(x.lastsDays)}${NBSP}${x.lastsDays === 1 ? "dag" : "dagar"}`;
}

/**
 * Raden under titeln: "0 hemma · 9 i automaten · slut om 3 dagar". Ett saldo under 0 visas
 * som det är ("−1 hemma"), så att det syns varför titeln ska räknas om.
 */
export function factLine(x: {
  readonly home: number;
  readonly inMachines: number;
  readonly lastsDays: number | null;
  /** Antal automater (1 = "i automaten", annars "i automaterna"). */
  readonly machineCount?: number;
}): string {
  const home = x.home < 0 ? `${MINUS}${formatInt(-x.home)}` : formatInt(x.home);
  const where = x.machineCount === 1 ? "i automaten" : "i automaterna";
  const parts = [`${home}${NBSP}hemma`, `${formatInt(Math.max(0, x.inMachines))}${NBSP}${where}`];
  const out = runsOutText(x);
  if (out) parts.push(out);
  return parts.join(" · ");
}

/** Hur många av packen som köps som går till mystery packs (delar i innehållet). */
export interface ToMystery {
  /** Pack som går dit (högst det som köps). */
  readonly packs: number;
  /** Allt som köps går dit. */
  readonly all: boolean;
  /** Mystery-packets namn, eller null när delen går till flera olika. */
  readonly into: string | null;
  /** "16 av dem går till Mystery Pack." · "Alla går till Mystery Pack." */
  readonly text: string;
}

/**
 * "16 av dem går till Mystery Pack.": delen av ett inköp som mystery packen äter upp.
 * `need` är planens extra behov för titeln (PurchaseLine.mysteryNeed). null när inget köps
 * eller inget går dit. Samma regel på Vårt lager, Inköp och delägarens inköpslista.
 */
export function toMystery(
  buyQty: number | null,
  need:
    | { readonly packs: number; readonly parts: readonly { readonly titleId: string }[] }
    | null
    | undefined,
  nameOf: (titleId: string) => string,
): ToMystery | null {
  if (!need || buyQty === null) return null;
  const packs = mysteryShare(buyQty, need.packs);
  if (packs <= 0) return null;
  const into = need.parts.length === 1 ? nameOf(need.parts[0]!.titleId) : null;
  const all = packs >= buyQty;
  const where = into ?? "mystery packs";
  return {
    packs,
    all,
    into,
    text: all ? `Alla går till ${where}.` : `${formatInt(packs)} av dem går till ${where}.`,
  };
}

const titles = (n: number) => `${formatInt(n)}${NBSP}${n === 1 ? "titel" : "titlar"}`;

/**
 * Varför något ska packas, till den grå raden i rubriken: "Mystery Pack är slut hemma." ·
 * "Mystery Pack tar slut om 3 dagar." · "2 titlar är slut hemma." Tom lista: null.
 */
export function whyPackText(
  lines: readonly {
    readonly title: string;
    readonly home: number;
    readonly lastsDays?: number | null;
  }[],
): string | null {
  if (lines.length === 0) return null;
  const out = lines.filter((l) => l.home <= 0).length;
  if (lines.length === 1) {
    const l = lines[0]!;
    if (out === 1) return `${l.title} är slut hemma.`;
    const days = l.lastsDays ?? null;
    if (days === null) return `${l.title} tar snart slut.`;
    if (days <= 0) return `${l.title} tar slut i dag.`;
    return `${l.title} tar slut om ${formatInt(days)}${NBSP}${days === 1 ? "dag" : "dagar"}.`;
  }
  if (out === lines.length) return `${titles(out)} är slut hemma.`;
  if (out === 0) return `${titles(lines.length)} tar snart slut.`;
  return `${titles(out)} är slut hemma, ${formatInt(lines.length - out)} tar snart slut.`;
}
