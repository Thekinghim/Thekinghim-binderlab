/**
 * Hems rubrik: vår vinst som en stor siffra och en kort rad under. "Vinst" betyder samma
 * sak på alla sidor: vår vinst, efter butikernas andel (som Lönsamhet).
 *
 *   "Vår vinst 21 203 kr på 30 dagar." + "Intäkt 84 725 kr, +12 %."
 *   Med "Visa butikernas andel" eller vald butik, andra delen:
 *   "Totalt före butikernas andel 28 948 kr · butikernas andel 7 745 kr."
 *   Rad under: "Före fasta kostnader." (bara när det finns fasta kostnader)
 *
 * Ren funktion utan databas och utan React. Inga beräkningar av ekonomi: talen kommer från
 * keyMetrics/changeBp i @/domain; här väljs bara formuleringen.
 */

import { addDays, maxDate, periodDays, type IsoDate, type Period } from "@/domain";
import { MINUS, NBSP, formatInt, formatPercent, formatPeriodShort } from "@/lib/format";
import { dataCoverage } from "@/server/data/core/period";

import { dateOf, dayText, kr, sentence } from "./text";

/** Det stora talet i rubriken (räknas upp på sidan): "Vår vinst" + belopp + "på 30 dagar." */
export interface HomeHeadlineFigure {
  /** "Vår vinst", "Förlust" eller "Intäkt". */
  readonly label: string;
  /** Beloppet i öre (alltid ≥ 0; förlust står i `label`). */
  readonly valueOre: number;
  /** Resten av meningen: "på 30 dagar." */
  readonly tail: string;
  /** "good" = vinst, "bad" = förlust, "neutral" = intäkt utan vinst. */
  readonly tone: "good" | "bad" | "neutral";
}

/** En del av delningsraden ("Totalt före butikernas andel 28 948 kr"), räknas upp på sidan. */
export interface HomeHeadlineSplitPart {
  readonly label: string;
  readonly valueOre: number;
}

/** Rubriken i två delar (första i fg, andra i grått) och en kort rad under. */
export interface HomeHeadline {
  /** Hela rubriken som text (skärmläsare, tester): "Vår vinst 21 203 kr på 30 dagar." */
  readonly title: string;
  /** Andra delen: delningen (bara med butikernas andel), annars intäkten. */
  readonly aside: string;
  /** En kort rad som hindrar misstag ("Före fasta kostnader."). Kan vara tom. */
  readonly lead: string[];
  /** Läget: avgör vad sidan visar under rubriken. */
  readonly state: "no-data" | "no-orders" | "ok";
  /** Det stora talet, null utan order. */
  readonly figure: HomeHeadlineFigure | null;
  /**
   * Totalt före butikernas andel och andelen: bara med vyknappen "Visa butikernas andel"
   * eller vald butik, och när butikerna har en andel. Annars tom.
   */
  readonly split: HomeHeadlineSplitPart[];
}

export interface HomeHeadlineInput {
  /** Nettointäkt i perioden, alla order (öre). */
  readonly revenueOre: number;
  readonly orders: number;
  /** Order med inköpspris (de som ingår i vinsten). */
  readonly pricedOrders: number;
  /**
   * Vår vinst för order med inköpspris (öre): efter inköp och kortavgifter (och VMB-moms med
   * vyknappen "Med VMB"), FÖRE butikernas andel; med `showStoreShare` efter andelen (vår
   * del). Samma tal som Lönsamhet.
   */
  readonly profitOre: number;
  /** Butikernas andel (öre), eller null/utelämnad när butikerna inte har någon andel. */
  readonly storesProfitOre?: number | null;
  /** Vald butik: andelen heter "butikens andel" (och dras alltid). */
  readonly filtered?: boolean;
  /**
   * Butikernas andel är dragen från `profitOre` (vyknappen "Visa butikernas andel" eller
   * vald butik). Standard av.
   */
  readonly showStoreShare?: boolean;
  /** Etiketten för andelen ("Butikernas andel", "Sega gubben 50 % av vinsten"). */
  readonly storeShareLabel?: string;
  readonly marginBp: number | null;
  /** Andel av intäkten som saknar inköpspris, i bp. */
  readonly unpricedShareBp: number;
  /** Intäktens förändring mot jämförelseperioden i bp, null utan jämförbar period. */
  readonly revenueChangeBp: number | null;
  /** Perioden i skalet (vinsten gäller hela den). */
  readonly period: Period;
  readonly today: IsoDate;
  readonly dataStart: IsoDate | null;
  /** Om det finns order i dag (dagen räknas då med, som på övriga sidor). */
  readonly hasOrdersToday?: boolean;
  /**
   * Organisationen har fasta kostnader: raden "Före fasta kostnader." visas. Standard sant.
   * Utan fasta kostnader är vinsten redan allt som blir kvar.
   */
  readonly fixedCosts?: boolean;
}

/** Förändring i bp som "+12 %" / "−4,2 %" (en decimal under 10 %). */
function changeText(bp: number): string {
  const share = Math.abs(bp) / 10_000;
  const sign = bp > 0 ? "+" : bp < 0 ? MINUS : "±";
  return `${sign}${formatPercent(share, share < 0.1 ? 1 : 0)}`;
}

/** Från den andel utan inköpspris raden under rubriken säger det (20 %). */
export const UNPRICED_HEADLINE_BP = 2_000;

/**
 * Perioden som Hems tal och texter gäller, i ord: samma för rubriken, slutsålt och topplistan
 * (utvärderingen: "sedan 14 okt." bredvid "6 okt. – 3 nov." såg ut som olika perioder).
 */
