/**
 * Rapportutkast som väntar på granskning: utkast (senaste versionen, inte godkänd och inte
 * skickad) samlas till en punkt per rapportmånad, eftersom de granskas tillsammans i
 * Rapporter. Inget skickas utan godkännande, så ett utkast som ligger kvar stoppar utskicket.
 *
 *   sista dag = samma som för utskicket (`reportDeadline`): rapporten för oktober ska
 *               skickas under november
 *   nivå      = 'now' efter sista dagen, 'soon' 0–3 dagar kvar, annars 'later'
 *   fingerprint = antal utkast och det senaste utkastets tid: ett nytt utkast tar upp en
 *               avbockad punkt igen
 */

import { monthOf, type IsoMonth } from "@/domain";
import { evidence, nameLookup } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import { reportDeadline } from "./reports";
import { capitalize, day, monthName, plural, sentence } from "./text";
import type { ReportDraftRef, ReportKind, TodoItem } from "./types";

const KIND_NAME: Record<ReportKind, string> = {
  store_statement: "butiksrapport",
  accountant_statement: "bokföringsunderlag",
  owner_statement: "ägarrapport",
  profitability: "lönsamhetsrapport",
};

const KIND_ORDER: readonly ReportKind[] = [
  "store_statement",
  "accountant_statement",
  "owner_statement",
  "profitability",
];

/** "a", "a och b", "a, b och c". */
function joinSv(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} och ${parts[parts.length - 1]}`;
}

/** "2 butiksrapporter, bokföringsunderlag och ägarrapport". */
function draftList(drafts: readonly ReportDraftRef[]): string {
  const parts: string[] = [];
  for (const kind of KIND_ORDER) {
    const n = drafts.filter((d) => d.reportKind === kind).length;
    if (n === 0) continue;
    const name = KIND_NAME[kind];
    parts.push(n === 1 ? name : `${n} ${name === "bokföringsunderlag" ? name : `${name}er`}`);
  }
  return joinSv(parts);
}

/** Rapporttypen i Rapporters adress (`?typ=`), för de sorter som går att granska där. */
const URL_TYPE: Partial<Record<ReportKind, string>> = {
  store_statement: "butik",
  accountant_statement: "bokforing",
  owner_statement: "delagare",
};

/**
 * Länk till granskningen i Rapporter. Rapporter väljer typ och butik ur adressen (utan
 * `typ` blir det butiksrapporten för första butiken), så länken pekar ut det första
 * utkastet (ordning som i texten: butiksrapporter, bokföringsunderlag, ägarrapport;
 * sedan butik). Övriga utkast för månaden står i arkivet på samma sida. Ett utkast av en
 * sort som Rapporter inte granskar länkar till arkivet.
 */
export function reviewLink(month: IsoMonth, drafts: readonly ReportDraftRef[] = []): string {
  const first = [...drafts].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.reportKind) - KIND_ORDER.indexOf(b.reportKind) ||
      (a.storeId ?? "").localeCompare(b.storeId ?? "") ||
      (a.id < b.id ? -1 : 1),
  )[0];
  const type = first ? URL_TYPE[first.reportKind] : undefined;
  if (!first || !type) {
    return first
      ? `/rapporter?${new URLSearchParams({ manad: month, vy: "arkiv" }).toString()}`
      : `/rapporter?${new URLSearchParams({ manad: month }).toString()}#granska`;
  }
  const params = new URLSearchParams({ typ: type, manad: month });
  if (type === "butik" && first.storeId) params.set("butiken", first.storeId);
  return `/rapporter?${params.toString()}#granska`;
}

/** En punkt per rapportmånad med utkast som inte godkänts. */
export function reportReviewTodos(ctx: TodoContext): TodoItem[] {
  const drafts = ctx.input.reportDrafts ?? [];
  if (drafts.length === 0) return [];
  const storeName = nameLookup(ctx.input.stores ?? []);
  const byMonth = new Map<IsoMonth, ReportDraftRef[]>();
  for (const d of drafts) {
    const month = monthOf(d.periodStart);
    const list = byMonth.get(month);
    if (list) list.push(d);
    else byMonth.set(month, [d]);
  }

  const out: TodoItem[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    const list = [...byMonth.get(month)!].sort((a, b) => (a.id < b.id ? -1 : 1));
    const { due, daysLeft, level } = reportDeadline(ctx, month);
    const n = list.length;
    const latest = list.reduce((a, b) => (b.generatedAt > a.generatedAt ? b : a));
    const stores = list
      .filter((d) => d.storeId !== null)
      .map((d) => storeName(d.storeId!))
      .sort((a, b) => a.localeCompare(b, "sv"));
    const deadline =
      daysLeft < 0
        ? sentence(`Skulle ha skickats senast ${day(due)}`)
        : daysLeft === 0
          ? "Ska skickas i dag."
          : `Ska skickas senast ${day(due)} (${plural(daysLeft, "dag", "dagar")} kvar).`;
    const storeText = stores.length > 0 ? ` Butiker: ${joinSv(stores)}.` : "";
    out.push({
      key: `report-review:${month}`,
      fingerprint: `${n}|${latest.generatedAt}`,
      kind: "report-review",
      level,
      urgency: urgencyOf(level, null),
      atStakeOre: null,
      daysLeft,
      title:
        n === 1
          ? `Granska rapportutkastet för ${monthName(month)}`
          : `Granska ${n} rapportutkast för ${monthName(month)}`,
      detail: `${capitalize(draftList(list))} väntar på godkännande. Inget skickas förrän ${
        n === 1 ? "det är godkänt" : "de är godkända"
      }. ${deadline}${storeText}`,
      evidence: evidence({
        rule: "Ett utkast skickas inte förrän ägare eller admin godkänt det; förra månadens rapporter ska skickas under månaden.",
        period: { start: list[0]!.periodStart, end: list[0]!.periodEnd },
        dates: [due],
        storeIds: list.map((d) => d.storeId).filter((x): x is string => x !== null),
        figures: [
          { key: "drafts", label: "Utkast", value: n, unit: "count" },
          { key: "daysLeft", label: "Dagar kvar", value: daysLeft, unit: "days" },
        ],
      }),
      link: reviewLink(month, list),
      action: { kind: "review-report", label: "Granska utkasten", params: { month } },
    });
  }
  return out;
}
