/**
 * Hems rubrik: läget i en mening, räknat ur nyckeltalen.
 *
 *   "79 987 kr på 30 dagar." + "12 % bättre än perioden innan."
 *   Ingress: "Vinst 18 950 kr före återbetalningar och fasta kostnader, 23,7 % marginal."
 *   Utan jämförelse: "79 987 kr sedan 13 okt." + "Vinst 21 205 kr före återbetalningar och fasta kostnader, …"
 *
 * Ren funktion utan databas och utan React. Inga beräkningar av ekonomi: talen kommer från
 * keyMetrics/changeBp i @/domain; här väljs bara formuleringen.
 */

import { addDays, maxDate, periodDays, type IsoDate, type Period } from "@/domain";
import { NBSP, formatInt, formatPercent, formatPeriodShort } from "@/lib/format";

import { dateOf, dayText, kr, marginText, sentence } from "./text";

/** Rubriken i två delar (första i fg, andra i grått) och en ingress med fler fakta. */
export interface HomeHeadline {
  readonly title: string;
  readonly aside: string;
  /** Meningar under rubriken (vinsten, när rubriken bär jämförelsen). Kan vara tom. */
  readonly lead: string[];
  /** Läget: avgör vad sidan visar under rubriken. */
  readonly state: "no-data" | "no-orders" | "ok";
}

export interface HomeHeadlineInput {
  /** Nettointäkt i perioden, alla order (öre). */
  readonly revenueOre: number;
  readonly orders: number;
  /** Order med inköpspris (de som ingår i vinsten). */
  readonly pricedOrders: number;
  /** Vinst för order med inköpspris (öre). */
  readonly profitOre: number;
  readonly marginBp: number | null;
  /** Andel av intäkten som saknar inköpspris, i bp. */
  readonly unpricedShareBp: number;
  /** Intäktens förändring mot jämförelseperioden i bp, null utan jämförbar period. */
  readonly revenueChangeBp: number | null;
  /** Perioden i skalet (vinsten gäller hela den). */
  readonly period: Period;
  readonly today: IsoDate;
  readonly dataStart: IsoDate | null;
}

/** Förändring i bp som "12 %" (utan tecken), en decimal under 10 %. */
function changeText(bp: number): string {
  const share = Math.abs(bp) / 10_000;
  return formatPercent(share, share < 0.1 ? 1 : 0);
}

/** Från den andel utan inköpspris rubriken säger det (20 %). */
export const UNPRICED_HEADLINE_BP = 2_000;

/**
 * Hur länge intäkten gäller: "på 30 dagar", "i dag", "i går", "den 31 okt.", och när datan
 * börjar inne i perioden "sedan 13 okt." (eller "13–19 okt." för en period som slutat).
 */
function spanText(period: Period, dataStart: IsoDate, today: IsoDate): string {
  const start = maxDate(period.start, dataStart);
  const yesterday = addDays(today, -1);
  if (start > period.start && start < period.end) {
    if (period.end >= yesterday) return `sedan ${dayText(start, today)}`;
    return formatPeriodShort({ start: dateOf(start), end: dateOf(period.end) }, dateOf(today));
  }
  const days = periodDays({ start, end: period.end });
  if (days > 1) return `på ${formatInt(days)}${NBSP}dagar`;
  if (start === today) return "i dag";
  if (start === yesterday) return "i går";
  return `den ${dayText(start, today)}`;
}

/** Vinsten i en mening; säger när den inte går att räkna eller när en stor del saknar pris. */
function profitSentence(input: HomeHeadlineInput): string {
  const { profitOre, marginBp, pricedOrders, unpricedShareBp } = input;
  if (pricedOrders === 0) {
    return "Vinsten går inte att räkna förrän orderna har inköpspris.";
  }
  const amount = profitOre < 0 ? `Förlust ${kr(-profitOre)}` : `Vinst ${kr(profitOre)}`;
  const margin = marginBp === null ? "" : `, ${marginText(marginBp)} marginal`;
  const missing =
    unpricedShareBp >= UNPRICED_HEADLINE_BP
      ? `, men ${formatPercent(unpricedShareBp / 10_000, 1)} av intäkten saknar inköpspris och ingår inte`
      : "";
  return `${amount} före återbetalningar och fasta kostnader${margin}${missing}.`;
}

/** Rubriken för Hem. */
export function homeHeadline(input: HomeHeadlineInput): HomeHeadline {
  const { today, dataStart, revenueChangeBp } = input;

  if (dataStart === null) {
    return {
      title: "Inga order än.",
      aside: "Intäkt och vinst visas här när den första ordern har importerats.",
      lead: [],
      state: "no-data",
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
      aside: before
        ? sentence(`Första ordern kom ${dayText(dataStart, today)}`)
        : "Inga betalda order har importerats för perioden.",
      lead: [],
      state: "no-orders",
    };
  }

  const title = sentence(`${kr(input.revenueOre)} ${spanText(input.period, dataStart, today)}`);

  let aside: string;
  const lead: string[] = [];
  if (revenueChangeBp !== null) {
    aside =
      revenueChangeBp === 0
        ? "Samma som perioden innan."
        : `${changeText(revenueChangeBp)} ${revenueChangeBp > 0 ? "bättre" : "sämre"} än perioden innan.`;
    lead.push(profitSentence(input));
  } else {
    aside = profitSentence(input);
  }

  return { title, aside, lead, state: "ok" };
}
