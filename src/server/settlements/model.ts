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

import { advanceLine, advanceTotal, type AdvancePart } from "./advance";

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

// ---------------------------------------------------------------------------
// Betalt mot rapporten mot dagens uträkning, och rättelser
// ---------------------------------------------------------------------------

/**
 * En rättelse som ligger på en avräkning: skillnaden mellan det som betalades för en
 * tidigare månad och vad den månaden blir med dagens underlag. Ägaren lägger dit den med
 * ett klick; den står som en egen rad i uträkningen och ingår i beloppet.
 */
export interface SettlementCorrection {
  /** Den betalda avräkningen som rättas. */
  readonly sourceId: string;
  readonly month: IsoMonth;
  /** Skillnaden (plus = butiken ska ha mer). */
  readonly amountOre: number;
  readonly paidOre: number;
  readonly liveOre: number;
  /** ISO-tid. */
  readonly at: string;
  readonly by: string | null;
}

const correctionSchema = z.object({
  sourceId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  amountOre: z.number().int(),
  paidOre: z.number().int(),
  liveOre: z.number().int(),
  at: z.string(),
  by: z.string().nullable(),
});

/** Läser sparade rättelser (store_settlements.corrections); ogiltiga rader hoppas över. */
export function parseCorrections(value: unknown): SettlementCorrection[] {
  if (!Array.isArray(value)) return [];
  const out: SettlementCorrection[] = [];
  for (const e of value) {
    const parsed = correctionSchema.safeParse(e);
    if (parsed.success) out.push(parsed.data as SettlementCorrection);
  }
  return out;
}

/** Rättelsen som en rad i uträkningen: "Rättelse för oktober 2026". */
export function correctionStep(c: SettlementCorrection): SettlementStep {
  return {
    label: `Rättelse för ${monthText(c.month)}`,
    calculation: `Betalt ${krText(c.paidOre)}, rätt belopp ${krText(c.liveOre)}`,
    amountOre: c.amountOre,
  };
}

/** Uträkningen med rättelserna som egna rader sist, och summan med dem. */
export function withCorrections(
  statement: SettlementStatement,
  corrections: readonly SettlementCorrection[],
): SettlementStatement {
  if (corrections.length === 0) return statement;
  return {
    ...statement,
    steps: [...statement.steps, ...corrections.map(correctionStep)],
    totalOre: statement.totalOre + correctionsTotal(corrections),
  };
}

export function correctionsTotal(corrections: readonly SettlementCorrection[]): number {
  return corrections.reduce((n, c) => n + c.amountOre, 0);
}

/**
 * Skillnaden som återstår för en betald avräkning: dagens uträkning − betalt − det som
 * redan lagts som rättelse på en senare avräkning. 0 = inget att göra.
 */
export function paidDifference(row: {
  paidOre: number;
  liveOre: number;
  correctedOre: number;
}): number {
  return row.liveOre - row.paidOre - row.correctedOre;
}

/** "+790,20 kr" / "−12,00 kr" (plus = butiken ska ha mer). */
export function signedKr(ore: number): string {
  return `${ore < 0 ? "−" : "+"}${krText(Math.abs(ore))}`;
}

/**
 * Raden under en betald avräkning när beloppen skiljer sig, viktigast först:
 * "Betalt 8 388,08 kr. Rapporten butiken fick: 8 072,18 kr. Dagens uträkning: 9 178,28 kr."
 * null när allt stämmer.
 */
export function paidCompareLine(row: {
  paidOre: number;
  reportOre: number | null;
  liveOre: number | null;
  correctedOre: number;
  /** Rättelser som ligger på avräkningen (ingår i betalt och i dagens uträkning). */
  correctionsOre?: number;
}): string | null {
  const reportPay = row.reportOre === null ? null : row.reportOre + (row.correctionsOre ?? 0);
  const reportDiffers = reportPay !== null && reportPay !== row.paidOre;
  const liveDiffers = row.liveOre !== null && row.liveOre - row.correctedOre !== row.paidOre;
  if (!reportDiffers && !liveDiffers) return null;
  const parts = [`Betalt ${krText(row.paidOre)}.`];
  if (row.reportOre !== null) parts.push(`Rapporten butiken fick: ${krText(row.reportOre)}.`);
  if (row.liveOre !== null) parts.push(`Dagens uträkning: ${krText(row.liveOre)}.`);
  return parts.join(" ");
}