export function homeSpanText(
  period: Period,
  dataStart: IsoDate,
  today: IsoDate,
  hasOrdersToday: boolean,
): string {
  return spanText(period, dataStart, today, hasOrdersToday);
}

/**
 * Hur länge talet gäller: "på 30 dagar", "i dag", "i går", "den 31 okt.", och när datan
 * börjar inne i perioden "sedan 13 okt." (eller "13–19 okt." för en period som slutat).
 */
function spanText(
  period: Period,
  dataStart: IsoDate,
  today: IsoDate,
  hasOrdersToday: boolean,
): string {
  const start = maxDate(period.start, dataStart);
  const yesterday = addDays(today, -1);
  if (start > period.start && start < period.end) {
    if (period.end >= yesterday) return `sedan ${dayText(start, today)}`;
    return formatPeriodShort({ start: dateOf(start), end: dateOf(period.end) }, dateOf(today));
  }
  // Samma dagräkning som övriga sidor (dataCoverage): i dag räknas bara med order i dag.
  const covered = dataCoverage(period, dataStart, today, hasOrdersToday);
  const days = covered ? periodDays(covered) : periodDays({ start, end: period.end });
  if (days > 1) return `på ${formatInt(days)}${NBSP}dagar`;
  if (start === today) return "i dag";
  if (start === yesterday) return "i går";
  return `den ${dayText(start, today)}`;
}

/**
 * Delningen, bara på begäran: "Totalt före butikernas andel" + "butikernas andel" (med
 * filter "butikens"). Tom utan vyknappen och filter, och när butikerna inte har någon andel.
 */
function splitParts(input: HomeHeadlineInput): HomeHeadlineSplitPart[] {
  const stores = input.storesProfitOre ?? null;
  if (stores === null || input.pricedOrders === 0) return [];
  if (!input.showStoreShare) return [];
  const who = input.filtered ? "butikens" : "butikernas";
  return [
    { label: `Totalt före ${who} andel`, valueOre: input.profitOre + stores },
    { label: input.storeShareLabel ?? `${who} andel`, valueOre: stores },
  ];
}

/**
 * Rubriken för Hem: vår vinst som det stora talet, intäkten (eller på begäran delningen)
 * som andra del och en kort rad som hindrar misstag (före fasta kostnader; stor del utan
 * inköpspris).
 *
 *   "Vår vinst 2 070 kr på 10 dagar." + "Intäkt 4 450 kr, +23 %."
 *   Med andelen: + "Totalt före butikernas andel 4 140 kr · butikernas andel 2 070 kr."
 *   Utan inköpspris: "Intäkt 4 450 kr på 10 dagar." + "Lägg in inköpspris för vinsten."
 */
export function homeHeadline(input: HomeHeadlineInput): HomeHeadline {
  const { today, dataStart, revenueChangeBp } = input;

  if (dataStart === null) {
    return {
      title: "Inga order än.",
      aside: "Vinsten syns här efter första köpet.",
      lead: [],
      state: "no-data",
      figure: null,
      split: [],
    };
  }

  if (input.orders === 0) {
    const before = input.period.end < dataStart;
    const when =
      input.period.start === input.period.end && input.period.start === today
        ? "i dag"
        : "i perioden";
    return {
      title: `Inga order ${when}.`,
      aside: before ? sentence(`Första ordern kom ${dayText(dataStart, today)}`) : "",
      lead: [],
      state: "no-orders",
      figure: null,
      split: [],
    };
  }

  const span = sentence(spanText(input.period, dataStart, today, input.hasOrdersToday ?? false));
  const priced = input.pricedOrders > 0;
  const loss = priced && input.profitOre < 0;
  const figure: HomeHeadlineFigure = priced
    ? {
        label: loss ? "Förlust" : input.showStoreShare ? "Vår del" : "Vår vinst",
        valueOre: Math.abs(input.profitOre),
        tail: span,
        tone: loss ? "bad" : "good",
      }
    : { label: "Intäkt", valueOre: input.revenueOre, tail: span, tone: "neutral" };
  const title = `${figure.label} ${kr(figure.valueOre)} ${figure.tail}`;

  const split = splitParts(input);
  const change = revenueChangeBp === null ? "" : `, ${changeText(revenueChangeBp)}`;
  const aside = !priced
    ? "Lägg in inköpspris för vinsten."
    : split.length > 0
      ? sentence(split.map((p) => `${p.label} ${kr(p.valueOre)}`).join(" · "))
      : `Intäkt ${kr(input.revenueOre)}${change}.`;

  const lead: string[] = [];
  if (priced) {
    // Utan vyknappen är vinsten före butikernas andel: säg det när butikerna har en andel.
    const beforeShare = !input.showStoreShare && (input.storesProfitOre ?? 0) !== 0;
    const before = [
      beforeShare ? "butikernas andel" : "",
      input.fixedCosts === false ? "" : "fasta kostnader",
    ]
      .filter(Boolean)
      .join(" och ");
    const parts = [
      before ? `Innan ${before} dras av.` : "",
      input.unpricedShareBp >= UNPRICED_HEADLINE_BP
        ? `${formatPercent(input.unpricedShareBp / 10_000, 1)} saknar inköpspris.`
        : "",
    ].filter(Boolean);
    if (parts.length > 0) lead.push(parts.join(" "));
  }

  return { title, aside, lead, state: "ok", figure, split };
}
