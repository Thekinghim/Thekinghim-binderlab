/**
 * Månadsavräkning per butik: ren logik utan databas och utan Next.
 *
 * Beloppet är butikens ersättning för månaden enligt avtalet, `compensation.totalOre` i
 * butiksrapporten (`buildStoreReport` i @/reports). Samma uträkning används av
 * månadsrapporten till butiken, Butiker och bokföringspaketet (butikens andel), så siffran
 * stämmer överallt. Bokföringen läser aldrig avräkningen: den bokför andelen ur
 * försäljningen som tidigare, så inget räknas två gånger.
 *
 * Det som sparas på avräkningen (statement) är bara det som behövs för att visa och skriva
 * ut den: avtalet i klartext, stegen i uträkningen och månadens försäljning. Inga titlar,
 * automater eller inköpspriser per pack; vinstdelningens månadssummor står i stegen, som
 * avtalet säger.
 */

import { z } from "zod";

import { settlementDue } from "@/analytics/todos/settlements";
import { addMonths, monthOf, type IsoDate, type IsoMonth } from "@/domain";
import { escapeHtml } from "@/reports/contract-pdf";
import { dateText, krText, monthText, type StoreReport } from "@/reports";

export const STATEMENT_VERSION = 1;

export interface SettlementStep {
  readonly label: string;
  readonly calculation: string;
  readonly amountOre: number;
}

/** Avräkningens uträkning (store_settlements.statement). */
export interface SettlementStatement {
  readonly version: typeof STATEMENT_VERSION;
  readonly storeName: string;
  readonly month: IsoMonth;
  /** Avtalet i klartext, t.ex. "50 % av vinsten". */
  readonly modelText: string;
  readonly steps: readonly SettlementStep[];
  /** Försäljning inkl. moms. */
  readonly salesInclVatOre: number;
  readonly orders: number;
  readonly totalOre: number;
}

/** Uträkningen ur månadens butiksrapport. */
export function statementFromReport(report: StoreReport): SettlementStatement {
  return {
    version: STATEMENT_VERSION,
    storeName: report.store.name,
    month: report.month,
    modelText: report.compensation.modelText,
    steps: report.compensation.steps
      .filter((s) => s.kind !== "total")
      .map((s) => ({ label: s.label, calculation: s.calculation, amountOre: s.amountOre })),
    salesInclVatOre: report.sales.grossOre,
    orders: report.sales.orders,
    totalOre: report.compensation.totalOre,
  };
}

const statementSchema = z.object({
  version: z.literal(STATEMENT_VERSION),
  storeName: z.string().max(300),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  modelText: z.string().max(1000),
  steps: z
    .array(
      z.object({
        label: z.string().max(500),
        calculation: z.string().max(1000),
        amountOre: z.number().int(),
      }),
    )
    .max(50),
  salesInclVatOre: z.number().int(),
  orders: z.number().int().min(0),
  totalOre: z.number().int(),
});

/** Läser en sparad uträkning; null om den inte har rätt form. */
export function parseStatement(value: unknown): SettlementStatement | null {
  const parsed = statementSchema.safeParse(value);
  return parsed.success ? (parsed.data as SettlementStatement) : null;
}

export type SettlementState = "unpaid" | "owed" | "paid" | "nothing";

/**
 * Obetald (vi betalar butiken), butiken betalar (förlust som butiken delar enligt avtalet,
 * 'proportional'), betald/reglerad, eller inget att betala (0 kr).
 */
export function settlementState(amountOre: number, paidOn: string | null): SettlementState {
  if (paidOn) return "paid";
  if (amountOre > 0) return "unpaid";
  return amountOre < 0 ? "owed" : "nothing";
}

export const STATE_LABEL: Record<SettlementState, string> = {
  unpaid: "Ej betald",
  owed: "Butiken betalar",
  paid: "Betald",
  nothing: "Inget att betala",
};

/** Sista dagen att betala ut: den 15:e månaden efter (avtalets utbetalningsdag). */
export function payoutDueDate(month: IsoMonth): IsoDate {
  return settlementDue(month);
}

/** Månaden som avräknas när man står på `today`: förra kalendermånaden. */
export function settlementMonthFor(today: IsoDate): IsoMonth {
  return addMonths(monthOf(today), -1);
}

/** Filnamnet för avräkningens PDF: "avrakning-butik-2026-10.pdf". */
export function settlementFileName(storeName: string, month: IsoMonth): string {
  const slug =
    storeName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "butik";
  return `avrakning-${slug}-${month}.pdf`;
}

export interface SettlementDocument {
  readonly organizationName: string;
  readonly statement: SettlementStatement;
  readonly amountOre: number;
  readonly paidOn: IsoDate | null;
  /** Kort referens (avräkningens id, första 8 tecknen). */
  readonly reference: string;
  /** Varför en obetald inte kan räknas nu (beloppet är då inte klart). */
  readonly blocked?: string | null;
}

/** Avräkningen som fristående HTML (inga externa resurser) för utskrift som A4-PDF. */
export function settlementHtml(doc: SettlementDocument): string {
  const s = doc.statement;
  const state = settlementState(doc.amountOre, doc.paidOn);
  const status = doc.blocked
    ? `Inte klar: ${doc.blocked}`
    : state === "paid"
      ? `Betald ${dateText(doc.paidOn!)}`
      : state === "unpaid"
        ? `Betalas senast ${dateText(payoutDueDate(s.month))}`
        : state === "owed"
          ? "Förlust: butiken bär sin andel enligt avtalet"
          : "Inget att betala ut för månaden";
  const totalLabel = doc.amountOre < 0 ? "Butiken betalar" : "Att betala ut";
  const rows = s.steps
    .map(
      (step) =>
        `<tr><td><div>${escapeHtml(step.label)}</div><div class="calc">${escapeHtml(step.calculation)}</div></td><td class="n">${escapeHtml(krText(step.amountOre))}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avräkning ${escapeHtml(s.storeName)} ${escapeHtml(s.month)}</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; }
  .eyebrow { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  h1 { font-size: 18pt; font-weight: 600; margin: 1mm 0 1mm; }
  .ref { color: #555; font-size: 9pt; margin-bottom: 8mm; }
  .amount { font-size: 28pt; font-weight: 600; margin: 0; }
  .status { font-size: 11pt; margin: 1mm 0 8mm; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6mm; }
  td { border-top: 1px solid #ddd; padding: 2mm 0; vertical-align: top; }
  .n { text-align: right; white-space: nowrap; padding-left: 6mm; }
  .calc { color: #555; font-size: 9pt; }
  tr.total td { border-top: 2px solid #111; font-weight: 600; }
  .facts { font-size: 9.5pt; color: #333; }
</style>
</head>
<body>
<div class="eyebrow">Avräkning · ${escapeHtml(monthText(s.month))}</div>
<h1>${escapeHtml(s.storeName)}</h1>
<div class="ref">Från ${escapeHtml(doc.organizationName)} · ref. ${escapeHtml(doc.reference)}</div>
<p class="amount">${escapeHtml(krText(Math.abs(doc.amountOre)))}</p>
<p class="status">${escapeHtml(status)}</p>
<table>
${rows}
<tr class="total"><td>${totalLabel}</td><td class="n">${escapeHtml(krText(Math.abs(doc.amountOre)))}</td></tr>
</table>
<p class="facts">Avtal: ${escapeHtml(s.modelText)}</p>
<p class="facts">Försäljning inkl. moms: ${escapeHtml(krText(s.salesInclVatOre))} · ${escapeHtml(String(s.orders))} köp.</p>
</body>
</html>`;
}
