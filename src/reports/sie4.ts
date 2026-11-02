/**
 * Export av bokföringsrapporten som SIE typ 4 (verifikationer), kodad i CP437 ("PC8").
 *
 * Filen innehåller:
 *   #FLAGGA 0, #FORMAT PC8, #SIETYP 4, #PROGRAM, #GEN, #FNAMN, (#ORGNR), #RAR 0, #VALUTA SEK,
 *   #KONTO för varje konto som används, och #VER med #TRANS-rader.
 *
 * Verifikationer (alla balanserade, summan av raderna är 0):
 * 1. En per dag med försäljning ("dagskassa"):
 *      debet  avräkning (settlement)   belopp inkl. moms
 *      kredit försäljning (sales)      belopp exkl. moms
 *      kredit utgående moms (vat_out)  moms (bara när momsen > 0)
 *    och när kortavgifterna > 0:
 *      debet  kortavgifter (card_fees) avgifter
 *      kredit avräkning (settlement)   avgifter
 * 2. Butiksersättning, en per butik med ersättning, daterad periodens sista dag
 *    (bara när kontot `store_payable` finns):
 *      debet  provision (store_commission), debet hyra (rent), kredit skuld (store_payable)
 * 3. Inköpsvärde för sålda pack, daterad periodens sista dag (bara när kontot `cogs` finns):
 *      debet  varuinköp (cogs), kredit lager (inventory)
 *
 * Belopp skrivs i kronor med punkt som decimaltecken och två decimaler ("4900.00",
 * "-4900.00"), uträknade med heltal från öre.
 */

import {
  CALC_VERSION,
  DomainError,
  assertIsoDate,
  assertPeriod,
  type IsoDate,
  type Period,
} from "@/domain";
import type { AccountantReport } from "./accountant-report";
import { encodeCp437 } from "./cp437";
import { periodText, shortDateText } from "./text";

/** Nycklar för konton (samma som `ledger_accounts.key` i datamodellen). */
export type LedgerAccountKey =
  | "sales"
  | "vat_out"
  | "settlement"
  | "card_fees"
  | "store_commission"
  | "rent"
  | "store_payable"
  | "cogs"
  | "inventory";

/** Ett konto i kontoplanen. */
export interface LedgerAccount {
  readonly key: LedgerAccountKey | string;
  /** Kontonummer, t.ex. "3001". */
  readonly account: string;
  readonly name: string;
}

/** Inställningar för SIE-exporten. */
export interface Sie4Options {
  readonly company: string;
  readonly orgNumber?: string | null;
  readonly ledgerAccounts: readonly LedgerAccount[];
  /** Räkenskapsåret (#RAR 0). Alla verifikationer måste ligga inom det. */
  readonly fiscalYear: Period;
  /** Verifikationsserie, t.ex. "A". */
  readonly verificationSeries: string;
  /** Första verifikationsnumret. Standard 1. */
  readonly firstVerificationNumber?: number;
  /** Datum i #GEN. Standard: rapportperiodens sista dag (så att filen blir deterministisk). */
  readonly generatedOn?: IsoDate;
}

/** En transaktionsrad. Positivt = debet, negativt = kredit. */
export interface Sie4Transaction {
  readonly account: string;
  readonly amountOre: number;
}

/** En verifikation. */
export interface Sie4Verification {
  readonly series: string;
  readonly number: number;
  readonly date: IsoDate;
  readonly text: string;
  readonly transactions: readonly Sie4Transaction[];
}

/** Öre som SIE-belopp: 490 050 → "4900.50", −12 → "-0.12". */
export function sieAmount(ore: number): string {
  if (!Number.isSafeInteger(ore)) {
    throw new DomainError("invalid_amount", `Beloppet måste vara ett heltal i öre, fick ${ore}.`);
  }
  const abs = Math.abs(ore);
  const rest = abs % 100;
  return `${ore < 0 ? "-" : ""}${(abs - rest) / 100}.${rest < 10 ? "0" : ""}${rest}`;
}

