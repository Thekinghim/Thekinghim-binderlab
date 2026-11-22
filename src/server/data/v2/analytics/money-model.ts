/**
 * Pengar i V2 (G4): rena funktioner som gör om färdiga tal till kortens form. Inget räknas
 * på ett nytt sätt: vinst, intäkt, andel och fasta kostnader kommer från Lönsamhet
 * (profitability, resultAfterProfit), vinst per dag i tjänst från enhetsekonomin
 * (compareUnitEconomics) och rangordningen från flottans läge. Här grupperas, sorteras och
 * jämförs bara. Belopp i öre, andelar i bp, datum 'ÅÅÅÅ-MM-DD'.
 *
 * Ingen databas och ingen React, så att Hem, Pengar och Butiker kan dela funktionerna och
 * testerna kan köra utan server (money-model.test.ts).
 */

import { changeBp, ratioBp, type IsoDate } from "@/domain";

/* ------------------------------------------------------------------ */
/* Från intäkt till vinst                                              */
/* ------------------------------------------------------------------ */

export interface WaterfallInput {
  /** Intäkt exkl. moms för order med inköpspris (vattenfallets start). */
  readonly revenueOre: number;
  /** VMB-moms, eller null när organisationen inte redovisar VMB. */
  readonly vmbVatOre: number | null;
  readonly costOre: number;
  readonly feesOre: number;
  /** Vinsten före butikernas andel (= intäkt − VMB − inköp − avgifter). */
  readonly profitBeforeShareOre: number;
  /** Butikernas andel (provision + hyra) i perioden. */
  readonly compensationOre: number;
  /** Återbetalningar och gratis-pack (resultAfterProfit), 0 när de saknas. */
  readonly refundOre: number;
  readonly freePackOre: number;
  /** Fasta kostnader, eller null när de inte går att räkna (butiksfilter). */
  readonly fixedCostOre: number | null;
  /** Kortavgiften i inställningarna (bp av priset), för etiketten. */
  readonly cardFeeBp: number | null;
  /** Antal butiker med andel i perioden, för undertexten. */
  readonly stores: number;
}

export type WaterfallKind = "revenue" | "cost" | "base" | "result";

export interface WaterfallRow {
  readonly key: string;
  readonly label: string;
  readonly sub: string;
  readonly kind: WaterfallKind;
  /** Beloppet med tecken (kostnader negativa). */
  readonly valueOre: number;
  /** Andel av intäkten i bp (absolut), null när intäkten är 0. */
  readonly shareBp: number | null;
  /** Stapelns början och slut som andel av intäkten (0–1), för vattenfallet. */
  readonly from: number;
  readonly to: number;
}

function bpText(bp: number): string {
  const v = bp / 100;
  return `${v.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`;
}

/**
 * Stegen Intäkt → (VMB-moms) → Inköp → Kortavgift → Vinst → Butikernas andel →
 * (återbetalningar, gratis-pack) → Fasta kostnader → Kvar efter allt. "Vinst" är samma tal
 * som Resultat och Hem (före butikernas andel); sista raden är det som blir kvar när
 * butikerna och de fasta kostnaderna är betalda. Steg som är 0 visas inte (utom Vinst).
 */
export function waterfallRows(input: WaterfallInput): WaterfallRow[] {
  const rev = input.revenueOre;
  const scale = (ore: number) => (rev > 0 ? Math.max(0, Math.min(1, ore / rev)) : 0);
  const share = (ore: number) => ratioBp(Math.abs(ore), rev);
  const rows: WaterfallRow[] = [
    {
      key: "revenue",
      label: "Intäkt",
      sub: "Allt som sålts i automaterna, utan moms",
      kind: "revenue",
      valueOre: rev,
      shareBp: rev > 0 ? 10_000 : null,
      from: 0,
      to: rev > 0 ? 1 : 0,
    },
  ];
  let level = rev;
  const cost = (key: string, label: string, sub: string, ore: number, always = false) => {
    if (ore === 0 && !always) return;
    const next = level - ore;
    rows.push({
      key,
      label,
      sub,
      kind: "cost",
      valueOre: -ore,
      shareBp: share(ore),
      from: scale(Math.min(level, next)),
      to: scale(Math.max(level, next)),
    });
    level = next;
  };
  if (input.vmbVatOre !== null) cost("vmb", "VMB-moms", "Moms på vinstmarginalen", input.vmbVatOre);
  cost("cost", "Inköp", "Vad packen kostade oss", input.costOre, true);
  cost(
    "fees",
    input.cardFeeBp !== null && input.cardFeeBp > 0
      ? `Kortavgift ${bpText(input.cardFeeBp)}`
      : "Kortavgift",
    "Till Awish och kortbolaget",
    input.feesOre,
    true,
  );
  rows.push({
    key: "profit",
    label: "Vinst",
    sub: "Före butikernas andel, som på Hem",
    kind: "base",
    valueOre: input.profitBeforeShareOre,
    shareBp: ratioBp(input.profitBeforeShareOre, rev),
    from: 0,
    to: scale(input.profitBeforeShareOre),
  });
  level = input.profitBeforeShareOre;
  cost(
    "share",
    "Butikernas andel",
    input.stores === 1 ? "1 butik, enligt avtalet" : `${input.stores} butiker, enligt avtalen`,
    input.compensationOre,
    true,
  );
  cost("refunds", "Återbetalningar", "Pengar tillbaka till kunder", input.refundOre);
  cost("free", "Gratis-pack", "Koder i Awish, till inköpspris", input.freePackOre);
  if (input.fixedCostOre !== null) {
    cost("fixed", "Fasta kostnader", "Hyra, försäkring, appar", input.fixedCostOre, true);
  }
  rows.push({
    key: "result",
    label: "Kvar efter allt",
    sub:
      input.fixedCostOre === null
        ? "Efter butikernas andel"
        : "Efter butikernas andel och fasta kostnader",
    kind: "result",
    valueOre: level,
    shareBp: ratioBp(level, rev),
    from: 0,
    to: scale(level),
  });
  return rows;
}

