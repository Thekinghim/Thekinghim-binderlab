/**
 * Tolkning av leverantörens utbetalningsfil (CSV) till utbetalningar och, om filen är en
 * specifikation, rader per order. Ren funktion utan databas, så att den kan testas.
 *
 * Två format känns igen på rubrikerna (svenska eller engelska, skiftläge och skiljetecken
 * spelar ingen roll):
 *
 * 1. Utbetalningar, en rad per utbetalning:
 *      Referens · Period från · Period till (eller Period: '2026-10' / '2026-10-01–2026-10-31')
 *      · Utbetald (dag) · Belopp (utbetalt) · Avgifter · Återbetalningar (valfri)
 * 2. Specifikation, en rad per order:
 *      Referens · Ordernummer · Belopp
 *
 * Belopp tolkas som text till öre (samma tolkning som orderimporten: "1 234,50", "1234.50",
 * "170 kr"), utan flyttal. Utbetalt belopp får vara negativt. Datum: ÅÅÅÅ-MM-DD, ÅÅÅÅ/MM/DD
 * eller ÅÅÅÅMMDD. Felrader stoppar inte filen men räknas och visas med radnummer.
 */

import { createHash } from "node:crypto";

import { parseAmountOre } from "@/import/amount";
import { parseCsvTable } from "@/import/csv-table";
import { ImportError } from "@/import/errors";
import { normalizeHeader } from "@/import/mapping";

export type PayoutFileFormat = "payouts" | "lines";

/** En utbetalning ur filen. */
export interface ParsedPayout {
  readonly lineNumber: number;
  readonly reference: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly paidOn: string | null;
  readonly amountOre: number;
  readonly feesOre: number;
  /** null = kolumnen saknas eller cellen är tom (leverantören anger inte återbetalningar). */
  readonly refundsOre: number | null;
  /** sha256 av de tolkade fälten: avslöjar om samma referens kommer igen med andra belopp. */
  readonly sourceHash: string;
}

/** En specifikationsrad (en order i en utbetalning). */
export interface ParsedPayoutLine {
  readonly lineNumber: number;
  readonly reference: string;
  readonly externalId: string;
  readonly amountOre: number;
}

export interface PayoutFileError {
  readonly lineNumber: number;
  readonly message: string;
}

export interface ParsedPayoutFile {
  readonly format: PayoutFileFormat;
  readonly payouts: ParsedPayout[];
  readonly lines: ParsedPayoutLine[];
  readonly errors: PayoutFileError[];
  /** Antal datarader (utan rubriken). */
  readonly rows: number;
}

type Field =
  | "reference"
  | "periodStart"
  | "periodEnd"
  | "period"
  | "paidOn"
  | "amount"
  | "fees"
  | "refunds"
  | "orderNo";

const SYNONYMS: Record<Field, string[]> = {
  reference: [
    "referens",
    "reference",
    "ref",
    "utbetalning",
    "utbetalningsid",
    "payout",
    "payoutid",
    "payoutno",
    "payoutreference",
    "settlementid",
    "settlementno",
    "verifikation",
  ],
  periodStart: [
    "periodfrån",
    "periodfran",
    "från",
    "fran",
    "periodstart",
    "from",
    "startdate",
    "start",
  ],
  periodEnd: ["periodtill", "till", "periodend", "to", "enddate", "end", "slut"],
  period: ["period", "månad", "manad", "month", "settlementperiod"],
  paidOn: [
    "utbetald",
    "utbetalningsdag",
    "utbetalningsdatum",
    "betaldag",
    "paidon",
    "paiddate",
    "payoutdate",
    "paymentdate",
    "valuedate",
    "datum",
    "date",
  ],
  amount: [
    "belopp",
    "utbetalt",
    "utbetaltbelopp",
    "netto",
    "amount",
    "payoutamount",
    "netamount",
    "net",
    "orderamount",
  ],
  fees: ["avgifter", "avgift", "fees", "fee", "commission", "servicefee"],
  refunds: ["återbetalningar", "återbetalning", "aterbetalningar", "refunds", "refund"],
  orderNo: ["ordernummer", "ordernr", "order", "orderno", "ordernumber", "orderid"],
};

const NORMALIZED: Record<Field, Set<string>> = Object.fromEntries(
  (Object.keys(SYNONYMS) as Field[]).map((f) => [f, new Set(SYNONYMS[f].map(normalizeHeader))]),
) as Record<Field, Set<string>>;

