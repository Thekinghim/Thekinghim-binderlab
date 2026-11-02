/**
 * Rubriken på Lönsamhet: svaret på "Vad tjänar vi, och var?" i två delar.
 *
 *   "Ni behöll 31,4 % av intäkten." + "Automat 1 står för nästan hälften av vinsten."
 *
 * Ren funktion. Alla tal kommer färdigräknade från beräkningslagret (marginal,
 * största bidragsgivare och dess andel); här väljs bara vilket påstående som är sant
 * och hur det skrivs.
 */

import { changeBp, ratioBp } from "@/domain";
import { formatInt, formatPercent, formatSek, NBSP } from "@/lib/format";

export interface Headline {
  /** Första, ljusa delen. */
  readonly title: string;
  /** Andra, grå delen: ett faktum med siffra. */
  readonly aside: string;
  /** Vilket fall som gällde (för test och för sidans tonläge). */
  readonly kind: "empty" | "no-prices" | "loss" | "profit";
}

export interface HeadlineInput {
  /** Antal dagar i perioden. */
  readonly days: number;
  readonly orders: number;
  readonly pricedOrders: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  /** Intäkt för prissatta order. */
  readonly revenueOre: number;
  readonly costOre: number;
  readonly feesOre: number;
  readonly compensationOre: number;
  /** Andel av intäkten som saknar inköpspris, bp. */
  readonly unpricedShareBp: number;
  /** Största bidragsgivaren (topContributor) med namn. */
  readonly top: {
    readonly name: string;
    readonly profitOre: number;
    readonly shareOfProfitBp: number | null;
  } | null;
  readonly previous: { readonly profitOre: number; readonly marginBp: number | null } | null;
}

/** Bråk som läses bättre än procent. Andel i bp. */
const FRACTIONS: ReadonlyArray<readonly [number, string]> = [
  [2_500, "en fjärdedel"],
  [3_333, "en tredjedel"],
  [5_000, "hälften"],
  [6_667, "två tredjedelar"],
  [7_500, "tre fjärdedelar"],
];

/** Inom ±1,5 p.e. skrivs bråket rakt av, inom 6 p.e. under "nästan", över "drygt". */
const EXACT_BP = 150;
const NEAR_BP = 600;

/**
 * Andel av vinsten i ord: "nästan hälften av vinsten", "drygt en tredjedel av vinsten",
 * "hela vinsten", "mer än hela vinsten", annars "41 % av vinsten".
 */
export function shareOfProfitText(shareBp: number): string {
  if (shareBp > 10_000) return "mer än hela vinsten";
  if (shareBp === 10_000) return "hela vinsten";
  if (shareBp >= 10_000 - NEAR_BP) return "nästan hela vinsten";

  let best: readonly [number, string] | null = null;
  for (const f of FRACTIONS) {
    if (best === null || Math.abs(shareBp - f[0]) < Math.abs(shareBp - best[0])) best = f;
  }
  if (best) {
    const [at, word] = best;
    const diff = shareBp - at;
    if (Math.abs(diff) <= EXACT_BP) return `${word} av vinsten`;
    if (diff < 0 && -diff <= NEAR_BP) return `nästan ${word} av vinsten`;
    if (diff > 0 && diff <= NEAR_BP) return `drygt ${word} av vinsten`;
  }
  return `${formatPercent(shareBp / 10_000, 0)} av vinsten`;
}

/** Avslutar en mening med punkt, utom när den redan slutar på en förkortning ("nov."). */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

