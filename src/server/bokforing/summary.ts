/**
 * Sammanfattningen i månadspaketet: en A4-sida (HTML som skrivs ut till PDF med Chromium,
 * src/server/pdf/render.ts). Om VMB tillämpades (rubriken), VMB-uträkningen steg för steg
 * när VMB är på, butikernas andel per butik, resultatet och verifikationen. Ren funktion:
 * samma indata ger samma HTML.
 */

import { dateText, krText, monthText } from "@/reports";

import { PURCHASE_BASIS_LABEL, type MonthBook, type StoreShare } from "./month";
import type { MonthVerification } from "./sie";

export interface SummaryInput {
  readonly company: string;
  readonly orgNumber: string | null;
  readonly book: MonthBook;
  readonly verification: MonthVerification;
  readonly accountNames: ReadonlyMap<string, string>;
  readonly receipts: number;
  readonly generatedOn: string;
  readonly sentOn: string | null;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
const kr = (ore: number) => esc(krText(ore, "always"));

/** Avtalet i butikstabellen: vinstdelning med eller utan VMB-avdrag före delningen. */
function splitText(split: StoreShare["split"], rentOre: number): string {
  if (!split) return rentOre !== 0 ? "Provision och hyra" : "Provision";
  return split.vmbBeforeSplit
    ? `Vinstdelning, VMB-moms ${kr(split.vmbVatOre)} dragen före delning`
    : "Vinstdelning";
}

function stepRows(rows: readonly [string, string, boolean?][]): string {
  return rows
    .map(
      ([label, value, total]) =>
        `<tr${total ? ' class="total"' : ""}><td>${esc(label)}</td><td class="n">${value}</td></tr>`,
    )
    .join("");
}

export function summaryHtml(input: SummaryInput): string {
  const b = input.book;
  const v = b.vmb;
  const name = monthText(b.month);
  // Rader som börjar med "− " visar beloppet utan tecken ("− Inköp 1 234,00 kr").
  const vmbSteps: [string, string, boolean?][] = [
    ["Försäljning inkl. moms", kr(b.salesInclVatOre)],
    ...(b.refundsOre !== 0
      ? ([["− Återbetalningar till kunder", kr(b.refundsOre)]] as [string, string][])
      : []),
    [`− Inköp (${PURCHASE_BASIS_LABEL[b.purchaseBasis].toLowerCase()})`, kr(v.purchasesOre)],
    ["− Underskott från förra månaden", kr(v.carryInOre)],
    ["= Marginal", kr(v.marginOre), true],
    [
      v.vatOre > 0
        ? "VMB-moms: 20 % av marginalen (25/125)"
        : "VMB-moms (marginalen är inte positiv)",
      kr(v.vatOre),
      true,
    ],
  ];
  if (v.carryOutOre > 0) vmbSteps.push(["Underskott till nästa månad", kr(v.carryOutOre)]);
  const resultSteps: [string, string, boolean?][] = [
    ["Försäljning inkl. moms", kr(b.salesInclVatOre)],
    ...(b.refundsOre !== 0
      ? ([["− Återbetalningar till kunder", kr(b.refundsOre)]] as [string, string][])
      : []),
    ...(b.vmbEnabled ? ([["− VMB-moms", kr(v.vatOre)]] as [string, string][]) : []),
    ["− Inköp", kr(b.purchasesOre)],
    ["− Kortavgifter", kr(b.cardFeesOre)],
    ["− Butikernas andel", kr(b.storeShareOre)],
    ["= Resultat", kr(b.resultOre), true],
  ];
  // Hyreskolumnen bara när någon butik har hyra i månaden (de flesta avtal har ingen).
  const rent = b.stores.some((x) => x.rentOre !== 0);
  const rentCell = (ore: number) => (rent ? `<td class="n">${kr(ore)}</td>` : "");
  const stores = b.stores.length
    ? b.stores
        .map(
          (s) =>
            `<tr><td>${esc(s.name)}</td><td>${splitText(s.split, s.rentOre)}</td><td class="n">${s.orders}</td><td class="n">${kr(s.salesInclVatOre)}</td><td class="n">${kr(s.shareOre)}</td>${rentCell(s.rentOre)}<td class="n">${kr(s.totalOre)}</td></tr>`,
        )
        .join("") +
      `<tr class="total"><td>Summa</td><td></td><td class="n">${b.stores.reduce((s, x) => s + x.orders, 0)}</td><td class="n">${kr(b.stores.reduce((s, x) => s + x.salesInclVatOre, 0))}</td><td class="n">${kr(b.stores.reduce((s, x) => s + x.shareOre, 0))}</td>${rentCell(b.stores.reduce((s, x) => s + x.rentOre, 0))}<td class="n">${kr(b.storeShareOre)}</td></tr>`
    : `<tr><td colspan="${rent ? 7 : 6}">Inga butiker med försäljning.</td></tr>`;
  const ver = input.verification.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.account)}</td><td>${esc(input.accountNames.get(r.account) ?? "")}</td><td>${esc(r.text)}</td><td class="n">${r.amountOre > 0 ? kr(r.amountOre) : ""}</td><td class="n">${r.amountOre < 0 ? kr(-r.amountOre) : ""}</td></tr>`,
    )
    .join("");
  const debit = input.verification.rows.reduce((s, r) => s + Math.max(0, r.amountOre), 0);
  const notes: string[] = [];
  if (b.profitSplitUnpricedOrders > 0) {
    notes.push(
      `Butikernas andel är inte färdigräknad: ${b.profitSplitUnpricedOrders} order hos butiker med vinstdelning saknar inköpspris. Bokför inte månaden förrän priserna finns.`,
    );
  }
  if (input.verification.rows.length === 0) {
    notes.push("Inga transaktioner i månaden: ingen verifikation att importera.");
  }
  if (b.unpricedOrders > 0) {
    notes.push(`${b.unpricedOrders} order saknar inköpspris och har inget inköpsvärde.`);
  }
  if (
    b.vmbEnabled &&
    b.purchaseBasis === "received_purchases" &&
    b.purchasesOre === 0 &&
    b.salesInclVatOre > 0
  ) {
    notes.push("Inga mottagna inköp i månaden: hela försäljningen är marginal.");
  }

  return `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"><title>Bokföring ${esc(name)}</title>
