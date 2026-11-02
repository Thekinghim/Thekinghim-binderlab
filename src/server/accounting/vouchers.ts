/**
 * Verifikationerna för en månad, så att varje krona går att följa från automat till bank.
 *
 * Grunden är @/reports (sie4Verifications): dagskassa per dag (D avräkning 1580, K försäljning,
 * K moms), butiksersättning och inköpsvärde. Här läggs två saker till, med samma kontering
 * oavsett bokföringsprogram:
 *
 * 1. En verifikation per utbetalning från leverantören, daterad dagen pengarna kom in:
 *      debet  bank (bank)                  utbetalt belopp
 *      debet  kortavgifter (card_fees)     leverantörens faktiska avgifter
 *      debet  försäljning (sales)          återbetalningar exkl. moms
 *      debet  utgående moms (vat_out)      momsen i återbetalningarna
 *      kredit avräkning (settlement)       utbetalt + avgifter + återbetalningar
 *    Efter utbetalningen står bara den oförklarade skillnaden kvar på avräkningskontot (1580),
 *    samma belopp som avstämningen visar.
 * 2. För dagar som en importerad utbetalning täcker bokförs ingen uppskattad kortavgift i
 *    dagskassan (inställningen card_fee_bp): de faktiska avgifterna bokförs vid utbetalningen,
 *    och samma avgift ska inte bokföras två gånger.
 *
 * Verifikationerna sorteras på datum och numreras fortlöpande från `firstNumber` (räknat över
 * räkenskapsåret av ./service.ts). SIE-filen skrivs med samma format som @/reports (PC8, CP437).
 *
 * Rena funktioner utan databas.
 */

import {
  CALC_VERSION,
  DomainError,
  inPeriod,
  vatOfGross,
  type IsoDate,
  type Period,
} from "@/domain";
import {
  encodeCp437,
  periodText,
  sie4Verifications,
  sieAmount,
  sieString,
  type AccountantReport,
  type LedgerAccount,
  type Sie4Transaction,
  type Sie4Verification,
} from "@/reports";

/** Bankkontot enligt BAS när kontoplanen saknar nyckeln `bank`. Visas som ett påpekande. */
export const DEFAULT_BANK_ACCOUNT: LedgerAccount = {
  key: "bank",
  account: "1930",
  name: "Företagskonto/checkkonto/affärskonto",
};

/** En utbetalning att bokföra. */
export interface PayoutForBooking {
  readonly reference: string;
  readonly period: Period;
  /** Dagen pengarna kom in (eller periodens sista dag om leverantören inte angav den). */
  readonly paidOn: IsoDate;
  readonly amountOre: number;
  readonly feesOre: number;
  /** Återbetalningar som leverantören drog (eller de vi känner till, om leverantören inte angav). */
  readonly refundsOre: number;
}

export interface MonthVoucherInput {
  /** Bokföringsrapporten för månaden (@/reports buildAccountantReport). */
  readonly report: AccountantReport;
  /** Utbetalningar (ej arkiverade) vars period överlappar månaden eller som betalades i den. */
  readonly payouts: readonly PayoutForBooking[];
  readonly accounts: readonly LedgerAccount[];
  readonly fiscalYear: Period;
  readonly series: string;
  readonly firstNumber: number;
}

export interface MonthVouchers {
  readonly verifications: Sie4Verification[];
  /** Konton som används (för #KONTO i SIE-filen och tabellen per konto). */
  readonly accounts: LedgerAccount[];
  /** Sant om bankkontot saknades i kontoplanen och BAS 1930 användes. */
  readonly bankFallback: boolean;
  /** Dagar i månaden där den uppskattade kortavgiften ersatts av utbetalningens avgifter. */
  readonly daysWithActualFees: number;
}

function sameNumberAccounts(accounts: readonly LedgerAccount[]): Map<string, LedgerAccount> {
  const map = new Map<string, LedgerAccount>();
  for (const a of accounts) map.set(a.key, a);
  return map;
}

/**
 * Månadens verifikationer (se filhuvudet). Kastar `DomainError` om ett konto saknas eller en
 * verifikation ligger utanför räkenskapsåret.
 */
