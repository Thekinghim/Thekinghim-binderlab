/**
 * Månadens verifikation som SIE 4I (importfil: bara #VER/#TRANS, inga saldon; PC8/CP437),
 * för import i Fortnox (Bokföring → Importera SIE). En verifikation per månad, daterad
 * månadens sista dag. Försäljning = försäljning inkl. moms − återbetalningar till kunder:
 *
 *   D avräkning (1580)          försäljning
 *   K försäljning VMB (3211)    försäljning − VMB-moms
 *   K utgående moms VMB (2616)  VMB-moms (när marginalen är positiv)
 *   D kortavgifter (6040)       kortavgifter            K avräkning (1580)
 *   D butikernas andel (6090)   per butik               K skuld till butikerna (2990)
 *   D hyra (5010)               per butik               K skuld till butikerna (2990)
 *
 * Inköpen bokförs inte här: de bokförs från leverantörsfakturorna (kvittona i paketet).
 * Ett negativt belopp byter sida på raden. Rader med 0 tas inte med. Rena funktioner.
 */

import { monthEnd } from "@/domain";
import { encodeCp437, monthText, sieAmount, sieString } from "@/reports";

import { netSales, type MonthBook } from "./month";
import { accountName, type AccountPlan, type PlanKey } from "./plan";

export interface VerificationRow {
  readonly key: PlanKey;
  readonly account: string;
  /** Positivt = debet, negativt = kredit. */
  readonly amountOre: number;
  readonly text: string;
}

export interface MonthVerification {
  readonly series: string;
  readonly number: number;
  readonly date: string;
  readonly text: string;
  readonly rows: readonly VerificationRow[];
}

/** Kastar om raderna inte balanserar (summan ≠ 0). */
export function assertBalanced(rows: readonly { amountOre: number }[]): void {
  let sum = 0;
  for (const r of rows) {
    if (!Number.isSafeInteger(r.amountOre)) throw new RangeError("Beloppen ska vara heltal i öre.");
    sum += r.amountOre;
  }
  if (sum !== 0) throw new RangeError(`Verifikationen balanserar inte (${sum} öre).`);
}

export function monthVerification(
  book: MonthBook,
  plan: AccountPlan,
  series: string,
  number: number,
): MonthVerification {
  if (!/^[A-Z0-9]{1,6}$/.test(series)) throw new RangeError("Ogiltig verifikationsserie.");
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError("Ogiltigt nummer.");
  const name = monthText(book.month);
  const rows: VerificationRow[] = [];
  const add = (key: PlanKey, amountOre: number, text: string) => {
    if (amountOre !== 0) rows.push({ key, account: plan[key], amountOre, text: text.slice(0, 80) });
  };
  const vat = book.vmb.vatOre;
  const sales = netSales(book);
  add("settlement", sales, `Försäljning automater ${name}`);
  add("sales_vmb", -(sales - vat), `Försäljning VMB ${name}`);
  add("vat_vmb", -vat, `VMB-moms ${name}`);
  add("card_fees", book.cardFeesOre, `Kortavgifter ${name}`);
  add("settlement", -book.cardFeesOre, `Kortavgifter ${name}`);
  for (const s of book.stores) {
    add("store_share", s.shareOre, `Andel ${s.name}`);
    add("rent", s.rentOre, `Hyra ${s.name}`);
    add("store_payable", -s.totalOre, `Att betala ${s.name}`);
  }
  assertBalanced(rows);
  return {
    series,
    number,
    date: monthEnd(book.month),
    text: `Binderlab ${name}`,
    rows,
  };
}

function sieDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`Ogiltigt datum ${date}.`);
  return date.replace(/-/g, "");
}

export interface SieFileInput {
  readonly company: string;
  readonly orgNumber: string | null;
  readonly fiscalYear: { readonly start: string; readonly end: string };
  readonly plan: AccountPlan;
  readonly verifications: readonly MonthVerification[];
  /** #GEN. */
  readonly generatedOn: string;
  readonly program?: string;
}

/**
 * SIE 4I-filen som text (före kodning). Raderna avslutas med CR LF. Verifikationer utan rader
 * tas inte med (Fortnox tar inte emot tomma verifikationer).
 */
export function buildSieText(input: SieFileInput): string {
  const verifications = input.verifications.filter((v) => v.rows.length > 0);
  for (const v of verifications) {
    assertBalanced(v.rows);
    if (v.date < input.fiscalYear.start || v.date > input.fiscalYear.end) {
      throw new RangeError(`Verifikationen ${v.date} ligger utanför räkenskapsåret.`);
    }
  }
  const lines = [
    "#FLAGGA 0",
    "#FORMAT PC8",
    "#SIETYP 4",
    `#PROGRAM ${sieString(input.program ?? "Binderlab")} ${sieString("1")}`,
    `#GEN ${sieDate(input.generatedOn)}`,
    `#FNAMN ${sieString(input.company)}`,
  ];
  if (input.orgNumber) lines.push(`#ORGNR ${input.orgNumber}`);
  lines.push(
    `#RAR 0 ${sieDate(input.fiscalYear.start)} ${sieDate(input.fiscalYear.end)}`,
    "#KPTYP BAS2014",
    "#VALUTA SEK",
  );
  const used = new Map<string, string>();
  for (const v of verifications) {
    for (const r of v.rows)
      if (!used.has(r.account)) used.set(r.account, accountName(input.plan, r.key));
  }
  for (const a of [...used.keys()].sort()) lines.push(`#KONTO ${a} ${sieString(used.get(a)!)}`);
  for (const v of verifications) {
    lines.push(
      `#VER ${sieString(v.series)} ${sieString(String(v.number))} ${sieDate(v.date)} ${sieString(v.text)}`,
      "{",
    );
    for (const r of v.rows) {
      lines.push(
        `   #TRANS ${r.account} {} ${sieAmount(r.amountOre)} ${sieDate(v.date)} ${sieString(r.text)}`,
      );
    }
    lines.push("}");
  }
  return lines.join("\r\n") + "\r\n";
}

/** SIE 4I-filen kodad i CP437 (PC8). */
export function buildSieFile(input: SieFileInput): Uint8Array {
  return encodeCp437(buildSieText(input));
}
