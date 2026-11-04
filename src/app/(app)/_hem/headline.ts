/**
 * Hems rubrik: vinsten som en stor siffra, delningen bredvid och en kort rad under.
 *
 *   "Vinst 28 948 kr på 30 dagar." + "Vår del 21 203 kr · butikerna 7 745 kr."
 *   Rad under: "Före fasta kostnader." (bara när det finns fasta kostnader)
 *
 * Ren funktion utan databas och utan React. Inga beräkningar av ekonomi: talen kommer från
 * keyMetrics/changeBp i @/domain; här väljs bara formuleringen.
 */

import { addDays, maxDate, periodDays, type IsoDate, type Period } from "@/domain";
import { MINUS, NBSP, formatInt, formatPercent, formatPeriodShort } from "@/lib/format";
import { dataCoverage } from "@/server/data/core/period";

import { dateOf, dayText, kr, sentence } from "./text";

/** Det stora talet i rubriken (räknas upp på sidan): "Vinst" + belopp + "på 30 dagar." */
export interface HomeHeadlineFigure {
  /** "Vinst", "Förlust" eller "Intäkt". */
  readonly label: string;
  /** Beloppet i öre (alltid ≥ 0; förlust står i `label`). */
  readonly valueOre: number;
  /** Resten av meningen: "på 30 dagar." */
  readonly tail: string;
  /** "good" = vinst, "bad" = förlust, "neutral" = intäkt utan vinst. */
  readonly tone: "good" | "bad" | "neutral";
}

/** En del av delningsraden ("Vår del 21 203 kr"), räknas upp på sidan. */
export interface HomeHeadlineSplitPart {
  readonly label: string;
  readonly valueOre: number;
}

/** Rubriken i två delar (första i fg, andra i grått) och en kort rad under. */
export interface HomeHeadline {
  /** Hela rubriken som text (skärmläsare, tester): "Vinst 28 948 kr på 30 dagar." */
  readonly title: string;
  /** Andra delen: delningen ("Vår del 21 203 kr · butikerna 7 745 kr."), annars intäkten. */
  readonly aside: string;
  /** En kort rad som hindrar misstag ("Före fasta kostnader."). Kan vara tom. */
  readonly lead: string[];
  /** Läget: avgör vad sidan visar under rubriken. */
  readonly state: "no-data" | "no-orders" | "ok";
  /** Det stora talet, null utan order. */
  readonly figure: HomeHeadlineFigure | null;
  /** Delningen vår del / butikernas del, tom när butikerna inte har någon del. */
  readonly split: HomeHeadlineSplitPart[];
}

export interface HomeHeadlineInput {
  /** Nettointäkt i perioden, alla order (öre). */
  readonly revenueOre: number;
  readonly orders: number;
  /** Order med inköpspris (de som ingår i vinsten). */
  readonly pricedOrders: number;
  /**
   * Hela vinsten för order med inköpspris (öre): vår del + butikernas del, efter inköp och
   * kortavgifter (och VMB-moms med vyknappen "Med VMB").
   */
  readonly profitOre: number;
  /** Vår del av vinsten (öre), eller null/utelämnad när butikerna inte har någon del. */
  readonly ourProfitOre?: number | null;
  /** Butikernas del (öre); räknas som hela vinsten − vår del när den utelämnas. */
  readonly storesProfitOre?: number | null;
  /** Butiks- eller automatfilter: delen heter "Butikens del" och står först. */
  readonly filtered?: boolean;
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

/** Delningen: "Vår del" + "Butikerna" (utan filter) eller "Butikens del" + "Vår del". */
function splitParts(input: HomeHeadlineInput): HomeHeadlineSplitPart[] {
  const ours = input.ourProfitOre ?? null;
  if (ours === null || input.pricedOrders === 0) return [];
  const stores = input.storesProfitOre ?? input.profitOre - ours;
  return input.filtered
    ? [
        { label: "Butikens del", valueOre: stores },
        { label: "vår del", valueOre: ours },
      ]
    : [
        { label: "Vår del", valueOre: ours },
        { label: "butikerna", valueOre: stores },
      ];
}

/**
 * Rubriken för Hem: vinsten som det stora talet, delningen som andra del och en kort rad
 * som hindrar misstag (vinsten är före fasta kostnader; stor del utan inköpspris).
 *
 *   "Vinst 28 948 kr på 30 dagar." + "Vår del 21 203 kr · butikerna 7 745 kr."
 *   Utan delning: "Vinst 2 070 kr på 10 dagar." + "Intäkt 4 450 kr, +23 %."
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
        label: loss ? "Förlust" : "Vinst",
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
    const parts = [
      input.fixedCosts === false ? "" : "Före fasta kostnader.",
      input.unpricedShareBp >= UNPRICED_HEADLINE_BP
        ? `${formatPercent(input.unpricedShareBp / 10_000, 1)} saknar inköpspris.`
        : "",
    ].filter(Boolean);
    if (parts.length > 0) lead.push(parts.join(" "));
  }

  return { title, aside, lead, state: "ok", figure, split };
}
