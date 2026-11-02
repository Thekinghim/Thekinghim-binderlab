/**
 * Butikers vymodeller: rena funktioner som sätter ihop resultaten från @/domain
 * (profitability, storeCompensation) med stamdata och avtal till rader, rubriker och
 * nyckeltal. Ingen ekonomi räknas här: belopp kommer ur beräkningslagret och läggs
 * bara ihop per butik eller formateras. Testas i model.test.ts.
 */

import { parseIsoDate } from "@/components/shell/period-state";
import {
  addDays,
  changeBp,
  daysBetween,
  daysInMonth,
  monthOf,
  monthStart,
  type IsoDate,
  type ProfitabilityResult,
  type ProfitabilityRow,
} from "@/domain";
import {
  formatDate,
  formatDelta,
  formatInt,
  formatKronor,
  formatMonth,
  formatPercent,
  formatSek,
  NBSP,
} from "@/lib/format";

import type {
  AgreementState,
  AgreementView,
  CompensationModel,
  DailyPoint,
  KpiView,
  MonthCompensation,
  RecipientView,
  StoreIssue,
  StoreRow,
} from "./types";

/** Så många dagar före slutet varnar sidan för ett avtal utan efterföljare. */
export const ENDING_SOON_DAYS = 45;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function isoToDate(iso: IsoDate): Date {
  return parseIsoDate(iso) ?? new Date(Number.NaN);
}

/** "13 okt." (året bara när det inte är samma år som i dag). */
export function dayText(iso: IsoDate, today: IsoDate): string {
  return formatDate(isoToDate(iso), { year: "auto", now: isoToDate(today) });
}

/** Första bokstaven versal och en avslutande punkt (om meningen inte redan slutar med en). */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const cap = t.charAt(0).toLocaleUpperCase("sv-SE") + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** Ören som hela kronor: "12 480 kr". */
export function sek(ore: number): string {
  return formatSek(ore / 100);
}

/** Ören med ören: "12 480,50 kr" (ersättning som ska betalas ut). */
export function kronor(ore: number): string {
  return formatKronor(ore / 100);
}

/** Provision i bp som procent: "12 %" eller "12,5 %". */
export function percentBp(bp: number): string {
  return formatPercent(bp / 10_000, bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2);
}

// ---------------------------------------------------------------------------
// Avtal
// ---------------------------------------------------------------------------

export function compensationModel(
  commissionBp: number | null,
  monthlyRentOre: number | null,
): CompensationModel {
  if (commissionBp !== null && monthlyRentOre !== null) return "both";
  return monthlyRentOre !== null ? "rent" : "commission";
}

export const MODEL_LABEL: Record<CompensationModel, string> = {
  commission: "Provision",
  rent: "Hyra",
  both: "Provision och hyra",
};

/** "Provision 12 % · hyra 750 kr/mån". */
export function termsLabel(commissionBp: number | null, monthlyRentOre: number | null): string {
  const parts: string[] = [];
  if (commissionBp !== null) parts.push(`provision ${percentBp(commissionBp)}`);
  if (monthlyRentOre !== null) parts.push(`hyra ${sek(monthlyRentOre)}/mån`);
  return parts.length > 0 ? sentence(parts.join(" · ")).replace(/\.$/, "") : "Ingen ersättning";
}

export function agreementState(
  a: { validFrom: IsoDate; validTo: IsoDate | null },
  today: IsoDate,
): AgreementState {
  if (a.validFrom > today) return "upcoming";
  if (a.validTo !== null && a.validTo < today) return "ended";
  return "current";
}

/** "1 okt. 2026 – tills vidare" / "1 okt. – 31 dec. 2026". */
export function agreementPeriodLabel(validFrom: IsoDate, validTo: IsoDate | null): string {
  const from = formatDate(isoToDate(validFrom), { year: "always" });
  if (validTo === null) return `${from}${NBSP}– tills vidare`;
  return `${from}${NBSP}–${NBSP}${formatDate(isoToDate(validTo), { year: "always" })}`;
}

