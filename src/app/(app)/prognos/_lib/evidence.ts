/**
 * Underlaget bakom en siffra (PlanEvidence från @/analytics) som text och länkar: regeln,
 * perioden, talen med enhet, vilka titlar och automater, och var orderna och lagret finns.
 * Ren funktion, klientsäker.
 */

import type { PlanEvidence, PlanFigure } from "@/analytics/forecast/common";
import type { IsoDate, Period } from "@/domain";
import { formatInt, formatKronor, formatNumber, formatPercent, NBSP } from "@/lib/format";

import { dateText, periodLong } from "./dates";

/** Ett tal i underlaget med sin enhet: "1,5 pack", "49,00 kr", "12,4 %", "9 dagar". */
export function figureText(f: Pick<PlanFigure, "value" | "unit">): string {
  switch (f.unit) {
    case "ore":
      return formatKronor(f.value / 100);
    case "bp":
      return formatPercent(f.value / 10_000);
    case "milli":
      return `${formatNumber(f.value / 1_000, 1)}${NBSP}pack`;
    case "packs":
      return `${formatInt(f.value)}${NBSP}pack`;
    case "days":
      return `${formatInt(f.value)}${NBSP}${f.value === 1 ? "dag" : "dagar"}`;
    case "hours":
      return `${formatInt(f.value)}${NBSP}h`;
    case "tenths":
      return formatNumber(f.value / 10, 1);
    case "count":
    default:
      return formatInt(f.value);
  }
}

export interface EvidenceLink {
  readonly label: string;
  readonly href: string;
}

export interface EvidenceView {
  readonly rule: string;
  readonly period: string | null;
  readonly figures: readonly { key: string; label: string; value: string }[];
  readonly titles: readonly string[];
  readonly machines: readonly string[];
  /** Upp till 14 dagar som underlaget pekar ut (t.ex. slutsålda dagar). */
  readonly dates: readonly string[];
  readonly moreDates: number;
  readonly orderCount: number;
  readonly links: readonly EvidenceLink[];
}

export interface NameLookup {
  title(id: string): string;
  machine(id: string): string;
}

const MAX_DATES = 14;

function orderHref(
  period: Period | null,
  titleIds: readonly string[],
  machineIds: readonly string[],
) {
  const q = new URLSearchParams();
  if (period) {
    q.set("from", period.start);
    q.set("to", period.end);
  }
  if (machineIds.length === 1) q.set("automat", machineIds[0]!);
  if (titleIds.length === 1) q.set("titel", titleIds[0]!);
  const s = q.toString();
  return s ? `/order?${s}` : "/order";
}

/** Underlaget som text och länkar till Order och Lager. */
export function evidenceView(e: PlanEvidence, names: NameLookup): EvidenceView {
  const dates = [...e.dates].sort();
  const links: EvidenceLink[] = [];
  if (e.orderIds.length === 1) {
    links.push({
      label: "Visa ordern",
      href: `/order?order=${encodeURIComponent(e.orderIds[0]!)}`,
    });
  } else if (e.orderIds.length > 0 || e.period) {
    links.push({
      label: e.orderIds.length > 0 ? `Visa ${formatInt(e.orderIds.length)} order` : "Visa orderna",
      href: orderHref(e.period, e.titleIds, e.machineIds),
    });
  }
  if (e.machineIds.length === 1) {
    links.push({
      label: "Visa lagret i automaten",
      href: `/lager?automat=${encodeURIComponent(e.machineIds[0]!)}`,
    });
  }
  return {
    rule: e.rule,
    period: e.period ? periodLong(e.period) : null,
    figures: e.figures.map((f) => ({ key: f.key, label: f.label, value: figureText(f) })),
    titles: e.titleIds.map((id) => names.title(id)),
    machines: e.machineIds.map((id) => names.machine(id)),
    dates: dates.slice(0, MAX_DATES).map((d: IsoDate) => dateText(d)),
    moreDates: Math.max(0, dates.length - MAX_DATES),
    orderCount: e.orderIds.length,
    links,
  };
}
