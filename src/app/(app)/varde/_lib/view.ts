/**
 * Det sidan Värde och månadsrapporten visar, formulerat ur ValueData (src/server/varde).
 * Ren funktion: inga beräkningar av ekonomi här (de görs i @/analytics/value), bara val,
 * namn och text. Belopp i öre in, färdiga strängar ut.
 */

import { TASK_ASSUMPTIONS, SAVED_SALES_MAX_DAYS, type BestAction } from "@/analytics/value";
import { kr, monthName } from "@/analytics/todos/text";
import { NBSP, formatDecimal, formatDelta, formatInt, formatPercent, MISSING } from "@/lib/format";
import type { ValueData } from "@/server/varde/load";

export interface ValueCard {
  readonly id: "saved" | "time" | "kept" | "revenue";
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly tone: "good" | "bad" | null;
}

export interface ValueRow {
  readonly key: string;
  readonly cells: readonly string[];
}

export interface ValueView {
  /** "oktober 2026" */
  readonly monthLabel: string;
  /** "oktober" */
  readonly monthWord: string;
  readonly partial: boolean;
  readonly headline: { readonly title: string; readonly aside: string };
  readonly cards: readonly ValueCard[];
  readonly actions: ReadonlyArray<BestAction & { readonly valueText: string | null }>;
  readonly trend: { readonly head: readonly string[]; readonly rows: readonly ValueRow[] };
  readonly machines: { readonly head: readonly string[]; readonly rows: readonly ValueRow[] };
  readonly stores: { readonly head: readonly string[]; readonly rows: readonly ValueRow[] };
  readonly time: { readonly head: readonly string[]; readonly rows: readonly ValueRow[] };
  /** Antagandena och definitionerna, en mening var. */
  readonly assumptions: readonly string[];
}

/** 45 → "45 min", 210 → "3,5 h". */
export function hoursText(minutes: number): string {
  if (minutes < 60) return `${formatInt(minutes)}${NBSP}min`;
  return `${formatDecimal(Math.round(minutes / 6) / 10)}${NBSP}h`;
}

/** Förändring i bp → "+12 %", eller "–" utan jämförelse. */
export function changeText(bp: number | null): string {
  return bp === null ? MISSING : formatDelta(bp / 10_000);
}