/** "Butiken ska ha 790,20 kr till." / "Butiken har fått 12,00 kr för mycket." */
export function paidDifferenceLine(differenceOre: number): string {
  return differenceOre > 0
    ? `Butiken ska ha ${krText(differenceOre)} till.`
    : `Butiken har fått ${krText(-differenceOre)} för mycket.`;
}

/**
 * Frågan när en avräkning markeras som betald och rapporten butiken fick säger ett annat
 * belopp: "Rapporten butiken fick säger 8 072,18 kr. Dagens uträkning säger 8 388,08 kr.
 * Vilket belopp har du betalat?"
 */
export function paidWhichQuestion(reportOre: number, liveOre: number): string {
  return `Rapporten butiken fick säger ${krText(reportOre)}. Dagens uträkning säger ${krText(liveOre)}. Vilket belopp har du betalat?`;
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
  /**
   * Betalningar i förskott för månaden (./advance.ts). En obetald visar dem som avdrag och
   * "Kvar att betala"; en betald har dem med i det som betalades (en rad under tabellen).
   */
  readonly advances?: readonly AdvancePart[];
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
  // Förskott: dras av på en obetald (inte när beloppet inte går att räkna).
  const advances = (doc.advances ?? []).filter((a) => a.amountOre > 0);
  const advanceOre = advanceTotal(advances);
  const deduct = state !== "paid" && !doc.blocked && advanceOre > 0;
  const leftOre = doc.amountOre - advanceOre;
  const shownOre = deduct ? Math.max(0, leftOre) : Math.abs(doc.amountOre);
  const shownStatus = deduct && leftOre <= 0 ? "Redan betalt i förskott" : status;
  const advanceRows = deduct
    ? `<tr><td><div>Redan betalt i förskott</div><div class="calc">${escapeHtml(
        advances.map((a) => `${dayText(a.start, a.end)}, betalt ${dateText(a.paidOn)}`).join("; "),
      )}</div></td><td class="n">−${escapeHtml(krText(advanceOre))}</td></tr>
<tr class="total"><td>${leftOre < 0 ? "För mycket betalt" : "Kvar att betala"}</td><td class="n">${escapeHtml(krText(Math.abs(leftOre)))}</td></tr>`
    : "";
  const advanceFact =
    !deduct && state === "paid" && advanceOre > 0
      ? `<p class="facts">${escapeHtml(`${advanceLine(advances)}. Det ingår i det som betalades.`)}</p>`
      : deduct && leftOre < 0
        ? `<p class="facts">${escapeHtml(paidDifferenceLine(leftOre))}</p>`
        : "";
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
<p class="amount">${escapeHtml(krText(shownOre))}</p>
<p class="status">${escapeHtml(shownStatus)}</p>
<table>
${rows}
<tr class="total"><td>${deduct ? "Avräkningen" : totalLabel}</td><td class="n">${escapeHtml(krText(Math.abs(doc.amountOre)))}</td></tr>
${advanceRows}
</table>
${advanceFact}
<p class="facts">Avtal: ${escapeHtml(s.modelText)}</p>
<p class="facts">Försäljning inkl. moms: ${escapeHtml(krText(s.salesInclVatOre))} · ${escapeHtml(String(s.orders))} köp.</p>
</body>
</html>`;
}

/** "1–14 november 2026" / "14 oktober–14 november 2026" (en del ligger alltid i en månad). */
function dayText(start: IsoDate, end: IsoDate): string {
  if (start === end) return dateText(start);
  return `${Number(start.slice(8, 10))}–${dateText(end)}`;
}