/** Rubrikerna som filen ska ha, för felmeddelanden och hjälptext. */
export const PAYOUT_FILE_COLUMNS = {
  payouts: [
    "Referens",
    "Period från",
    "Period till",
    "Utbetald",
    "Belopp",
    "Avgifter",
    "Återbetalningar (valfri)",
  ],
  lines: ["Referens", "Ordernummer", "Belopp"],
} as const;

/** Största fil (10 MB): en utbetalningsfil är liten. */
export const MAX_PAYOUT_FILE_BYTES = 10 * 1024 * 1024;

function columnIndex(headers: readonly string[]): Partial<Record<Field, number>> {
  const out: Partial<Record<Field, number>> = {};
  headers.forEach((h, i) => {
    const key = normalizeHeader(h);
    for (const f of Object.keys(NORMALIZED) as Field[]) {
      if (out[f] === undefined && NORMALIZED[f].has(key)) {
        out[f] = i;
        return;
      }
    }
  });
  return out;
}

const ISO = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/;

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "2026-10-31", "2026/10/31", "20261031" → "2026-10-31"; annars null. */
export function parsePayoutDate(input: string | undefined): string | null {
  const s = (input ?? "").trim().slice(0, 10);
  const m = ISO.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || y < 2000 || y > 2100) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** "2026-10" → hela oktober; "2026-10-01–2026-10-31" (även - eller "till") → intervallet. */
export function parsePayoutPeriod(
  input: string | undefined,
): { start: string; end: string } | null {
  const s = (input ?? "").trim();
  const month = /^(\d{4})[-/](\d{2})$/.exec(s);
  if (month) {
    const y = Number(month[1]);
    const mo = Number(month[2]);
    if (mo < 1 || mo > 12) return null;
    return { start: `${month[1]}-${month[2]}-01`, end: `${month[1]}-${month[2]}-${daysIn(y, mo)}` };
  }
  const range = /^(\S+)\s*(?:–|—|\.\.|\s-\s|\still\s|\sto\s)\s*(\S+)$/i.exec(s);
  if (range) {
    const start = parsePayoutDate(range[1]);
    const end = parsePayoutDate(range[2]);
    return start && end ? { start, end } : null;
  }
  return null;
}

/** Belopp som får vara negativt (utbetalt kan bli negativt när avgifter överstiger försäljningen). */
export function parseSignedOre(
  input: string | undefined,
): { ok: true; ore: number } | { ok: false; message: string } {
  const raw = (input ?? "").trim();
  const negative = /^[-−–]/.test(raw) || /^\(.*\)$/.test(raw);
  const body = raw.replace(/^[-−–]\s*/, "").replace(/^\((.*)\)$/, "$1");
  const parsed = parseAmountOre(body);
  if (!parsed.ok) return parsed;
  return { ok: true, ore: negative ? -parsed.ore : parsed.ore };
}

function hashPayout(p: Omit<ParsedPayout, "sourceHash" | "lineNumber">): string {
  return createHash("sha256")
    .update(
      [
        "p1",
        p.reference,
        p.periodStart,
        p.periodEnd,
        p.paidOn ?? "",
        String(p.amountOre),
        String(p.feesOre),
        p.refundsOre === null ? "" : String(p.refundsOre),
      ].join("\u001f"),
    )
    .digest("hex");
}

/**
 * Tolkar filen. Kastar `ImportError('validation')` om filen inte går att läsa alls (tom,
 * okänt format, saknade kolumner); enskilda felrader hamnar i `errors`.
 */
