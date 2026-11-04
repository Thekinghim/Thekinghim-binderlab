/**
 * Rubriken på Lönsamhet: svaret på "Vad tjänar vi, och var?" i två delar.
 *
 *   "Vår vinst 12 480 kr på 30 dagar." + "Automat 1: nästan hälften av vinsten."
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
  /** Perioden i löptext ("2 nov.", "13 okt. – 1 nov."), för tomt läge. */
  readonly periodLabel?: string;
  /** Senaste orderns datum i löptext ("1 nov."), för tomt läge. null utan order alls. */
  readonly lastOrderLabel?: string | null;
  /** Filtret i löptext ("BL-001 Automat 1"), eller null utan filter. */
  readonly scopeLabel?: string | null;
  readonly orders: number;
  readonly pricedOrders: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  /** Intäkt för prissatta order. */
  readonly revenueOre: number;
  readonly costOre: number;
  readonly feesOre: number;
  /** VMB-moms (0 utan VMB). Standard 0. */
  readonly vmbVatOre?: number;
  readonly compensationOre: number;
  /**
   * Butikernas andel visas som eget tal. Av: förlustfallet nämner den inte för sig (den
   * räknas då in i avgifterna, som i vattenfallet). Standard på.
   */
  readonly showStoreShare?: boolean;
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
  const share = input.showStoreShare ?? true;
  const items: Array<[string, number]> = [
    ...(share ? ([["Butikernas andel", input.compensationOre]] as Array<[string, number]>) : []),
    ["Inköpen", input.costOre],
    // Utan vyknappen ligger butikernas andel i samma steg som avgifterna (vattenfallet).
    [
      share ? "Avgifterna" : "Avgifterna och butikerna",
      input.feesOre + (share ? 0 : input.compensationOre),
    ],
    ["VMB-momsen", input.vmbVatOre ?? 0],
  ];
  items.sort((a, b) => b[1] - a[1]);
  const [label, value] = items[0] ?? ["Inköpen", 0];
  const part = ratioBp(value, input.revenueOre);
  if (part === null || input.revenueOre < 0) {
    return `${label} var ${sek(value)} utan intäkt med inköpspris.`;
  }
  return `${label} tog ${formatPercent(part / 10_000)} av intäkten.`;
}

export function lonsamhetHeadline(input: HeadlineInput): Headline {
  if (input.orders === 0) {
    return {
      kind: "empty",
      title: input.periodLabel
        ? sentence(`Inga order ${input.days === 1 ? "" : "under "}${input.periodLabel}`)
        : "Inga order i perioden.",
      aside: input.lastOrderLabel
        ? sentence(`Senaste ordern kom ${input.lastOrderLabel}`)
        : input.scopeLabel
          ? sentence(`Inga order för ${input.scopeLabel} ännu`)
          : "Inga order har importerats ännu.",
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

  // Stor siffra först: vår vinst (efter butikernas andel), samma ord och tal som på Hem.
  // Marginalen står i nyckeltalen under.
  const title = `Vår vinst ${sek(input.profitOre)} på ${days(input.days)}.`;

  let aside: string;
  const share = input.top?.shareOfProfitBp ?? null;
  if (input.top && share !== null) {
    aside = `${input.top.name}: ${shareOfProfitText(share)}.`;
  } else if (input.previous && input.previous.profitOre > 0) {
    const bp = changeBp(input.profitOre, input.previous.profitOre) ?? 0;
    aside = `${bp >= 0 ? "Upp" : "Ned"} ${formatPercent(Math.abs(bp) / 10_000, 0)} mot perioden innan.`;
  } else {
    aside = input.marginBp === null ? "" : `Marginal ${formatPercent(input.marginBp / 10_000)}.`;
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

/** "Automat 1 gav mest vinst." + "12 480 kr · 31,4 %. 1 automat med förlust." */
export function viewTitle(input: ViewTitleInput): SectionTitle {
  if (input.items === 0 || input.top === null) {
    return {
      title: `Ingen ${input.noun} med försäljning.`,
      aside: "",
    };
  }
  const margin =
    input.top.marginBp === null ? "" : ` · ${formatPercent(input.top.marginBp / 10_000)}`;
  // Bara det som kräver åtgärd: rader med förlust.
  const lossText =
    input.losses === 0
      ? ""
      : ` ${input.losses} ${input.losses === 1 ? input.noun : input.plural} med förlust.`;
  if (input.top.profitOre <= 0) {
    return {
      title: `Ingen ${input.noun} gick med vinst.`,
      aside: `Bäst: ${input.top.name}, ${sek(input.top.profitOre)}.`,
    };
  }
  return {
    title: `${input.top.name} gav mest vinst.`,
    aside: `${sek(input.top.profitOre)}${margin}.${lossText}`,
  };
}

export interface TrendTitleInput {
  readonly unit: "dag" | "vecka" | "månad";
  /** Antal dagar/veckor/månader med order. */
  readonly buckets: number;
  /** Bästa dagen/veckan/månaden: namn ("vecka 43") och vinst. */
  readonly best: { readonly name: string; readonly profitOre: number } | null;
  /** Den senaste hela veckan/månaden med order, när den inte är den bästa. */
  readonly latestFull: { readonly profitOre: number } | null;
  /** Dagar/veckor/månader med förlust. */
  readonly losses: number;
}

const DEFINITE: Record<TrendTitleInput["unit"], string> = {
  dag: "dagen",
  vecka: "veckan",
  månad: "månaden",
};
const PLURAL: Record<TrendTitleInput["unit"], string> = {
  dag: "dagar",
  vecka: "veckor",
  månad: "månader",
};

/**
 * "Vinst per vecka." + "Bäst: vecka 43, 9 495 kr. Senaste hela veckan: 7 100 kr." Inget snitt: delvisa veckor och månader i periodens kanter gör det
 * missvisande.
 */
export function trendTitle(input: TrendTitleInput): SectionTitle {
  const title = `Vinst per ${input.unit}.`;
  if (input.buckets === 0 || input.best === null) {
    return { title, aside: "Ingen försäljning." };
  }
  const loss =
    input.losses > 0
      ? ` ${formatInt(input.losses)} ${input.losses === 1 ? input.unit : PLURAL[input.unit]} med förlust.`
      : "";
  if (input.buckets === 1) {
    return {
      title,
      aside: `${sek(input.best.profitOre)} på ${sentence(input.best.name)}${loss}`,
    };
  }
  const latest = input.latestFull
    ? ` Senaste hela ${DEFINITE[input.unit]}: ${sek(input.latestFull.profitOre)}.`
    : "";
  return {
    title,
    aside: `Bäst: ${input.best.name}, ${sek(input.best.profitOre)}.${latest}${loss}`,
  };
}