/** "2026-10" → "oktober 2026". */
export function monthLabel(month: string): string {
  return `${monthName(month)} ${month.slice(0, 4)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortMonth(month: string): string {
  return monthName(month).slice(0, 3);
}

export function buildValueView(
  data: ValueData,
  /**
   * Vyknappen "Visa butikernas andel": tabellen per butik visar då butikens andel och vår
   * del. Av (standard): bara kvar efter inköp, före butikernas andel, som övriga sidor.
   */
  options: { readonly showStoreShare?: boolean } = {},
): ValueView {
  const word = monthName(data.month);
  const label = monthLabel(data.month);
  const when = data.partial ? `hittills i ${word}` : `i ${word}`;
  const refill = data.refill;
  const margin = data.margin;
  const saved = refill?.savedRevenueOre ?? 0;
  const minutes = data.time.minutes;

  const machineName = new Map(data.names.machines.map((m) => [m.id, m.code || m.name]));
  const storeName = new Map(data.names.stores.map((s) => [s.id, s.name]));

  // Rubriken: det viktigaste i en mening.
  let title: string;
  if (!data.hasData) title = `Inget att visa för ${word} än.`;
  // Påfyllningen görs av människor: rubriken säger att påfyllning i tid räddade
  // försäljningen, inte att Binderlab gjorde det. Tiden är Binderlabs.
  else if (saved > 0 && minutes > 0)
    title = `${capitalize(when)} räddade påfyllning i tid ${kr(saved)} i försäljning och Binderlab sparade ${hoursText(minutes)}.`;
  else if (saved > 0)
    title = `${capitalize(when)} räddade påfyllning i tid ${kr(saved)} i försäljning.`;
  else if (minutes > 0) title = `Binderlab sparade ${hoursText(minutes)} ${when}.`;
  else title = `Kvar efter inköp ${kr(margin?.current.keptOre ?? 0)} ${when}.`;
  const aside = data.hasData
    ? data.partial
      ? "Månaden pågår. Räknat till och med i går."
      : "Försiktigt räknat. Se antagandena längst ned."
    : "Siffrorna kommer när det finns försäljning.";

  const known = refill ? refill.refills.onTime + refill.refills.afterEmpty : 0;
  const cards: ValueCard[] = [
    {
      id: "saved",
      label: "Slutsålt undvikt",
      value: kr(saved),
      sub: refill
        ? known > 0
          ? `${formatInt(refill.refills.onTime)} av ${formatInt(known)} påfyllningar i tid. Tomma fack kostade ${kr(data.lost.lostRevenueOre)}.`
          : `Inga påfyllningar registrerade. Tomma fack kostade ${kr(data.lost.lostRevenueOre)}.`
        : "Ingen försäljning än.",
      tone: saved > 0 ? "good" : null,
    },
    {
      id: "time",
      label: "Tid sparad",
      value: hoursText(minutes),
      sub:
        data.time.valueOre !== null
          ? `${formatInt(data.time.tasks)} uppgifter. Värt ${kr(data.time.valueOre)}.`
          : `${formatInt(data.time.tasks)} uppgifter som Binderlab gjorde.`,
      tone: minutes > 0 ? "good" : null,
    },
    {
      id: "kept",
      label: "Kvar efter inköp",
      value: kr(margin?.current.keptOre ?? 0),
      sub:
        margin?.previous && margin.keptChangeBp !== null
          ? `${changeText(margin.keptChangeBp)} mot ${monthName(margin.previous.month)}${data.partial ? " (samma dagar)" : ""}.`
          : "Ingen månad före att jämföra med.",
      tone: margin?.keptChangeBp == null ? null : margin.keptChangeBp >= 0 ? "good" : "bad",
    },
    {
      id: "revenue",
      label: "Försäljning",
      value: kr(margin?.current.revenueOre ?? 0),
      sub:
        margin?.previous && margin.revenueChangeBp !== null
          ? `${changeText(margin.revenueChangeBp)} mot ${monthName(margin.previous.month)}${data.partial ? " (samma dagar)" : ""}.`
          : `${formatInt(margin?.current.orders ?? 0)} order.`,
      tone: null,
    },
  ];

  const actions = data.actions.map((a) => ({
    ...a,
    valueText: a.valueOre === null ? null : `ca ${kr(a.valueOre)}/mån`,
  }));

  const trend = {
    head: ["Månad", "Försäljning", "Kvar efter inköp", "Räddat", "Tomt kostade", "Tid sparad"],
    rows: data.trend.map((t) => ({
      key: t.month,
      cells: [
        `${shortMonth(t.month)} ${t.month.slice(2, 4)}${t.partial ? " *" : ""}`,
        kr(t.revenueOre),
        kr(t.keptOre),
        kr(t.savedRevenueOre),
        kr(t.lostRevenueOre),
        hoursText(t.minutesSaved),
      ],
    })),
  };

  const machines = {
    head: ["Automat", "Försäljning", "Kvar efter inköp", "Mot månaden före"],
    rows: (margin?.machines ?? []).map((m) => ({
      key: m.key,
      cells: [
        machineName.get(m.key) ?? "Utan automat",
        kr(m.revenueOre),
        kr(m.keptOre),
        changeText(m.changeBp),
      ],
    })),
  };

  const share = options.showStoreShare === true;
  const stores = {
    head: [
      "Butik",
      "Försäljning",
      "Kvar efter inköp",
      ...(share ? ["Butikens andel", "Vår del"] : []),
    ],
    rows: (margin?.stores ?? []).map((s) => ({
      key: s.key,
      cells: [
        storeName.get(s.key) ?? "Utan butik",
        kr(s.revenueOre),
        kr(s.keptOre),
        ...(share ? [kr(s.storeShareOre), kr(s.ourOre)] : []),
      ],
    })),
  };

  const time = {
    head: ["Uppgift", "Antal", "Minuter per gång", "Sparat"],
    rows: data.time.lines.map((l) => ({
      key: l.kind,
      cells: [l.label, formatInt(l.count), formatInt(l.minutesEach), hoursText(l.minutes)],
    })),
  };

  const assumptions = [
    `Slutsålt undvikt: pack som såldes efter en påfyllning i tid och som annars hade mött ett tomt fack. Högst ${formatInt(SAVED_SALES_MAX_DAYS)} dagar räknas, i snittpris utan moms.`,
    "Slutsålt undvikt är försäljning, inte vinst, och gäller alla påfyllningar i tid, inte bara dem Binderlab föreslog.",
    "Tomt kostade: beräknad förlorad försäljning när ett fack stod tomt (samma siffra som på Inköp).",
    ...TASK_ASSUMPTIONS.map(
      (t) =>
        `${t.label}: ${formatInt(t.minutes)} min per ${t.unit}, i stället för att ${t.instead}.`,
    ),
    data.hourlyCostOre !== null
      ? `Tiden värderas till ${kr(data.hourlyCostOre)} per timme (Effekt).`
      : "Tiden värderas inte i kronor: ange en timkostnad under Effekt.",
    "Kvar efter inköp: försäljning utan moms minus inköp, kortavgift och VMB-moms, före butikens andel. Order utan inköpspris räknas inte.",
    margin && margin.current.unpricedRevenueOre > 0
      ? `${kr(margin.current.unpricedRevenueOre)} försäljning ${when} saknar inköpspris och ingår inte.`
      : null,
    refill && refill.refills.unknown > 0
      ? `${formatInt(refill.refills.unknown)} påfyllningar hade okänt saldo före och räknas inte.`
      : null,
    margin?.keptMarginBp != null
      ? `Kvar efter inköp är ${formatPercent(margin.keptMarginBp / 10_000, 0)} av försäljningen ${when}.`
      : null,
  ].filter((s): s is string => s !== null);

  return {
    monthLabel: label,
    monthWord: word,
    partial: data.partial,
    headline: { title, aside },
    cards,
    actions,
    trend,
    machines,
    stores,
    time,
    assumptions,
  };
}
