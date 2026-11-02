/**
 * Rapporter som ska skickas denna månad: förra månadens rapport till varje aktiv mottagare.
 *
 *   butik       → butiksrapport (store_statement), bara om butiken hade en automat placerad
 *                 någon dag förra månaden
 *   bokförare   → bokföringsunderlag (accountant_statement)
 *   delägare    → ägarrapport (owner_statement)
 *
 * Rapporten räknas som skickad om det finns ett utskick till mottagaren av rätt typ för
 * exakt förra månaden med status köad, skickad eller levererad. Misslyckade och studsade
 * utskick räknas inte.
 *
 *   sista dag = `reportDueDay` i denna månad (standard: månadens sista dag)
 *   nivå      = 'now' efter sista dagen, 'soon' 0–3 dagar kvar, annars 'later'
 */

import {
  addMonths,
  daysBetween,
  daysInMonth,
  monthEnd,
  monthOf,
  monthPeriod,
  overlapDays,
  type IsoDate,
  type IsoMonth,
} from "@/domain";
import { evidence, links, nameLookup } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import { day, monthName, plural, sentence } from "./text";
import { businessDateAt, parseInstant } from "./time";
import type {
  ReportDeliveryRef,
  ReportKind,
  ReportRecipientRef,
  TodoItem,
  TodoLevel,
} from "./types";

const KIND_BY_RECIPIENT: Record<ReportRecipientRef["kind"], ReportKind> = {
  store: "store_statement",
  accountant: "accountant_statement",
  partner: "owner_statement",
};

const LABEL: Record<ReportRecipientRef["kind"], string> = {
  store: "butiksrapporten",
  accountant: "bokföringsunderlaget",
  partner: "ägarrapporten",
};

const DONE: ReadonlySet<ReportDeliveryRef["status"]> = new Set(["queued", "sent", "delivered"]);

/** Antal dagar kvar till sista dag då punkten får nivån 'soon'. */
export const REPORT_SOON_DAYS = 3;

/**
 * Sista dag att skicka rapporterna för `reportMonth` (månaden efter, dag `reportDueDay` eller
 * månadens sista dag), dagar kvar från i dag och nivån. Samma regel för utkast att granska.
 */
export function reportDeadline(
  ctx: Pick<TodoContext, "today" | "options">,
  reportMonth: IsoMonth,
): { due: IsoDate; daysLeft: number; level: TodoLevel } {
  const month = addMonths(reportMonth, 1);
  const due: IsoDate =
    ctx.options.reportDueDay === null
      ? monthEnd(month)
      : `${month}-${String(Math.min(ctx.options.reportDueDay, daysInMonth(month))).padStart(2, "0")}`;
  const daysLeft = daysBetween(ctx.today, due);
  const level: TodoLevel = daysLeft < 0 ? "now" : daysLeft <= REPORT_SOON_DAYS ? "soon" : "later";
  return { due, daysLeft, level };
}

/** Punkter för rapporter som inte skickats. */
export function reportTodos(ctx: TodoContext): TodoItem[] {
  const { input, today, options } = ctx;
  const reportMonth = addMonths(monthOf(today), -1);
  const period = monthPeriod(reportMonth);
  const { due, daysLeft, level } = reportDeadline(ctx, reportMonth);
  const storeName = nameLookup(input.stores ?? []);

  const out: TodoItem[] = [];
  const recipients = [...input.reportRecipients].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const r of recipients) {
    if (!r.active) continue;
    const kind = KIND_BY_RECIPIENT[r.kind];
    if (r.kind === "store" && r.storeId !== null) {
      const storeId = r.storeId;
      const placed = input.placements.some(
        (p) =>
          p.storeId === storeId &&
          overlapDays(period, { start: p.from, end: p.to ?? period.end }) > 0,
      );
      if (!placed) continue;
    }
    const deliveries = input.reportDeliveries.filter(
      (d) =>
        d.recipientId === r.id &&
        d.reportKind === kind &&
        d.periodStart === period.start &&
        d.periodEnd === period.end &&
        (r.kind !== "store" || d.storeId === null || r.storeId === null || d.storeId === r.storeId),
    );
    if (deliveries.some((d) => DONE.has(d.status))) continue;
    const failed = deliveries
      .filter((d) => !DONE.has(d.status))
      .map((d) => ({ d, ms: d.sentAt ? parseInstant(d.sentAt) : -Infinity }))
      .sort((a, b) => a.ms - b.ms || (a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0))
      .map((x) => x.d);
    const latestFailed = failed[failed.length - 1];

    const to =
      r.kind === "store" && r.storeId !== null && storeName(r.storeId) !== r.storeId
        ? `${r.name} (${storeName(r.storeId)})`
        : r.name;
    const deadline =
      daysLeft < 0
        ? sentence(`Skulle ha skickats senast ${day(due)}`)
        : daysLeft === 0
          ? `Ska skickas i dag.`
          : `Ska skickas senast ${day(due)} (${plural(daysLeft, "dag", "dagar")} kvar).`;
    const failedText = latestFailed
      ? ` Senaste utskicket ${latestFailed.status === "bounced" ? "studsade" : "misslyckades"}` +
        (latestFailed.sentAt
          ? sentence(` ${day(businessDateAt(latestFailed.sentAt, options.timeZone))}`)
          : ".")
      : "";

    out.push({
      key: `report-due:${r.id}:${reportMonth}`,
      fingerprint: `${failed.length}`,
      kind: "report-due",
      level,
      urgency: urgencyOf(level, null),
      atStakeOre: null,
      daysLeft,
      title: `Skicka ${LABEL[r.kind]} för ${monthName(reportMonth)} till ${to}`,
      detail: `${deadline}${failedText}`,
      evidence: evidence({
        rule: "Förra månadens rapport ska skickas till varje aktiv mottagare under månaden.",
        period,
        dates: [due],
        storeIds: r.storeId !== null ? [r.storeId] : [],
        recipientIds: [r.id],
        figures: [
          { key: "daysLeft", label: "Dagar kvar", value: daysLeft, unit: "days" },
          {
            key: "failedDeliveries",
            label: "Misslyckade utskick",
            value: failed.length,
            unit: "count",
          },
        ],
      }),
      link: links.reports(reportMonth, r.id),
      action: {
        kind: "send-report",
        label: "Skicka rapporten",
        params: { recipientId: r.id, month: reportMonth, reportKind: kind },
      },
    });
  }
  return out;
}
