/**
 * Hems rubrik: läget i en mening, räknat ur nyckeltalen.
 *
 *   "79 987 kr på 20 dagar." + "12 % bättre än perioden innan."
 *   Ingress: "Vinst 18 950 kr efter alla kostnader, 23,7 % marginal."
 *
 * Ren funktion utan databas och utan React. Inga beräkningar av ekonomi: talen kommer från
 * keyMetrics/changeBp i @/domain; här väljs bara formuleringen.
 */

import { periodDays, type IsoDate, type Period } from "@/domain";
import { NBSP, formatInt, formatPercent } from "@/lib/format";

import { dayText, kr, marginText, sentence } from "./text";

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
  /** Vinst för order med inköpspris (öre). */
  readonly profitOre: number;
  readonly marginBp: number | null;
  /** Andel av intäkten som saknar inköpspris, i bp. */
  readonly unpricedShareBp: number;
  /** Intäktens förändring mot jämförelseperioden i bp, null utan jämförbar period. */
  readonly revenueChangeBp: number | null;
  /** Dagarna i perioden som har data, eller null. */
  readonly coverage: Period | null;
  readonly period: Period;
  readonly today: IsoDate;
  readonly dataStart: IsoDate | null;
}

/** Förändring i bp som "12 %" (utan tecken), en decimal under 10 %. */
function changeText(bp: number): string {
  const share = Math.abs(bp) / 10_000;
  return formatPercent(share, share < 0.1 ? 1 : 0);
}

/** "på 20 dagar", "i dag", "i går", "den 31 okt." */
function spanText(coverage: Period, today: IsoDate): string {
  const days = periodDays(coverage);
  if (days > 1) return `på ${formatInt(days)}${NBSP}dagar`;
  if (coverage.start === today) return "i dag";
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  if (coverage.start === yesterday) return "i går";
  return `den ${dayText(coverage.start, today)}`;
}

function profitSentence(input: HomeHeadlineInput): string {
  const { profitOre, marginBp } = input;
  const amount = profitOre < 0 ? `Förlust ${kr(-profitOre)}` : `Vinst ${kr(profitOre)}`;
  const margin = marginBp === null ? "" : `, ${marginText(marginBp)} marginal`;
  return `${amount} efter alla kostnader${margin}.`;
}

/** Rubriken för Hem. */
export function homeHeadline(input: HomeHeadlineInput): HomeHeadline {
  const { coverage, today, dataStart, revenueChangeBp } = input;

  if (dataStart === null) {
    return {
      title: "Inga order än.",
      aside: "Intäkt och vinst visas här när den första ordern har importerats.",
      lead: [],
      state: "no-data",
    };
  }

  if (coverage === null || input.orders === 0) {
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

  const title = `${kr(input.revenueOre)} ${spanText(coverage, today)}.`;

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