export interface AgreementRecord {
  readonly id: string;
  readonly storeId: string;
  readonly contractId: string | null;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly commissionBp: number | null;
  readonly monthlyRentOre: number | null;
  readonly note: string | null;
}

export function toAgreementView(a: AgreementRecord, today: IsoDate): AgreementView {
  return {
    ...a,
    model: compensationModel(a.commissionBp, a.monthlyRentOre),
    state: agreementState(a, today),
    termsLabel: termsLabel(a.commissionBp, a.monthlyRentOre),
    periodLabel: agreementPeriodLabel(a.validFrom, a.validTo),
  };
}

/** Butikens avtal, senaste först. */
export function agreementsOf(
  agreements: readonly AgreementView[],
  storeId: string,
): AgreementView[] {
  return agreements
    .filter((a) => a.storeId === storeId)
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Siffror ur beräkningslagret
// ---------------------------------------------------------------------------

/** Intäkt för alla order på raden (prissatta och utan pris). */
export function revenueOf(row: ProfitabilityRow | undefined): number {
  return row ? row.revenueOre + row.unpricedRevenueOre : 0;
}

/** Butiksersättning på raden: provision för alla order + all hyra (som storeCompensation). */
export function compensationOf(row: ProfitabilityRow | undefined): number {
  return row ? row.commissionOre + row.unpricedCommissionOre + row.rentOre : 0;
}

function rowsByKey(result: ProfitabilityResult | null): Map<string, ProfitabilityRow> {
  const map = new Map<string, ProfitabilityRow>();
  if (!result) return map;
  for (const r of result.rows) if (r.kind === "item") map.set(r.key, r);
  return map;
}

/** Intäkt per dag i kronor (tidsraderna ur profitability(…, "day")). */
export function dailySeries(result: ProfitabilityResult): DailyPoint[] {
  return result.rows
    .filter((r) => r.kind === "time")
    .map((r) => ({ date: r.key, value: revenueOf(r) / 100 }));
}

// ---------------------------------------------------------------------------
// Listan
// ---------------------------------------------------------------------------

export interface StoreBase {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly city: string | null;
  readonly isExample: boolean;
  readonly archived: boolean;
}

export interface MachinePlacementRef {
  readonly machineId: string;
  readonly storeId: string;
  readonly from: IsoDate;
  readonly to: IsoDate | null;
}

/** Automaterna (koder) som står i butiken i dag. */
export function machinesIn(
  storeId: string,
  placements: readonly MachinePlacementRef[],
  codeOf: ReadonlyMap<string, string>,
  today: IsoDate,
): string[] {
  return placements
    .filter(
      (p) => p.storeId === storeId && p.from <= today && (p.to === null || p.to >= today),
    )
    .map((p) => codeOf.get(p.machineId) ?? "")
    .filter(Boolean)
    .sort();
}

/** Förändring som andel (changeBp / 10 000), eller null när föregående värde är 0. */
export function changeShare(current: number, previous: number): number | null {
  const bp = changeBp(current, previous);
  return bp === null ? null : bp / 10_000;
}

export function buildStoreRows(args: {
  stores: readonly StoreBase[];
  placements: readonly MachinePlacementRef[];
  machineCodes: ReadonlyMap<string, string>;
  agreements: readonly AgreementView[];
  /** profitability(current, "store"). */
  current: ProfitabilityResult;
  /** profitability(previous, "store"), eller null utan jämförelse. */
  previous: ProfitabilityResult | null;
  /** storeCompensation för månaden hittills: storeId → totalOre. */
  earnedMonth: ReadonlyMap<string, number>;
  today: IsoDate;
  query: string;
}): StoreRow[] {
  const cur = rowsByKey(args.current);
  const prev = rowsByKey(args.previous);
  return args.stores
    .map((s): StoreRow => {
      const row = cur.get(s.id);
      const current =
        agreementsOf(args.agreements, s.id).find((a) => a.state === "current") ?? null;
      const machineCodes = machinesIn(s.id, args.placements, args.machineCodes, args.today);
      return {
        id: s.id,
        name: s.name,
        place: [s.address, s.city].filter(Boolean).join(", ") || null,
        isExample: s.isExample,
        archived: s.archived,
        machineCodes,
        orders: row?.orders ?? 0,
        revenueOre: revenueOf(row),
        previousRevenueOre: args.previous ? revenueOf(prev.get(s.id)) : null,
        revenueChange: args.previous ? changeShare(revenueOf(row), revenueOf(prev.get(s.id))) : null,
        compensationOre: compensationOf(row),
        profitOre: row?.profitOre ?? 0,
        earnedMonthOre: args.earnedMonth.get(s.id) ?? 0,
        current,
        flag:
          !s.archived && current === null && machineCodes.length > 0
            ? "Inget avtal i dag"
            : null,
        href: `/butiker/${s.id}${args.query}`,
      };
    })
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        b.revenueOre - a.revenueOre ||
        a.name.localeCompare(b.name, "sv"),
    );
}