export function monthVouchers(input: MonthVoucherInput): MonthVouchers {
  const { report, fiscalYear } = input;
  const month = report.period;
  const byKey = sameNumberAccounts(input.accounts);
  const bankFallback = !byKey.has("bank");
  const accounts = bankFallback ? [...input.accounts, DEFAULT_BANK_ACCOUNT] : [...input.accounts];
  const keyed = sameNumberAccounts(accounts);
  const need = (key: string, why: string): string => {
    const a = keyed.get(key);
    if (!a) throw new DomainError("invalid_input", `Konto för ${key} saknas (behövs för ${why}).`);
    return a.account;
  };

  // 2. Dagar som en utbetalning täcker: ingen uppskattad avgift i dagskassan.
  const covered = (date: IsoDate) => input.payouts.some((p) => inPeriod(date, p.period));
  let daysWithActualFees = 0;
  const days = report.days.map((d) => {
    if (d.feesOre === 0 || !covered(d.date)) return d;
    daysWithActualFees += 1;
    return { ...d, feesOre: 0 };
  });
  const base = sie4Verifications(
    { ...report, days },
    {
      company: "",
      ledgerAccounts: input.accounts,
      fiscalYear,
      verificationSeries: input.series,
      firstVerificationNumber: 1,
    },
  );

  // 1. En verifikation per utbetalning som kom in i månaden.
  const payoutVouchers: Sie4Verification[] = [];
  const paid = input.payouts
    .filter((p) => inPeriod(p.paidOn, month))
    .sort((a, b) =>
      a.paidOn !== b.paidOn
        ? a.paidOn < b.paidOn
          ? -1
          : 1
        : a.reference < b.reference
          ? -1
          : a.reference > b.reference
            ? 1
            : 0,
    );
  for (const p of paid) {
    if (p.paidOn < fiscalYear.start || p.paidOn > fiscalYear.end) {
      throw new DomainError(
        "invalid_period",
        `Utbetalningen ${p.reference} (${p.paidOn}) ligger utanför räkenskapsåret.`,
      );
    }
    const refundVat = vatOfGross(p.refundsOre, report.vatRateBp);
    const rows: Sie4Transaction[] = [
      { account: need("bank", "utbetalningar"), amountOre: p.amountOre },
    ];
    if (p.feesOre !== 0) {
      rows.push({ account: need("card_fees", "leverantörens avgifter"), amountOre: p.feesOre });
    }
    if (p.refundsOre !== 0) {
      rows.push({
        account: need("sales", "återbetalningar"),
        amountOre: p.refundsOre - refundVat,
      });
      if (refundVat !== 0) {
        rows.push({ account: need("vat_out", "moms på återbetalningar"), amountOre: refundVat });
      }
    }
    rows.push({
      account: need("settlement", "utbetalningar"),
      amountOre: -(p.amountOre + p.feesOre + p.refundsOre),
    });
    const nonZero = rows.filter((r) => r.amountOre !== 0);
    if (nonZero.length === 0) continue;
    payoutVouchers.push({
      series: input.series,
      number: 0,
      date: p.paidOn,
      text: `Utbetalning ${p.reference} för ${periodText(p.period)}`,
      transactions: nonZero,
    });
  }

  // Datumordning; samma dag: dagskassa, utbetalning, butiksersättning, inköp (stabil sortering).
  const all = [...base, ...payoutVouchers].map((v, i) => ({ v, i }));
  all.sort((a, b) => (a.v.date !== b.v.date ? (a.v.date < b.v.date ? -1 : 1) : a.i - b.i));
  if (!Number.isSafeInteger(input.firstNumber) || input.firstNumber < 1) {
    throw new DomainError("invalid_input", "Första verifikationsnumret måste vara ≥ 1.");
  }
  const verifications = all.map(({ v }, i) => ({ ...v, number: input.firstNumber + i }));

  const usedNumbers = new Set(verifications.flatMap((v) => v.transactions.map((t) => t.account)));
  const used = new Map<string, LedgerAccount>();
  for (const a of accounts) if (usedNumbers.has(a.account) && !used.has(a.account)) used.set(a.account, a);
  return {
    verifications,
    accounts: [...used.values()].sort((a, b) =>
      a.account < b.account ? -1 : a.account > b.account ? 1 : 0,
    ),
    bankFallback: bankFallback && verifications.some((v) => v.transactions.some((t) => t.account === DEFAULT_BANK_ACCOUNT.account)),
    daysWithActualFees,
  };
}

/** SIE 4-filen (PC8/CP437) för verifikationerna. Raderna avslutas med CR LF. */
export function buildSieFile(args: {
  readonly company: string;
  readonly orgNumber?: string | null;
  readonly fiscalYear: Period;
  /** Dagen filen skapas (#GEN). */
  readonly generatedOn: IsoDate;
  readonly accounts: readonly LedgerAccount[];
  readonly verifications: readonly Sie4Verification[];
}): Uint8Array {
  const sieDate = (d: IsoDate) => d.replace(/-/g, "");
  const names = new Map<string, string>();
  for (const a of args.accounts) if (!names.has(a.account)) names.set(a.account, a.name);
  const used = new Set<string>();
  for (const v of args.verifications) {
    const sum = v.transactions.reduce((s, t) => s + t.amountOre, 0);
    if (sum !== 0) {
      throw new DomainError("invalid_input", `Verifikationen "${v.text}" balanserar inte (${sum} öre).`);
    }
    for (const t of v.transactions) used.add(t.account);
  }
  const lines: string[] = [
    "#FLAGGA 0",
    "#FORMAT PC8",
    "#SIETYP 4",
    `#PROGRAM ${sieString("Binderlab")} ${sieString(CALC_VERSION)}`,
    `#GEN ${sieDate(args.generatedOn)}`,
    `#FNAMN ${sieString(args.company)}`,
  ];
  if (args.orgNumber) lines.push(`#ORGNR ${args.orgNumber.replace(/\s/g, "")}`);
  lines.push(`#RAR 0 ${sieDate(args.fiscalYear.start)} ${sieDate(args.fiscalYear.end)}`);
  lines.push("#VALUTA SEK");
  for (const account of [...used].sort()) {
    lines.push(`#KONTO ${account} ${sieString(names.get(account) ?? account)}`);
  }
  for (const v of args.verifications) {
    lines.push(
      `#VER ${sieString(v.series)} ${sieString(String(v.number))} ${sieDate(v.date)} ${sieString(v.text)}`,
    );
    lines.push("{");
    for (const t of v.transactions) lines.push(`   #TRANS ${t.account} {} ${sieAmount(t.amountOre)}`);
    lines.push("}");
  }
  return new Uint8Array(encodeCp437(lines.join("\r\n") + "\r\n"));
}