/* ------------------------------------------------------------------ */
/* Resultat: staplar per vecka eller dag                               */
/* ------------------------------------------------------------------ */

export interface TrendBucketLike {
  readonly key: string;
  readonly axis: string;
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly partial: boolean;
  readonly profitOre: number;
}

export interface ProfitBar {
  readonly key: string;
  readonly label: string;
  readonly profitOre: number;
  /** Veckan pågår (dagarna hittills). */
  readonly partial: boolean;
  /** "6 av 7 d" för en vecka som bara delvis ligger i perioden, annars null. */
  readonly partialText: string | null;
  /** Takten för hela veckan (vinsten hittills ÷ dagar × 7), bara för en pågående vecka. */
  readonly paceOre: number | null;
}

const DAY_MS = 86_400_000;
const dayNumber = (d: IsoDate) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);

/**
 * Staplarna i Resultat: Lönsamhets veckor (30 dagar) eller dagar (7 dagar). Den sista
 * veckan kan pågå; den får takten för hela veckan så att stapeln kan jämföras ("takt").
 * En vecka som bara delvis ligger i periodens början visas som den är (ingen takt).
 */
export function profitBars(
  buckets: readonly TrendBucketLike[],
  unit: "week" | "day",
  today: IsoDate,
): ProfitBar[] {
  return buckets.map((b, i) => {
    const last = i === buckets.length - 1;
    const running = unit === "week" && last && b.partial && b.end >= today;
    const days = dayNumber(b.end) - dayNumber(b.start) + 1;
    return {
      key: b.key,
      label: unit === "week" ? b.axis.replace(/^V/i, "v. ") : b.axis,
      profitOre: b.profitOre,
      partial: running,
      partialText: unit === "week" && b.partial && days < 7 ? `${days} av 7 d` : null,
      paceOre: running && days > 0 ? Math.round((b.profitOre * 7) / days) : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Vinst per stad                                                      */
/* ------------------------------------------------------------------ */

export interface MachineProfit {
  readonly machineId: string;
  readonly code: string | null;
  readonly name: string;
  readonly city: string | null;
  readonly profitOre: number;
  /** Förra lika långa periodens vinst, eller null (ingen jämförelse). */
  readonly previousProfitOre: number | null;
}

export interface CityProfit {
  /** Stadens namn, "Utan stad" när butiken saknar stad. */
  readonly city: string;
  readonly machines: number;
  readonly totalOre: number;
  readonly perMachineOre: number;
  /** Förändring mot förra perioden (summan för stadens automater med jämförelse), bp. */
  readonly deltaBp: number | null;
  /** Automaterna, mest vinst först. */
  readonly items: readonly MachineProfit[];
}

export const NO_CITY = "Utan stad";

/**
 * Vinsten per stad (butikens stad i dag), med vinst per automat för att städer med olika
 * många automater ska gå att jämföra. Sorterad på vinst per automat. Förändringen räknas
 * bara på automater som har en jämförelse (annars blir en ny automat en "ökning").
 */
export function profitByCity(machines: readonly MachineProfit[]): CityProfit[] {
  const groups = new Map<string, MachineProfit[]>();
  for (const m of machines) {
    const city = m.city?.trim() || NO_CITY;
    const list = groups.get(city);
    if (list) list.push(m);
    else groups.set(city, [m]);
  }
  const out: CityProfit[] = [];
  for (const [city, items] of groups) {
    const total = items.reduce((a, m) => a + m.profitOre, 0);
    const compared = items.filter((m) => m.previousProfitOre !== null);
    const nowCmp = compared.reduce((a, m) => a + m.profitOre, 0);
    const prevCmp = compared.reduce((a, m) => a + (m.previousProfitOre ?? 0), 0);
    out.push({
      city,
      machines: items.length,
      totalOre: total,
      perMachineOre: Math.round(total / items.length),
      deltaBp: compared.length > 0 ? changeBp(nowCmp, prevCmp) : null,
      items: [...items].sort(
        (a, b) => b.profitOre - a.profitOre || (a.code ?? "").localeCompare(b.code ?? "", "sv"),
      ),
    });
  }
  return out.sort(
    (a, b) =>
      (a.city === NO_CITY ? 1 : 0) - (b.city === NO_CITY ? 1 : 0) ||
      b.perMachineOre - a.perMachineOre ||
      a.city.localeCompare(b.city, "sv"),
  );
}

/* ------------------------------------------------------------------ */
/* Bästsäljare                                                         */
/* ------------------------------------------------------------------ */

export interface TitleProfitLine {
  readonly titleId: string;
  readonly name: string;
  readonly orders: number;
  readonly revenueOre: number;
  readonly profitOre: number;
}

export interface TopTitle extends TitleProfitLine {
  /** Andel av periodens vinst (alla titlar), bp. */
  readonly shareBp: number | null;
  /** Vinsten mot förra perioden, bp (null utan jämförelse). */
  readonly deltaBp: number | null;
  /** Sålda pack per vecka, äldst först (för den lilla linjen). */
  readonly weekly: readonly number[];
}

/** De `limit` titlarna med mest vinst, med andel av vinsten och förändring. */
export function topTitles(
  current: readonly TitleProfitLine[],
  previous: ReadonlyMap<string, number> | null,
  weekly: ReadonlyMap<string, readonly number[]>,
  limit = 5,
): TopTitle[] {
  const total = current.reduce((a, t) => a + Math.max(0, t.profitOre), 0);
  return [...current]
    .filter((t) => t.orders > 0)
    .sort((a, b) => b.profitOre - a.profitOre || a.name.localeCompare(b.name, "sv"))
    .slice(0, limit)
    .map((t) => {
      const prev = previous?.get(t.titleId);
      return {
        ...t,
        shareBp: total > 0 ? ratioBp(Math.max(0, t.profitOre), total) : null,
        deltaBp: prev === undefined || prev === 0 ? null : changeBp(t.profitOre, prev),
        weekly: weekly.get(t.titleId) ?? [],
      };
    });
}

/**
 * Sålda pack per titel och vecka (måndag–söndag), de `weeks` senaste veckorna t.o.m. veckan
 * med `today`. Varje order är ett pack.
 */
export function weeklyUnits(
  orders: readonly { readonly titleId: string | null; readonly businessDate: IsoDate }[],
  today: IsoDate,
  weeks = 8,
): Map<string, number[]> {
  const t = dayNumber(today);
  // Måndagen i dagens vecka (1970-01-01 var en torsdag: dag 0 → index 3).
  const monday = t - ((t + 3) % 7);
  const first = monday - (weeks - 1) * 7;
  const out = new Map<string, number[]>();
  for (const o of orders) {
    if (!o.titleId) continue;
    const d = dayNumber(o.businessDate);
    if (d < first || d > t) continue;
    const w = Math.floor((d - first) / 7);
    let row = out.get(o.titleId);
    if (!row) {
      row = new Array<number>(weeks).fill(0);
      out.set(o.titleId, row);
    }
    row[w] = (row[w] ?? 0) + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Vinst per automat och månad (kr per dag i tjänst)                   */
/* ------------------------------------------------------------------ */

export interface MonthSlice {
  /** 'ÅÅÅÅ-MM'. */
  readonly month: string;
  /** Dagarna i månaden som ingår (t.o.m. i dag, från första dagen med data). */
  readonly start: IsoDate;
  readonly end: IsoDate;
  /** Månaden pågår. */
  readonly running: boolean;
  /** Per automat: vinst och dagar i tjänst (enhetsekonomins aktiva dagar). */
  readonly rows: readonly {
    readonly machineId: string;
    readonly profitOre: number;
    readonly activeDays: number;
  }[];
}

export interface MonthMachineRow {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  /** Vinst per dag i tjänst per månad (öre), null när automaten inte stod ute. */
  readonly values: readonly (number | null)[];
  /** Hela tidens vinst ÷ hela tidens dagar i tjänst (öre), null utan dagar. */
  readonly averageOre: number | null;
}

export interface MonthTable {
  readonly months: readonly { readonly month: string; readonly running: boolean }[];
  readonly rows: readonly MonthMachineRow[];
  /** Hela flottans vinst per kalenderdag per månad (öre). */
  readonly totals: readonly (number | null)[];
  /** Hela tidens vinst per kalenderdag (öre). */
  readonly totalAverageOre: number | null;
  /** Största värdet i tabellen (för färgskalan), minst 1. */
  readonly maxOre: number;
}

/**
 * Tabellen "Vinst per automat · kr per dag": vinsten delad med dagarna automaten stod ute
 * (samma aktiva dagar som Enhetsekonomi och rangordningen), så att nya och gamla automater
 * går att jämföra. Raderna sorteras på senaste hela månaden (annars snittet), högst först.
 */
export function monthTable(
  slices: readonly MonthSlice[],
  machines: readonly { readonly id: string; readonly code: string; readonly name: string }[],
): MonthTable {
  const byMachine = new Map<string, { values: (number | null)[]; profit: number; days: number }>();
  for (const m of machines) {
    byMachine.set(m.id, { values: slices.map(() => null), profit: 0, days: 0 });
  }
  const totals: (number | null)[] = [];
  let allProfit = 0;
  let allDays = 0;
  slices.forEach((s, i) => {
    let monthProfit = 0;
    let any = false;
    for (const r of s.rows) {
      const acc = byMachine.get(r.machineId);
      if (!acc || r.activeDays <= 0) continue;
      acc.values[i] = Math.round(r.profitOre / r.activeDays);
      acc.profit += r.profitOre;
      acc.days += r.activeDays;
      monthProfit += r.profitOre;
      any = true;
    }
    const calendarDays = dayNumber(s.end) - dayNumber(s.start) + 1;
    totals.push(any && calendarDays > 0 ? Math.round(monthProfit / calendarDays) : null);
    if (any) {
      allProfit += monthProfit;
      allDays += calendarDays;
    }
  });
  const sortIndex = (() => {
    for (let i = slices.length - 1; i >= 0; i--) if (!slices[i]!.running) return i;
    return slices.length - 1;
  })();
  const rows: MonthMachineRow[] = machines
    .map((m) => {
      const acc = byMachine.get(m.id)!;
      return {
        machineId: m.id,
        code: m.code,
        name: m.name,
        values: acc.values,
        averageOre: acc.days > 0 ? Math.round(acc.profit / acc.days) : null,
      };
    })
    .filter((r) => r.values.some((v) => v !== null))
    .sort((a, b) => {
      const av = a.values[sortIndex] ?? null;
      const bv = b.values[sortIndex] ?? null;
      if (av !== null && bv !== null && av !== bv) return bv - av;
      if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
      return (
        (b.averageOre ?? -Infinity) - (a.averageOre ?? -Infinity) || a.code.localeCompare(b.code)
      );
    });
  let max = 1;
  for (const r of rows) for (const v of r.values) if (v !== null && v > max) max = v;
  return {
    months: slices.map((s) => ({ month: s.month, running: s.running })),
    rows,
    totals,
    totalAverageOre: allDays > 0 ? Math.round(allProfit / allDays) : null,
    maxOre: max,
  };
}

const MONTH_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

/** "nov" för '2026-11'. */
export function monthShort(month: string): string {
  return MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
}

/** Ett tal i CSV: kronor med två decimaler och komma, tomt för null. */
function csvKr(ore: number | null): string {
  if (ore === null) return "";
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(ore);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function csvCell(text: string): string {
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Tabellen som CSV (semikolon, svenska decimaler, BOM för Excel): en rad per automat med
 * vinst per dag i tjänst per månad, snittet och sist raden "Alla".
 */
export function monthTableCsv(table: MonthTable): string {
  const head = ["Kod", "Automat", ...table.months.map((m) => m.month), "Snitt"];
  const lines = [head.map(csvCell).join(";")];
  for (const r of table.rows) {
    lines.push(
      [r.code, r.name, ...r.values.map(csvKr), csvKr(r.averageOre)].map(csvCell).join(";"),
    );
  }
  lines.push(["", "Alla", ...table.totals.map(csvKr), csvKr(table.totalAverageOre)].join(";"));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/* ------------------------------------------------------------------ */
/* Mål                                                                 */
/* ------------------------------------------------------------------ */

export interface GoalLike {
  readonly id: string;
  readonly metric: string;
  readonly scopeName: string | null;
  readonly unit: "ore" | "count";
  readonly actual: number;
  readonly target: number;
  readonly forecast: number;
}

/** Målet för Pengar: organisationens vinstmål, annars intäktsmålet, annars inget. */
export function pickMoneyGoal<G extends GoalLike>(goals: readonly G[]): G | null {
  const org = goals.filter((g) => g.scopeName === null && g.unit === "ore");
  return org.find((g) => g.metric === "profit") ?? org.find((g) => g.metric === "revenue") ?? null;
}

/** Saknas med takten nu (öre, 0 när prognosen når målet). */
export function goalShortOre(goal: Pick<GoalLike, "target" | "forecast">): number {
  return Math.max(0, goal.target - goal.forecast);
}