/** Text inom citattecken enligt SIE: citattecken och bakstreck skyddas, styrtecken tas bort. */
export function sieString(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sieDate(date: IsoDate): string {
  assertIsoDate(date);
  return date.replace(/-/g, "");
}

function accountMap(accounts: readonly LedgerAccount[]): Map<string, LedgerAccount> {
  const map = new Map<string, LedgerAccount>();
  for (const a of accounts) {
    if (!/^\d{1,10}$/.test(a.account)) {
      throw new DomainError(
        "invalid_input",
        `Kontot för ${a.key} måste vara ett kontonummer, fick "${a.account}".`,
      );
    }
    if (map.has(a.key)) throw new DomainError("invalid_input", `Kontot ${a.key} finns två gånger.`);
    map.set(a.key, a);
  }
  return map;
}

/**
 * Verifikationerna som exporten innehåller (se filhuvudet för konteringen). Rader med
 * beloppet 0 och verifikationer utan rader tas inte med. Kastar `DomainError` om ett
 * konto som behövs saknas eller om en verifikation hamnar utanför räkenskapsåret.
 */
export function sie4Verifications(
  report: AccountantReport,
  options: Sie4Options,
): Sie4Verification[] {
  assertPeriod(options.fiscalYear);
  const accounts = accountMap(options.ledgerAccounts);
  const need = (key: LedgerAccountKey, why: string): string => {
    const a = accounts.get(key);
    if (!a) throw new DomainError("invalid_input", `Konto för ${key} saknas (behövs för ${why}).`);
    return a.account;
  };
  const series = options.verificationSeries;
  if (!/^[A-Za-z0-9]{1,10}$/.test(series)) {
    throw new DomainError(
      "invalid_input",
      `Verifikationsserien måste vara bokstäver eller siffror, fick "${series}".`,
    );
  }
  let number = options.firstVerificationNumber ?? 1;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new DomainError(
      "invalid_input",
      `Första verifikationsnumret måste vara ett heltal ≥ 1, fick ${number}.`,
    );
  }
  const out: Sie4Verification[] = [];
  const add = (date: IsoDate, text: string, rows: Sie4Transaction[]): void => {
    const nonZero = rows.filter((r) => r.amountOre !== 0);
    if (nonZero.length === 0) return;
    const sum = nonZero.reduce((s, r) => s + r.amountOre, 0);
    if (sum !== 0) {
      throw new DomainError(
        "invalid_input",
        `Verifikationen "${text}" balanserar inte (${sum} öre).`,
      );
    }
    if (date < options.fiscalYear.start || date > options.fiscalYear.end) {
      throw new DomainError(
        "invalid_period",
        `Verifikationen ${date} ligger utanför räkenskapsåret.`,
      );
    }
    out.push({ series, number: number++, date, text, transactions: nonZero });
  };

  for (const d of report.days) {
    if (d.orders === 0 && d.grossOre === 0) continue;
    const settlement = need("settlement", "försäljning");
    const rows: Sie4Transaction[] = [
      { account: settlement, amountOre: d.grossOre },
      { account: need("sales", "försäljning"), amountOre: -d.netOre },
    ];
    if (d.vatOre !== 0) rows.push({ account: need("vat_out", "moms"), amountOre: -d.vatOre });
    if (d.feesOre !== 0) {
      rows.push({ account: need("card_fees", "kortavgifter"), amountOre: d.feesOre });
      rows.push({ account: settlement, amountOre: -d.feesOre });
    }
    const n = d.orders;
    add(d.date, `Försäljning ${shortDateText(d.date)} ${d.date.slice(0, 4)} (${n} order)`, rows);
  }

  const end = report.period.end;
  if (accounts.has("store_payable")) {
    for (const s of report.stores) {
      if (s.kind !== "store" || s.compensationOre === 0) continue;
      const rows: Sie4Transaction[] = [];
      if (s.commissionOre !== 0)
        rows.push({ account: need("store_commission", "provision"), amountOre: s.commissionOre });
      if (s.rentOre !== 0) rows.push({ account: need("rent", "hyra"), amountOre: s.rentOre });
      rows.push({
        account: need("store_payable", "butiksersättning"),
        amountOre: -s.compensationOre,
      });
      add(end, `Butiksersättning ${s.name} ${periodText(report.period)}`, rows);
    }
  }

  if (accounts.has("cogs") && report.totals.costOre !== 0) {
    add(end, `Inköpsvärde sålda pack ${periodText(report.period)}`, [
      { account: need("cogs", "inköp"), amountOre: report.totals.costOre },
      { account: need("inventory", "inköp"), amountOre: -report.totals.costOre },
    ]);
  }
  return out;
}

/** SIE 4-filen som text (före kodning). Raderna avslutas med CR LF. */
export function buildSie4Text(report: AccountantReport, options: Sie4Options): string {
  const verifications = sie4Verifications(report, options);
  const accounts = accountMap(options.ledgerAccounts);
  const used = new Set<string>();
  for (const v of verifications) for (const t of v.transactions) used.add(t.account);
  const byNumber = new Map<string, LedgerAccount>();
  for (const a of accounts.values()) if (!byNumber.has(a.account)) byNumber.set(a.account, a);

  const lines: string[] = [
    "#FLAGGA 0",
    "#FORMAT PC8",
    "#SIETYP 4",
    `#PROGRAM ${sieString("Binderlab")} ${sieString(CALC_VERSION)}`,
    `#GEN ${sieDate(options.generatedOn ?? report.period.end)}`,
    `#FNAMN ${sieString(options.company)}`,
  ];
  if (options.orgNumber) lines.push(`#ORGNR ${options.orgNumber.replace(/\s/g, "")}`);
  lines.push(`#RAR 0 ${sieDate(options.fiscalYear.start)} ${sieDate(options.fiscalYear.end)}`);
  lines.push("#VALUTA SEK");
  for (const account of [...used].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`#KONTO ${account} ${sieString(byNumber.get(account)!.name)}`);
  }
  for (const v of verifications) {
    lines.push(
      `#VER ${sieString(v.series)} ${sieString(String(v.number))} ${sieDate(v.date)} ${sieString(v.text)}`,
    );
    lines.push("{");
    for (const t of v.transactions)
      lines.push(`   #TRANS ${t.account} {} ${sieAmount(t.amountOre)}`);
    lines.push("}");
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Exporterar bokföringsrapporten som en SIE typ 4-fil kodad i CP437 (PC8).
 * Se filhuvudet för kontering och format.
 */
export function exportSie4(report: AccountantReport, options: Sie4Options): Buffer {
  return encodeCp437(buildSie4Text(report, options));
}
