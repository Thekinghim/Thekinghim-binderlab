/**
 * Sidans svar högst upp: tvådelad rubrik med fakta ur vymodellen.
 *   "1 plats kritisk, 3 låga."  "30th Celebration i BL‑003 har 1 pack kvar. 16 pack till BL‑003 i dag.
 *   BL‑001 och BL‑002 i morgon."
 * En plats är en titel i en automat (cellen i matrisen). Ordet "fack" används inte här:
 * ordlistans fack är en fysisk plats i automaten, och en automat har sex.
 */

import { formatInt, NBSP } from "@/lib/format";

import { codeText, packs, relativeDay, tenthsText } from "./display";
import type { LagerView, PackList, StockCell } from "./types";

export interface Headline {
  readonly title: string;
  readonly aside: string;
}

function count(n: number, one: string, many: string): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

/** Den mest brådskande cellen: slut först, sedan färst dagar kvar, sedan minst i lager. */
export function mostUrgent(view: Pick<LagerView, "cells">): StockCell | null {
  let best: StockCell | null = null;
  const rank = (c: StockCell) => (c.status === "critical" ? 0 : c.status === "low" ? 1 : 2);
  for (const row of view.cells) {
    for (const c of row) {
      if (!c.stocked || c.status === "ok") continue;
      if (
        best === null ||
        rank(c) < rank(best) ||
        (rank(c) === rank(best) &&
          ((c.daysLeft ?? Infinity) < (best.daysLeft ?? Infinity) ||
            ((c.daysLeft ?? Infinity) === (best.daysLeft ?? Infinity) && c.onHand < best.onHand)))
      ) {
        best = c;
      }
    }
  }
  return best;
}

/** "BL‑001", "BL‑001 och BL‑002", "BL‑001, BL‑002 och BL‑003", eller "4 automater". */
export function machineList(codes: readonly string[]): string {
  if (codes.length > 3) return count(codes.length, "automat", "automater");
  if (codes.length <= 1) return codes[0] ?? "";
  return `${codes.slice(0, -1).join(", ")} och ${codes[codes.length - 1]}`;
}

/**
 * Dagens besök och nästa, i en mening: "16 pack till BL‑003 i dag, BL‑001 och BL‑002 i
 * morgon." Bara automater som ska besökas i dag (PackList.dueToday) räknas till dagens pack.
 */
export function visitsText(view: Pick<LagerView, "packLists" | "machines" | "today">): string {
  const code = new Map(view.machines.map((m) => [m.id, codeText(m.code)]));
  const today = visitsToday(view);
  const later = view.packLists
    .filter((p) => !p.dueToday && p.plannedDay !== null && p.plannedDay > view.today)
    .sort((a, b) => (a.plannedDay! < b.plannedDay! ? -1 : a.plannedDay! > b.plannedDay! ? 1 : 0));
  const next = later[0]?.plannedDay;
  const first = today ? `${today} i dag` : "Inget besök behövs i dag";
  if (next) {
    const onNext = later.filter((p) => p.plannedDay === next);
    const day = relativeDay(next, view.today);
    const who = machineList(onNext.map((p) => code.get(p.machineId) ?? ""));
    const when = day === "i morgon" ? day : `den ${day}`;
    return sentence(today ? `${first}, ${who} ${when}` : `${first}, nästa besök ${who} ${when}`);
  }
  return today ? sentence(first) : "Inget besök behövs i dag, nästa vecka räcker utan besök.";
}

/**
 * Dagens besök i kort form för sidhuvudets fakta: "16 pack till BL‑003" eller "58 pack till
 * 3 automater", eller null om inget besök behövs i dag.
 */
export function visitsTodayShort(view: Pick<LagerView, "packLists" | "machines">): string | null {
  const due = view.packLists.filter((p) => p.dueToday);
  if (due.length === 0) return null;
  if (due.length === 1) return visitsToday(view);
  const total = due.reduce((s, p) => s + p.totalPacks, 0);
  return `${packs(total)} till ${count(due.length, "automat", "automater")}`;
}

/** Dagens besök: "16 pack till BL‑003" eller null om inget besök behövs i dag. */
export function visitsToday(view: Pick<LagerView, "packLists" | "machines">): string | null {
  const code = new Map(view.machines.map((m) => [m.id, codeText(m.code)]));
  const due = view.packLists.filter((p) => p.dueToday);
  if (due.length === 0) return null;
  const total = due.reduce((s, p) => s + p.totalPacks, 0);
  return `${packs(total)} till ${machineList(due.map((p) => code.get(p.machineId) ?? ""))}`;
}

export function headlineOf(view: LagerView): Headline {
  const { critical, low, ok } = view.counts;
  const total = critical + low + ok;
  const titleName = new Map(view.titles.map((t) => [t.id, t.name]));
  // Automatens namn i meningen, som Att göra och Prognos ("i Automat 09"); koden står i tabellen.
  const machineCode = new Map(view.machines.map((m) => [m.id, m.name || codeText(m.code)]));

  if (view.machines.length === 0) {
    return {
      title: "Ingen automat i drift.",
      aside: "Lagret i automaterna visas när en automat är i drift.",
    };
  }
  if (total === 0 && view.unknownCount > 0) {
    return {
      title: `Saldo okänt på ${count(view.unknownCount, "plats", "platser")}.`,
      aside: "Koppla automaten under Datakällor (Awish) eller inventera.",
    };
  }
  if (total === 0) {
    return {
      title: "Inget lager registrerat.",
      aside: `${count(view.machines.length, "automat", "automater")} utan saldo, inventera för att börja.`,
    };
  }

  const urgent = mostUrgent(view);
  const where = urgent
    ? `${titleName.get(urgent.titleId) ?? "En titel"} i ${machineCode.get(urgent.machineId) ?? "en automat"}`
    : "";
  const urgentText = urgent
    ? urgent.onHand === 0
      ? `${where} är slut.`
      : `${where} har ${packs(urgent.onHand)} kvar.`
    : "";

  // Högst två meningar i rubriken (design.md §5.5): läget och den mest brådskande platsen.
  // Dagens besök står i sidhuvudets fakta (visitsToday) och i påfyllningslistan.
  if (critical > 0) {
    return {
      title: `${count(critical, "plats kritisk", "platser kritiska")}${low > 0 ? `, ${formatInt(low)} ${low === 1 ? "låg" : "låga"}` : ""}.`,
      aside: urgentText,
    };
  }
  if (low > 0) {
    return {
      title: `Ingen plats är slut, ${count(low, "plats är låg", "platser är låga")}.`,
      aside: urgentText,
    };
  }
  return {
    title: `Alla ${formatInt(total)}${NBSP}platser räcker minst ${tenthsText(view.lowThresholdTenths)}${NBSP}dagar.`,
    aside: visitsText(view),
  };
}

/** Avslutar med punkt, men inte efter en förkortning som redan har en ("6 nov."). */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** Påfyllningslistans andra rubrikdel: "Besök senast 6 nov., planerat i morgon." */
export function packListAside(
  list: Pick<PackList, "needBy" | "plannedDay">,
  today: LagerView["today"],
): string {
  if (list.needBy === null) return "Ingen titel väntas ta slut den närmaste veckan.";
  const planned =
    list.plannedDay && list.plannedDay !== list.needBy
      ? `, planerat ${relativeDay(list.plannedDay, today)}`
      : "";
  return sentence(`Besök senast ${relativeDay(list.needBy, today)}${planned}`);
}