<style>
@page { size: A4; margin: 14mm 14mm 12mm; }
* { box-sizing: border-box; }
body { font: 9.5pt/1.35 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; }
h1 { font-size: 15pt; margin: 0 0 2px; }
h2 { font-size: 10pt; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: .04em; color: #444; }
.meta { color: #555; margin: 0 0 6px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 2px 4px; border-bottom: 1px solid #e3e3e3; text-align: left; vertical-align: top; }
th { font-weight: 600; color: #444; border-bottom: 1px solid #999; }
.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.total td { font-weight: 700; border-top: 1px solid #999; }
.note { color: #555; font-size: 8.5pt; margin: 2px 0; }
footer { margin-top: 10px; color: #555; font-size: 8pt; }
</style></head>
<body class="bl-report">
<h1>Bokföring ${esc(name)}</h1>
<p class="meta">${esc(input.company)}${input.orgNumber ? ` · ${esc(input.orgNumber)}` : ""} · ${b.orders} order · ${b.vmbEnabled ? "med VMB" : "utan VMB"} · framtagen ${esc(dateText(input.generatedOn))}${input.sentOn ? ` · skickad ${esc(dateText(input.sentOn))}` : ""}</p>
${
  b.vmbEnabled
    ? `<div class="grid">
<section><h2>VMB-moms (samlad beräkning)</h2><table>${stepRows(vmbSteps)}</table></section>
<section><h2>Resultat</h2><table>${stepRows(resultSteps)}</table></section>
</div>`
    : `<div class="grid">
<section><h2>Resultat (utan VMB)</h2><table>${stepRows(resultSteps)}</table></section>
<section><h2>VMB</h2><p class="note">VMB i bokföringen är av: ingen VMB-moms och inget underskott i verifikationen.</p></section>
</div>`
}
${notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
<h2>Butikernas andel</h2>
<table><tr><th>Butik</th><th>Avtal</th><th class="n">Order</th><th class="n">Försäljning</th><th class="n">Andel</th>${rent ? '<th class="n">Hyra</th>' : ""}<th class="n">Att betala</th></tr>${stores}</table>
<h2>Verifikation ${esc(input.verification.series)} ${input.verification.number} · ${esc(dateText(input.verification.date))}</h2>
<table><tr><th>Konto</th><th>Namn</th><th>Text</th><th class="n">Debet</th><th class="n">Kredit</th></tr>${ver}
<tr class="total"><td colspan="3">Summa</td><td class="n">${kr(debit)}</td><td class="n">${kr(debit)}</td></tr></table>
<footer>Kvitton i paketet: ${input.receipts}. Inköpen bokförs från kvittona. Ingående moms på butikernas fakturor bokförs från fakturan. Kontoplanen och serien är ett förslag enligt BAS och kontrolleras av Talenom. Import: Fortnox → Bokföring → Importera SIE.</footer>
</body></html>`;
}
