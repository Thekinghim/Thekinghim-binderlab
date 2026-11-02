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
  /** Sista dagen med order. Ett underlag för en period efter den (en prognos) länkar inte till order. */
  readonly asOf?: IsoDate;
  /**
   * Historiken som prognosen bygger på. Ett underlag för en period efter `asOf` länkar till
   * orderna i den i stället (samma titel/automat).
   */
  readonly historyPeriod?: Period;
}

/** Fler länkar för underlag som gäller lager och inköp. */
export interface EvidenceOptions {
  /** Länka till centrallagret på Lager. */
  readonly centralStock?: boolean;
  /**
   * Historiklänken filtreras bara på titel (inköpsplanen gäller titelns efterfrågan i alla
   * automater, även om underlaget pekar ut automaterna där lagret finns).
   */
  readonly historyByTitle?: boolean;
  /** Länka till inköpsordern (avsnittet Inköpsorder) när underlaget pekar ut inköpsorder. */
  readonly purchaseOrdersHref?: string;
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

/** Underlaget som text och länkar till Order, Lager och Inköpsorder. */
export function evidenceView(
  e: PlanEvidence,
  names: NameLookup,
  options: EvidenceOptions = {},
): EvidenceView {
  const dates = [...e.dates].sort();
  const titleIds = [...new Set(e.titleIds)];
  const machineIds = [...new Set(e.machineIds)];
  const links: EvidenceLink[] = [];
  const future = Boolean(e.period && names.asOf && e.period.start > names.asOf);
  if (e.orderIds.length === 1) {
    links.push({
      label: "Visa ordern",
      href: `/order?order=${encodeURIComponent(e.orderIds[0]!)}`,
    });
  } else if (e.orderIds.length > 0 || (e.period && !future)) {
    links.push({
      label: e.orderIds.length > 0 ? `Visa ${formatInt(e.orderIds.length)} order` : "Visa orderna",
      href: orderHref(e.period, titleIds, machineIds),
    });
  } else if (future && names.historyPeriod) {
    // En prognos eller plan: perioden har inte hänt, så länka till historiken den bygger på.
    links.push({
      label: "Visa orderna som prognosen bygger på",
      href: orderHref(names.historyPeriod, titleIds, options.historyByTitle ? [] : machineIds),
    });
  }
  if (machineIds.length === 1) {
    links.push({
      label: "Visa lagret i automaten",
      href: `/lager?automat=${encodeURIComponent(machineIds[0]!)}`,
    });
  }
  if (options.centralStock) {
    links.push({ label: "Visa centrallagret", href: "/lager#centrallager" });
  }
  const poCount = e.purchaseOrderIds?.length ?? 0;
  if (options.purchaseOrdersHref && poCount > 0) {
    links.push({
      label: poCount === 1 ? "Visa inköpsordern" : `Visa ${formatInt(poCount)} inköpsorder`,
      href: options.purchaseOrdersHref,
    });
  }
  return {
    rule: e.rule,
    period: e.period ? periodLong(e.period) : null,
    figures: e.figures.map((f) => ({ key: f.key, label: f.label, value: figureText(f) })),
    titles: titleIds.map((id) => names.title(id)),
    machines: machineIds.map((id) => names.machine(id)),
    dates: dates.slice(0, MAX_DATES).map((d: IsoDate) => dateText(d)),
    moreDates: Math.max(0, dates.length - MAX_DATES),
    orderCount: e.orderIds.length,
    links,
  };
}
