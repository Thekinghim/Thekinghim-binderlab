/**
 * Texterna om Nayax månadsrapport på Ekonomi: vad Nayax betalar, vad som drogs och om det
 * stämmer med appens försäljning. Rena funktioner (inga beräkningar utöver summering av
 * rapportens egna rader), så att orden går att testa.
 */

import type { PayoutStatement, StatementDeduction } from "@/server/accounting/nayax-statement";
import { formatDate, formatNumber, NBSP } from "@/lib/format";

import { isoToDate, kr, sek } from "./view";

/** Baspunkter som procent: 400 → "4,0 %", 395 → "3,95 %", 0 → "0 %". */
export function pctBp(bp: number): string {
  if (bp === 0) return `0${NBSP}%`;
  return `${formatNumber(bp / 100, bp % 10 === 0 ? 1 : 2)}${NBSP}%`;
}

/** Kortavgiften i baspunkter av det Nayax betalar ut för, eller null när den är okänd. */
export function cardFeeBpOf(s: PayoutStatement): number | null {
  if (s.cardFeeOre === null || s.reimbursedOre <= 0) return null;
  return Math.round((s.cardFeeOre * 10_000) / s.reimbursedOre);
}

/** "Nayax betalar 72 330,48 kr senast 16 nov." */
export function nayaxPaysText(s: PayoutStatement, today: string): string {
  if (!s.payoutUntil) return `Nayax betalar ${kr(s.totalOre)}.`;
  const day = formatDate(isoToDate(s.payoutUntil), { year: "auto", now: isoToDate(today) });
  const verb = s.payoutUntil < today ? "betalade" : "betalar";
  return `Nayax ${verb} ${kr(s.totalOre)} senast ${day}${day.endsWith(".") ? "" : "."}`;
}

const sumOf = (list: readonly StatementDeduction[]) => list.reduce((n, d) => n + d.amountOre, 0);

/** "Sålt 76 245 kr, avgifter 3 089,80 kr (kortavgift 4,0 %), engångsavgift 824,72 kr." */
export function nayaxSoldText(s: PayoutStatement): string {
  const bp = cardFeeBpOf(s);
  const onlyCard = s.cardFeeOre === s.feesOre;
  const share = bp === null ? "" : ` (${onlyCard ? "" : "kortavgift "}${pctBp(bp)})`;
  const parts = [`Sålt ${sek(s.reimbursedOre)}`, `avgifter ${kr(s.feesOre)}${share}`];
  const adjustments = s.deductions.filter((d) => d.kind === "adjustment");
  const adjusted = sumOf(adjustments);
  if (adjusted > 0) {
    parts.push(`${adjustments.length === 1 ? "engångsavgift" : "engångsavgifter"} ${kr(adjusted)}`);
  } else if (adjusted < 0) {
    parts.push(`tillägg ${kr(-adjusted)}`);
  }
  const other = (kind: StatementDeduction["kind"], word: string) => {
    const ore = sumOf(s.deductions.filter((d) => d.kind === kind));
    if (ore !== 0) parts.push(`${word} ${kr(ore)}`);
  };
  other("vat", "moms");
  other("rolling", "saldo från förr");
  other("capital", "Nayax Capital");
  return `${parts.join(", ")}.`;
}

const DEDUCTION_LABEL: Record<StatementDeduction["kind"], string> = {
  adjustment: "Engångsavgift hos Nayax",
  bank_fee: "Bankavgift hos Nayax",
  other_fee: "Annan avgift hos Nayax",
  vat: "Moms på avgifterna hos Nayax",
  rolling: "Saldo från förr hos Nayax",
  capital: "Nayax Capital",
};

/** "Engångsavgift hos Nayax: 824,72 kr (Onboarding fee)". Ett tillägg skrivs som tillägg. */
export function deductionText(d: StatementDeduction): string {
  const credit = d.kind === "adjustment" && d.amountOre < 0;
  const name = credit ? "Tillägg från Nayax" : DEDUCTION_LABEL[d.kind];
  // Bankavgiftens engelska namn säger inget mer än rubriken.
  const reason = d.reason && d.kind !== "bank_fee" ? ` (${d.reason})` : "";
  return `${name}: ${kr(credit ? -d.amountOre : d.amountOre)}${reason}`;
}

/** Så stor skillnad i försäljning räknas som avrundning (1 kr). */
export const SALES_ROUNDING_ORE = 100;

/** Om Nayax försäljning är densamma som appens för samma dagar. */
export function salesMatchText(nayaxOre: number, appOre: number): { ok: boolean; text: string } {
  const diff = nayaxOre - appOre;
  if (Math.abs(diff) <= SALES_ROUNDING_ORE) {
    return { ok: true, text: "Det stämmer med appens försäljning." };
  }
  return {
    ok: false,
    text: `Det stämmer inte med appen. Appen har sålt för ${kr(appOre)} samma dagar. Nayax har ${kr(
      nayaxOre,
    )}. Skillnad ${kr(Math.abs(diff))}.`,
  };
}

/** "Sega Gubben 72 511 kr · Ny 3 3 734 kr" */
export function devicesText(s: PayoutStatement): string {
  return s.devices.map((d) => `${d.name} ${sek(d.amountOre)}`).join(" · ");
}

/** "Nayax tar 4,0 % i kortavgift. Appen räknar med 0 %." och knappens text. */
export function cardFeeHelp(
  statementBp: number | null,
  settingBp: number,
): { text: string; button: string; done: string } | null {
  if (statementBp === null || statementBp === settingBp) return null;
  return {
    text: `Nayax tar ${pctBp(statementBp)} i kortavgift. Appen räknar med ${pctBp(settingBp)}.`,
    button: `Ändra till ${pctBp(statementBp)}`,
    done: `Appen räknar nu med ${pctBp(statementBp)} i kortavgift.`,
  };
}