export function parsePayoutFile(content: string | Uint8Array): ParsedPayoutFile {
  if (typeof content !== "string" && content.byteLength > MAX_PAYOUT_FILE_BYTES) {
    throw new ImportError("file_too_large", "Filen är för stor (högst 10 MB).");
  }
  const table = parseCsvTable(content);
  const [header, ...records] = table.records;
  if (!header || records.length === 0) {
    throw new ImportError("validation", "Filen saknar rader. Exportera utbetalningarna på nytt.");
  }
  const col = columnIndex(header.cells);
  const format: PayoutFileFormat | null =
    col.orderNo !== undefined
      ? "lines"
      : col.periodStart !== undefined || col.period !== undefined
        ? "payouts"
        : null;
  if (format === null) {
    throw new ImportError(
      "validation",
      `Rubrikerna känns inte igen. En utbetalningsfil har kolumnerna ${PAYOUT_FILE_COLUMNS.payouts.join(
        ", ",
      )}; en specifikation har ${PAYOUT_FILE_COLUMNS.lines.join(", ")}.`,
    );
  }
  const missing: string[] = [];
  if (col.reference === undefined) missing.push("Referens");
  if (col.amount === undefined) missing.push("Belopp");
  if (format === "payouts" && col.period === undefined) {
    if (col.periodStart === undefined) missing.push("Period från");
    if (col.periodEnd === undefined) missing.push("Period till");
  }
  if (missing.length > 0) {
    throw new ImportError("validation", `Kolumn saknas: ${missing.join(", ")}.`);
  }

  const payouts: ParsedPayout[] = [];
  const lines: ParsedPayoutLine[] = [];
  const errors: PayoutFileError[] = [];
  const cell = (cells: readonly string[], f: Field): string | undefined => {
    const i = col[f];
    return i === undefined ? undefined : cells[i];
  };

  for (const record of records) {
    const fail = (message: string) => errors.push({ lineNumber: record.lineNumber, message });
    if (record.error) {
      fail(record.error);
      continue;
    }
    const cells = record.cells;
    if (cells.length > header.cells.length) {
      fail("Raden har fler kolumner än rubriken.");
      continue;
    }
    const reference = (cell(cells, "reference") ?? "").trim();
    if (!reference) {
      fail("Referens saknas.");
      continue;
    }
    if (reference.length > 100) {
      fail("Referensen är längre än 100 tecken.");
      continue;
    }

    if (format === "lines") {
      const externalId = (cell(cells, "orderNo") ?? "").normalize("NFKC").trim();
      if (!externalId || externalId.length > 100) {
        fail("Ordernummer saknas.");
        continue;
      }
      if (/^\d+(?:[.,]\d+)?e\+?\d+$/i.test(externalId)) {
        fail(`Ordernumret "${externalId}" är avkortat av Excel. Exportera filen igen som text.`);
        continue;
      }
      const amount = parseSignedOre(cell(cells, "amount"));
      if (!amount.ok) {
        fail(amount.message);
        continue;
      }
      lines.push({ lineNumber: record.lineNumber, reference, externalId, amountOre: amount.ore });
      continue;
    }

    let period: { start: string; end: string } | null = null;
    if (col.periodStart !== undefined && col.periodEnd !== undefined) {
      const start = parsePayoutDate(cell(cells, "periodStart"));
      const end = parsePayoutDate(cell(cells, "periodEnd"));
      period = start && end ? { start, end } : null;
    } else {
      period = parsePayoutPeriod(cell(cells, "period"));
    }
    if (!period) {
      fail("Perioden går inte att tolka. Använd ÅÅÅÅ-MM-DD.");
      continue;
    }
    if (period.end < period.start) {
      fail("Perioden slutar före den börjar.");
      continue;
    }
    const paidRaw = cell(cells, "paidOn");
    const paidOn = paidRaw && paidRaw.trim() ? parsePayoutDate(paidRaw) : null;
    if (paidRaw && paidRaw.trim() && !paidOn) {
      fail("Utbetalningsdagen går inte att tolka. Använd ÅÅÅÅ-MM-DD.");
      continue;
    }
    const amount = parseSignedOre(cell(cells, "amount"));
    if (!amount.ok) {
      fail(`Belopp: ${amount.message}`);
      continue;
    }
    const feesRaw = cell(cells, "fees");
    let feesOre = 0;
    if (feesRaw !== undefined && feesRaw.trim() !== "") {
      const fees = parseAmountOre(feesRaw.replace(/^[-−–]\s*/, ""));
      if (!fees.ok) {
        fail(`Avgifter: ${fees.message}`);
        continue;
      }
      feesOre = fees.ore;
    }
    const refundsRaw = cell(cells, "refunds");
    let refundsOre: number | null = null;
    if (refundsRaw !== undefined && refundsRaw.trim() !== "") {
      const refunds = parseAmountOre(refundsRaw.replace(/^[-−–]\s*/, ""));
      if (!refunds.ok) {
        fail(`Återbetalningar: ${refunds.message}`);
        continue;
      }
      refundsOre = refunds.ore;
    }
    const base = {
      reference,
      periodStart: period.start,
      periodEnd: period.end,
      paidOn,
      amountOre: amount.ore,
      feesOre,
      refundsOre,
    };
    payouts.push({ ...base, lineNumber: record.lineNumber, sourceHash: hashPayout(base) });
  }

  return { format, payouts, lines, errors, rows: records.length };
}