/** Rubriken på listan: intäkten först, sedan vad butikerna fick och vem som bär mest. */
export function listHeadline(
  rows: readonly StoreRow[],
  days: number,
): { title: string; aside: string | undefined } {
  const active = rows.filter((r) => !r.archived);
  if (active.length === 0) return { title: "Inga butiker ännu.", aside: undefined };
  const revenue = rows.reduce((n, r) => n + r.revenueOre, 0);
  const compensation = rows.reduce((n, r) => n + r.compensationOre, 0);
  const title = `${plural(active.length, "butik", "butiker")} gav ${sek(revenue)} på ${plural(days, "dag", "dagar")}.`;
  if (revenue <= 0) return { title, aside: "Ingen försäljning i perioden." };
  const top = [...rows].sort((a, b) => b.revenueOre - a.revenueOre)[0]!;
  const parts = [
    `${sek(compensation)} till butikerna, ${formatPercent(compensation / revenue)} av intäkten`,
  ];
  if (active.length > 1) {
    parts.push(`${top.name} står för ${formatPercent(top.revenueOre / revenue, 0)}`);
  }
  return { title, aside: parts.map(sentence).join(" ") };
}

/** Förändring som text: "12 % mer än" / "8 % mindre än" / "lika mycket som". */
export function changeText(current: number, previous: number): string | null {
  const bp = changeBp(current, previous);
  if (bp === null) return null;
  if (bp === 0) return "lika mycket som";
  const digits = Math.abs(bp) < 1_000 ? 1 : 0;
  return `${formatDelta(Math.abs(bp) / 10_000, digits).replace(/^[+−±]/, "")} ${bp > 0 ? "mer" : "mindre"} än`;
}

export function listKpis(
  rows: readonly StoreRow[],
  monthLabel: string,
  previous: ProfitabilityResult | null,
): KpiView[] {
  const revenue = rows.reduce((n, r) => n + r.revenueOre, 0);
  const compensation = rows.reduce((n, r) => n + r.compensationOre, 0);
  const earned = rows.reduce((n, r) => n + r.earnedMonthOre, 0);
  const prevRevenue = rows.reduce((n, r) => n + (r.previousRevenueOre ?? 0), 0);
  const prevCompensation = previous
    ? previous.rows
        .filter((r) => r.kind === "item")
        .reduce((n, r) => n + compensationOf(r), 0)
    : 0;
  const rel = (cur: number, prev: number) => {
    const bp = previous ? changeBp(cur, prev) : null;
    return bp === null ? null : { kind: "relative" as const, value: bp / 10_000 };
  };
  return [
    {
      id: "revenue",
      label: "Intäkt",
      value: revenue,
      kind: "sek",
      primary: true,
      delta: rel(revenue, prevRevenue),
    },
    {
      id: "compensation",
      label: "Butiksersättning",
      value: compensation,
      kind: "sek",
      delta: rel(compensation, prevCompensation),
    },
    {
      id: "share",
      label: "Andel av intäkten",
      value: revenue > 0 ? compensation / revenue : 0,
      kind: "percent",
    },
    { id: "earned", label: `Intjänat ${monthLabel}`, value: earned, kind: "sek" },
  ];
}

