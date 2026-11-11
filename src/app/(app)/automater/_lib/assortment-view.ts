/**
 * Bästa sortiment på automatens sida: rubrik, rader och förslag som text. Ren funktion.
 * Reglerna finns i @/analytics/ranking/assortment.
 */

import {
  ASSORTMENT_MIN_DAYS,
  perDayText,
  type AssortmentRow,
  type BestAssortment,
} from "@/analytics/ranking/assortment";
import { tenths } from "@/analytics/todos/text";
import { formatInt, formatSek, NBSP } from "@/lib/format";

export interface AssortmentRowView {
  readonly titleId: string;
  readonly name: string;
  /** "6/dag" eller "–" */
  readonly units: string;
  /** "412 kr/dag", "Inköpspris saknas" eller "–" */
  readonly profit: string;
  /** "28 dagar i lager · 168 pack" */
  readonly basis: string;
  /** "Står still" · "Mystery pack: fylls bara när facket är tomt (14 st)" · "För lite data" · "Inte i sortimentet nu" */
  readonly tag: string | null;
  readonly warn: boolean;
  /** Stapelns längd 0–1 (pack per dag mot den bästa). */
  readonly bar: number;
}

export interface AssortmentView {
  readonly title: string;
  readonly aside: string;
  readonly rows: AssortmentRowView[];
  /** Förslagen, viktigast först. */
  readonly suggestions: string[];
  /** Varför det inte finns något förslag, eller null. */
  readonly notice: string | null;
  readonly note: string;
}

function rowView(r: AssortmentRow, top: number): AssortmentRowView {
  // Hela dagar utan decimal ("28 dagar"), annars en decimal ("26,5 dagar").
  const days = `${
    r.stockedDayTenths % 10 === 0 ? formatInt(r.stockedDayTenths / 10) : tenths(r.stockedDayTenths)
  }${NBSP}dagar i lager`;
  let tag: string | null = null;
  if (r.mysteryBatch !== null) {
    tag = `Mystery pack: fylls bara när facket är tomt (${formatInt(r.mysteryBatch)}${NBSP}st)`;
  } else if (r.slow) tag = "Står still";
  else if (!r.current) tag = "Inte i sortimentet nu";
  else if (!r.enough) tag = "För lite data";
  return {
    titleId: r.titleId,
    name: r.name,
    units: r.unitsPerDayMilli === null ? "–" : `${perDayText(r.unitsPerDayMilli)}/dag`,
    profit:
      r.profitPerDayOre !== null
        ? `${formatSek(r.profitPerDayOre / 100)}/dag`
        : r.units > 0
          ? "Inköpspris saknas"
          : "–",
    basis: `${days} · ${formatInt(r.units)}${NBSP}pack`,
    tag,
    warn: r.slow,
    bar: top > 0 && r.unitsPerDayMilli !== null ? Math.min(1, r.unitsPerDayMilli / top) : 0,
  };
}

export function assortmentView(args: {
  assortment: BestAssortment;
  code: string;
  storeShareDeducted: boolean;
}): AssortmentView {
  const a = args.assortment;
  const top = Math.max(0, ...a.rows.map((r) => r.unitsPerDayMilli ?? 0));
  const rows = a.rows.map((r) => rowView(r, top));
  const note = `Pack och vinst per dag i lager (slutsålda dagar räknas inte). ${
    args.storeShareDeducted ? "Vinst efter butikernas andel." : "Vinst före butikernas andel."
  }`;

  let title: string;
  let aside: string;
  let notice: string | null = null;
  if (a.rows.length === 0) {
    title = `Inget har sålt i ${args.code} i perioden.`;
    aside = "Välj en längre period.";
  } else if (a.tooShort) {
    title = `För lite data: ${formatInt(a.days)}${NBSP}${a.days === 1 ? "dag" : "dagar"}.`;
    aside = `Välj minst ${ASSORTMENT_MIN_DAYS}${NBSP}dagar för att få förslag.`;
  } else if (!a.best) {
    title = "För lite data än.";
    aside = `Ingen titel har legat i lager i ${ASSORTMENT_MIN_DAYS}${NBSP}dagar.`;
  } else {
    title = `${a.best.name} säljer bäst här.`;
    aside =
      a.best.unitsPerDayMilli === null
        ? ""
        : `${perDayText(a.best.unitsPerDayMilli)}${NBSP}pack/dag${
            a.best.profitPerDayOre === null
              ? ""
              : `, ${formatSek(a.best.profitPerDayOre / 100)} vinst/dag`
          }.`;
    if (a.slow.length === 0) {
      notice = "Inget står still: inget att byta ut.";
    } else if (a.otherMachines === 0) {
      notice = `Inget att prova i stället än: ingen annan automat har sålt i ${ASSORTMENT_MIN_DAYS}${NBSP}dagar.`;
    } else if (a.suggestions.every((s) => s.tryInstead === null)) {
      notice = "Inget att prova i stället: ingen titel säljer tydligt bättre i andra automater.";
    }
  }
  return { title, aside, rows, suggestions: a.suggestions.map((s) => s.text), notice, note };
}