function days(n: number): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? "dag" : "dagar"}`;
}

function sek(ore: number): string {
  return formatSek(ore / 100);
}

/** Den största kostnadsposten och dess andel av intäkten, för förlustfallet. */
function largestDeduction(input: HeadlineInput): string {
  const items: Array<[string, number]> = [
    ["Butiksersättningen", input.compensationOre],
    ["Inköpen", input.costOre],
    ["Avgifterna", input.feesOre],
  ];
  items.sort((a, b) => b[1] - a[1]);
  const [label, value] = items[0] ?? ["Butiksersättningen", 0];
  const share = ratioBp(value, input.revenueOre);
  if (share === null || input.revenueOre < 0) {
    return `${label} var ${sek(value)} utan intäkt med inköpspris.`;
  }
  return `${label} tog ${formatPercent(share / 10_000)} av intäkten.`;
}

export function lonsamhetHeadline(input: HeadlineInput): Headline {
  if (input.orders === 0) {
    return {
      kind: "empty",
      title: "Inga order i perioden.",
      aside: "Vinst och marginal räknas när perioden har försäljning.",
    };
  }

  if (input.pricedOrders === 0) {
    return {
      kind: "no-prices",
      title: "Vinsten går inte att räkna.",
      aside:
        input.orders === 1
          ? "Den enda ordern saknar inköpspris."
          : `Ingen av de ${input.orders}${NBSP}orderna har inköpspris.`,
    };
  }

  if (input.profitOre <= 0) {
    return {
      kind: "loss",
      title:
        input.profitOre === 0
          ? `Ingen vinst på ${days(input.days)}.`
          : `Förlust ${sek(-input.profitOre)} på ${days(input.days)}.`,
      aside: largestDeduction(input),
    };
  }

  const margin = input.marginBp === null ? null : formatPercent(input.marginBp / 10_000);
  const title = margin
    ? `Ni behöll ${margin} av intäkten${input.unpricedShareBp > 0 ? " med inköpspris" : ""}.`
    : `Vinst ${sek(input.profitOre)} på ${days(input.days)}.`;

  let aside: string;
  const share = input.top?.shareOfProfitBp ?? null;
  if (input.top && share !== null) {
    aside = `${input.top.name} står för ${shareOfProfitText(share)}.`;
  } else if (input.previous && input.previous.profitOre > 0) {
    const bp = changeBp(input.profitOre, input.previous.profitOre) ?? 0;
    aside = `Vinsten är ${formatPercent(Math.abs(bp) / 10_000, 0)} ${bp >= 0 ? "högre" : "lägre"} än perioden innan.`;
  } else {
    aside = `Vinst ${sek(input.profitOre)}.`;
  }

  return { kind: "profit", title, aside };
}

// ---------------------------------------------------------------------------
// Underrubriker
// ---------------------------------------------------------------------------

/** En sektionsrubrik i två delar. */
export interface SectionTitle {
  readonly title: string;
  readonly aside: string;
}

export interface ViewTitleInput {
  /** "titel", "automat", "butik". */
  readonly noun: string;
  /** Pluralform: "titlar", "automater", "butiker". */
  readonly plural: string;
  /** Bestämd form: "titeln", "automaten", "butiken". */
  readonly definite: string;
  /** Antal vanliga rader (utan ej fördelad hyra m.m.). */
  readonly items: number;
  /** Största bidragsgivaren i vyn. */
  readonly top: {
    readonly name: string;
    readonly profitOre: number;
    readonly marginBp: number | null;
  } | null;
  /** Antal rader med förlust (bland vanliga rader med inköpspris). */
  readonly losses: number;
}

/** "Automat 1 gav mest vinst." + "12 480 kr, 31,4 % marginal. 1 automat gick med förlust." */
export function viewTitle(input: ViewTitleInput): SectionTitle {
  if (input.items === 0 || input.top === null) {
    return {
      title: `Ingen ${input.noun} med försäljning.`,
      aside: "Inget att jämföra i perioden.",
    };
  }
  const margin =
    input.top.marginBp === null ? "" : `, ${formatPercent(input.top.marginBp / 10_000)} marginal`;
  const lossText =
    input.losses === 0
      ? input.items === 1
        ? ` Den enda ${input.definite} i urvalet.`
        : ` Ingen ${input.noun} gick med förlust.`
      : ` ${input.losses} ${input.losses === 1 ? input.noun : input.plural} gick med förlust.`;
  if (input.top.profitOre <= 0) {
    return {
      title: `Ingen ${input.noun} gick med vinst.`,
      aside: `Bäst var ${input.top.name} med ${sek(input.top.profitOre)}.`,
    };
  }
  return {
    title: `${input.top.name} gav mest vinst.`,
    aside: `${sek(input.top.profitOre)}${margin}.${lossText}`,
  };
}

export interface TrendTitleInput {
  /** "vecka" eller "månad". */
  readonly unit: string;
  /** Antal veckor/månader. */
  readonly buckets: number;
  /** Snittvinst per vecka/månad (öre). */
  readonly averageOre: number;
  /** Bästa veckan/månaden: namn ("vecka 43") och vinst. */
  readonly best: { readonly name: string; readonly profitOre: number } | null;
  /** Veckor/månader med förlust. */
  readonly losses: number;
}

/** "Vinst och marginal per vecka." + "Snitt 9 200 kr, bäst vecka 43 med 14 812 kr." */
export function trendTitle(input: TrendTitleInput): SectionTitle {
  const title = `Vinst och marginal per ${input.unit}.`;
  if (input.buckets === 0 || input.best === null) {
    return { title, aside: "Ingen försäljning i perioden." };
  }
  const loss = input.losses > 0 ? ` ${input.losses} med förlust.` : "";
  if (input.buckets === 1) {
    return { title, aside: `${sek(input.best.profitOre)} på en ${input.unit}.${loss}` };
  }
  return {
    title,
    aside: `Snitt ${sek(input.averageOre)}, bäst ${input.best.name} med ${sek(input.best.profitOre)}.${loss}`,
  };
}