// ---------------------------------------------------------------------------
// En butik
// ---------------------------------------------------------------------------

/** Månaden hittills: från den första i månaden till och med i dag. */
export function monthToDate(today: IsoDate): { start: IsoDate; end: IsoDate } {
  return { start: monthStart(monthOf(today)), end: today };
}

/** Månadens namn: "november". */
export function monthLabel(today: IsoDate): string {
  return formatMonth(isoToDate(monthToDate(today).start), { year: "never" });
}

export function monthCompensation(args: {
  today: IsoDate;
  storeId: string;
  /** profitability(månaden hittills, "store"), alla butiker. */
  result: ProfitabilityResult;
  /** storeCompensation för månaden hittills: storeId → belopp. */
  compensation: ReadonlyMap<string, { commissionOre: number; rentOre: number; totalOre: number }>;
}): MonthCompensation {
  const { start, end } = monthToDate(args.today);
  const row = rowsByKey(args.result).get(args.storeId);
  const c = args.compensation.get(args.storeId);
  return {
    monthLabel: monthLabel(args.today),
    start,
    end,
    days: daysBetween(start, end) + 1,
    daysInMonth: daysInMonth(start),
    revenueOre: revenueOf(row),
    orders: row?.orders ?? 0,
    commissionOre: c?.commissionOre ?? 0,
    rentOre: c?.rentOre ?? 0,
    totalOre: c?.totalOre ?? 0,
  };
}

/** Rubriken för ersättningen: vad butiken tjänat hittills och hur det är sammansatt. */
export function compensationHeadline(
  month: MonthCompensation,
  current: AgreementView | null,
): { title: string; aside: string } {
  if (current === null) {
    return {
      title: month.totalOre > 0 ? `${sek(month.totalOre)} intjänat hittills i ${month.monthLabel}.` : "Inget avtal gäller i dag.",
      aside:
        month.totalOre > 0
          ? "Inget avtal gäller i dag, så ingen ny ersättning räknas."
          : "Ingen provision eller hyra räknas förrän ett avtal läggs in.",
    };
  }
  const parts: string[] = [];
  if (current.commissionBp !== null) {
    parts.push(
      `provision ${percentBp(current.commissionBp)} av ${sek(month.revenueOre)} ger ${sek(month.commissionOre)}`,
    );
  }
  if (current.monthlyRentOre !== null) {
    parts.push(
      `hyra ${sek(month.rentOre)} för ${formatInt(month.days)} av ${formatInt(month.daysInMonth)}${NBSP}dagar`,
    );
  }
  return {
    title: `${sek(month.totalOre)} intjänat hittills i ${month.monthLabel}.`,
    aside: sentence(parts.join(", ")),
  };
}

/** Rubriken på butikens sida: intäkten i perioden och förändringen. */
export function storeHeadline(args: {
  name: string;
  revenueOre: number;
  previousRevenueOre: number | null;
  days: number;
  month: MonthCompensation;
}): { title: string; aside: string } {
  const title =
    args.revenueOre > 0
      ? `${args.name} gav ${sek(args.revenueOre)} på ${plural(args.days, "dag", "dagar")}.`
      : `${args.name} har ingen försäljning på ${plural(args.days, "dag", "dagar")}.`;
  const parts: string[] = [];
  if (args.previousRevenueOre !== null && args.revenueOre > 0) {
    const change = changeText(args.revenueOre, args.previousRevenueOre);
    if (change) parts.push(`${change} perioden innan`);
  }
  parts.push(`butiken har tjänat ${sek(args.month.totalOre)} hittills i ${args.month.monthLabel}`);
  return { title, aside: parts.map(sentence).join(" ") };
}

export function storeKpis(args: {
  current: ProfitabilityRow | undefined;
  previous: ProfitabilityRow | undefined | null;
  daily: readonly DailyPoint[];
}): KpiView[] {
  const cur = args.current;
  const prev = args.previous;
  const revenue = revenueOf(cur);
  const compensation = compensationOf(cur);
  const rel = (a: number, b: number) => {
    if (prev === null) return null;
    const bp = changeBp(a, b);
    return bp === null ? null : { kind: "relative" as const, value: bp / 10_000 };
  };
  return [
    {
      id: "revenue",
      label: "Intäkt",
      value: revenue,
      kind: "sek",
      primary: true,
      delta: rel(revenue, revenueOf(prev ?? undefined)),
      trend: args.daily.map((d) => d.value),
    },
    {
      id: "orders",
      label: "Sålda pack",
      value: cur?.orders ?? 0,
      kind: "int",
      delta: rel(cur?.orders ?? 0, prev?.orders ?? 0),
    },
    {
      id: "compensation",
      label: "Butiksersättning",
      value: compensation,
      kind: "sek",
      delta: rel(compensation, compensationOf(prev ?? undefined)),
    },
    {
      id: "profit",
      label: "Vinst",
      value: cur?.profitOre ?? 0,
      kind: "sek",
      delta: rel(cur?.profitOre ?? 0, prev?.profitOre ?? 0),
    },
  ];
}

/** Vad som behöver göras för butiken, viktigast först. */
export function storeIssues(args: {
  agreements: readonly AgreementView[];
  machineCodes: readonly string[];
  recipients: readonly RecipientView[];
  archived: boolean;
  today: IsoDate;
}): StoreIssue[] {
  if (args.archived) return [];
  const out: StoreIssue[] = [];
  const current = args.agreements.find((a) => a.state === "current") ?? null;
  const upcoming = args.agreements
    .filter((a) => a.state === "upcoming")
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1))[0];
  const codes = args.machineCodes.join(", ");
  if (current === null && args.machineCodes.length > 0) {
    out.push({
      id: "no-agreement",
      level: "critical",
      text: `Inget avtal gäller i dag för ${codes}. Ingen provision eller hyra räknas.`,
    });
  }
  if (current?.validTo && !upcoming) {
    const left = daysBetween(args.today, current.validTo);
    if (left <= ENDING_SOON_DAYS) {
      out.push({
        id: "ending",
        level: "warning",
        text: `Avtalet slutar ${dayText(current.validTo, args.today)}, om ${plural(left, "dag", "dagar")}, och inget nytt avtal är inlagt.`,
      });
    }
  }
  if (upcoming) {
    out.push({
      id: "upcoming",
      level: "neutral",
      text: `Nytt avtal från ${dayText(upcoming.validFrom, args.today)}: ${upcoming.termsLabel.toLocaleLowerCase("sv-SE")}.`,
    });
  }
  if (args.machineCodes.length > 0 && !args.recipients.some((r) => r.active)) {
    out.push({
      id: "no-recipient",
      level: "neutral",
      text: "Ingen tar emot butikens månadsrapport.",
    });
  }
  return out;
}

/** Senaste dagen ett nytt avtal kan börja utan att skriva över historik (för fältets min). */
export function earliestNewAgreementDay(agreements: readonly AgreementView[]): IsoDate | null {
  const latest = agreements.reduce<IsoDate | null>(
    (m, a) => (m === null || a.validFrom > m ? a.validFrom : m),
    null,
  );
  return latest ? addDays(latest, 1) : null;
}
