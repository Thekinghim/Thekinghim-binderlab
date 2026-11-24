/**
 * Läsa en utbetalningsrapport från Nayax i okänt format (CSV eller Excel): vilken kolumn som
 * är vad, och vad filen säger om utbetalningen. Ren modul utan databas (testas i
 * import-parse.test.ts).
 *
 * Rubrikerna känns igen på svenska och engelska (skiftläge och skiljetecken spelar ingen
 * roll, samma normalisering som orderimporten). Två former:
 *
 *   Sammanfattning  en rad per utbetalning: Utbetald · Belopp · Avgift · Brutto ·
 *                   Period från · Period till. Den äldsta raden med ett belopp läses
 *                   först; de andra (`others`) läggs in en i taget efter den.
 *   Transaktioner   en rad per köp (Transaktions-id eller Transaktionsdatum finns):
 *                   beloppen summeras, perioden är första till sista köpdagen, och
 *                   automaterna (serienummer) räknas för kontrollen mot våra automater.
 *
 * Belopp: "1 234,56 kr", "1,234.56", "−373,00" (heltal i öre, inga flyttal). Datum:
 * ÅÅÅÅ-MM-DD, DD.MM.ÅÅÅÅ, DD/MM/ÅÅÅÅ, ÅÅÅÅMMDD (och en tid efter datumet ignoreras).
 * Kontrollen: brutto − avgift − återbetalningar ska vara beloppet inom 1 kr.
 * En summarad ("Totalt", "Summa", "Total …") räknas aldrig (isTotalRow).
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { parseAmountOre } from "@/import/amount";
import { normalizeHeader } from "@/import/mapping";

export const PAYOUT_IMPORT_FIELDS = [
  "paid_on",
  "amount",
  "fees",
  "gross",
  "refunds",
  "period_from",
  "period_to",
  "transaction_id",
  "transaction_date",
  "device_serial",
] as const;
export type PayoutImportField = (typeof PAYOUT_IMPORT_FIELDS)[number];

/** Namnen i kolumnsteget. */
export const FIELD_LABELS: Record<PayoutImportField, string> = {
  paid_on: "Dagen pengarna kom",
  amount: "Belopp in (netto)",
  fees: "Avgift",
  gross: "Försäljning (brutto)",
  refunds: "Återbetalningar",
  period_from: "Period från",
  period_to: "Period till",
  transaction_id: "Transaktions-id",
  transaction_date: "Köpdag",
  device_serial: "Automat (serienummer)",
};

const SYNONYMS: Record<PayoutImportField, string[]> = {
  paid_on: [
    "utbetald",
    "utbetalningsdag",
    "utbetalningsdatum",
    "betaldag",
    "betalningsdatum",
    "paidon",
    "paiddate",
    "payoutdate",
    "paymentdate",
    "valuedate",
    "settlementdate",
    "transferdate",
    "reimbursementdate",
  ],
  amount: [
    "belopp",
    "utbetalt",
    "utbetaltbelopp",
    "netto",
    "nettobelopp",
    "amount",
    "net",
    "netamount",
    "payout",
    "payoutamount",
    "totalpayout",
    "reimbursement",
    "reimbursementamount",
    "transferamount",
    "settlementamount",
  ],
  fees: [
    "avgift",
    "avgifter",
    "provision",
    "fee",
    "fees",
    "commission",
    "servicefee",
    "processingfee",
    "nayaxfee",
    "totalfees",
  ],
  gross: [
    "brutto",
    "bruttobelopp",
    "försäljning",
    "forsaljning",
    "omsättning",
    "gross",
    "grossamount",
    "sales",
    "totalsales",
    "transactionamount",
    "saleamount",
  ],
  refunds: ["återbetalningar", "återbetalning", "aterbetalning", "refund", "refunds", "chargeback"],
  period_from: ["periodfrån", "periodfran", "från", "fran", "from", "periodstart", "startdate"],
  period_to: ["periodtill", "till", "to", "periodend", "enddate", "slutdatum"],
  transaction_id: [
    "transaktionsid",
    "transaktion",
    "transactionid",
    "transaction",
    "transid",
    "txid",
    "ordernummer",
    "orderid",
  ],
  transaction_date: [
    "köpdag",
    "kopdag",
    "transaktionsdatum",
    "datum",
    "date",
    "transactiondate",
    "authorizationdate",
    "machineauthorizationtime",
    "sitetime",
  ],
  device_serial: [
    "automat",
    "serienummer",
    "serial",
    "deviceserial",
    "device",
    "deviceid",
    "machine",
    "machineid",
    "machineserial",
    "terminal",
    "terminalid",
  ],
};

const NORMALIZED: Record<PayoutImportField, Set<string>> = Object.fromEntries(
  PAYOUT_IMPORT_FIELDS.map((f) => [f, new Set(SYNONYMS[f].map(normalizeHeader))]),
) as Record<PayoutImportField, Set<string>>;

export type ColumnMap = Partial<Record<PayoutImportField, number>>;

/** Sparad/vald mappning: fält → rubriken (som den står i filen). */
export const payoutMappingSchema = z
  .object(
    Object.fromEntries(
      PAYOUT_IMPORT_FIELDS.map((f) => [f, z.string().min(1).max(200).nullable().optional()]),
    ) as Record<PayoutImportField, z.ZodOptional<z.ZodNullable<z.ZodString>>>,
  )
  .strict();
export type PayoutMapping = z.infer<typeof payoutMappingSchema>;

/** Fingeravtryck av rubrikerna (normaliserade, sorterade): samma layout → samma. */
export function headerSignature(headers: readonly string[]): string {
  const norm = headers.map(normalizeHeader).filter(Boolean).sort();
  return createHash("sha256").update(norm.join("\u0000")).digest("hex");
}

/** Gissar kolumnerna från rubrikerna. Varje kolumn används för högst ett fält. */
export function detectColumns(headers: readonly string[]): ColumnMap {
  const out: ColumnMap = {};
  const used = new Set<number>();
  const norm = headers.map(normalizeHeader);
  for (const field of PAYOUT_IMPORT_FIELDS) {
    const i = norm.findIndex((h, idx) => !used.has(idx) && NORMALIZED[field].has(h));
    if (i >= 0) {
      out[field] = i;
      used.add(i);
    }
  }
  return out;
}

/** Mappningen (rubriker) som kolumnindex; okända rubriker hoppas över. */
export function columnsFromMapping(headers: readonly string[], mapping: PayoutMapping): ColumnMap {
  const out: ColumnMap = {};
  for (const field of PAYOUT_IMPORT_FIELDS) {
    const h = mapping[field];
    if (!h) continue;
    const i = headers.findIndex((x) => x === h) ?? -1;
    const j = i >= 0 ? i : headers.findIndex((x) => normalizeHeader(x) === normalizeHeader(h));
    if (j >= 0) out[field] = j;
  }
  return out;
}

export function mappingFromColumns(headers: readonly string[], cols: ColumnMap): PayoutMapping {
  const out: PayoutMapping = {};
  for (const field of PAYOUT_IMPORT_FIELDS) {
    const i = cols[field];
    if (i !== undefined && headers[i]) out[field] = headers[i];
  }
  return out;
}

/** Räcker kolumnerna för att läsa filen? (belopp och antingen en sammanfattning eller köp.) */
export function columnsEnough(cols: ColumnMap): boolean {
  if (cols.amount === undefined && cols.gross === undefined) return false;
  return true;
}

function validDay(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const days = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (d > days[m - 1]!) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "2026-11-13", "13.11.2026", "13/11/2026", "20261113", "2026-11-13 10:22" → ÅÅÅÅ-MM-DD. */
export function parseLooseDate(input: string | undefined | null): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(raw);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T].*)?$/.exec(raw);
  if (m) return validDay(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/** Belopp i öre, med tecken ("−373,00", "(373,00)", "1,234.56 SEK"). null = ingen siffra. */
export function parseLooseOre(input: string | undefined | null): number | null {
  let raw = (input ?? "")
    .trim()
    .replace(/\s*(kr|sek)\.?$/i, "")
    .replace(/^(sek)\s*/i, "");
  if (!raw) return null;
  const negative = /^[-−–]/.test(raw) || /^\(.*\)$/.test(raw);
  raw = raw
    .replace(/^[-−–]\s*/, "")
    .replace(/^\((.*)\)$/, "$1")
    .trim();
  // "1,234" är tvetydigt för orderimporten; i en utbetalningsrapport med två decimaler i övrigt
  // räknar vi "1 234" och "1234" som hela kronor.
  const parsed = parseAmountOre(raw);
  if (!parsed.ok) return null;
  return negative ? -parsed.ore : parsed.ore;
}

export interface ExtractedTransaction {
  readonly id: string | null;
  readonly date: string | null;
  readonly amountOre: number;
  readonly deviceSerial: string | null;
}

/** Det filen (eller AI:n) säger om utbetalningen. Alla belopp i öre. */
export interface ExtractedPayout {
  readonly paidOn: string | null;
  readonly amountOre: number | null;
  readonly feesOre: number | null;
  readonly grossOre: number | null;
  readonly refundsOre: number | null;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly transactions: readonly ExtractedTransaction[];
  readonly devices: readonly { readonly serial: string; readonly amountOre: number }[];
  /**
   * Fler utbetalningar i samma fil (en sammanställning med en rad per utbetalning): de
   * läggs in en i taget efter den här ("1 av 3 – Stämmer, nästa").
   */
  readonly others?: readonly ExtractedPayout[];
  /** Fält som AI:n läste ("Läst av AI, kontrollera"). */
  readonly aiFields?: readonly string[];
  readonly confidence?: "high" | "medium" | "low";
}

export const MAX_TRANSACTIONS = 2000;

export type ExtractWarning =
  | { readonly code: "SUMS_MISMATCH"; readonly diffOre: number }
  | { readonly code: "BAD_ROWS"; readonly rows: number }
  | { readonly code: "NO_AMOUNT" }
  | { readonly code: "MANY_PAYOUTS"; readonly rows: number }
  | { readonly code: "TRUNCATED"; readonly rows: number };

const TOTAL_ROW = /^(tot(al|alt)?|summa|sum|totalsumma|grand total)\b/i;

/** En summarad ("Totalt", "Summa", "Total") räknas inte: den är summan av raderna ovanför. */
export function isTotalRow(r: readonly string[]): boolean {
  const first = r.find((c) => c.trim() !== "" && !/^[-+\d\s.,:%kr]+$/i.test(c.trim()));
  return first !== undefined && TOTAL_ROW.test(first.trim());
}

/** Läser raderna med kolumnerna (se filhuvudet). */
export function extractFromRows(
  rows: readonly (readonly string[])[],
  cols: ColumnMap,
): { extracted: ExtractedPayout; warnings: ExtractWarning[] } {
  const warnings: ExtractWarning[] = [];
  const data = rows.filter((r) => r.some((c) => c.trim() !== "") && !isTotalRow(r));
  // "Datum" i en fil med en eller ett par rader är dagen pengarna kom, inte en köpdag.
  const transactional =
    cols.transaction_id !== undefined || (cols.transaction_date !== undefined && data.length > 3);
  const c: ColumnMap =
    !transactional && cols.paid_on === undefined && cols.transaction_date !== undefined
      ? { ...cols, paid_on: cols.transaction_date }
      : cols;
  const cell = (r: readonly string[], f: PayoutImportField) =>
    c[f] === undefined ? undefined : r[c[f]!];
  if (!transactional) {
    // En rad med 0 kr är ingen utbetalning.
    const withAmount = data.filter((r) => {
      const v = parseLooseOre(cell(r, "amount") ?? cell(r, "gross"));
      return v !== null && v !== 0;
    });
    if (withAmount.length > 1) warnings.push({ code: "MANY_PAYOUTS", rows: withAmount.length });
    if (withAmount.length === 0) {
      warnings.push({ code: "NO_AMOUNT" });
      return { extracted: empty(), warnings };
    }
    const one = (r: readonly string[], w: ExtractWarning[]): ExtractedPayout => {
      const fees = parseLooseOre(cell(r, "fees"));
      return withDerived(
        {
          paidOn: parseLooseDate(cell(r, "paid_on")),
          amountOre: parseLooseOre(cell(r, "amount")),
          feesOre: fees === null ? null : Math.abs(fees),
          grossOre: parseLooseOre(cell(r, "gross")),
          refundsOre: abs(parseLooseOre(cell(r, "refunds"))),
          periodFrom: parseLooseDate(cell(r, "period_from")),
          periodTo: parseLooseDate(cell(r, "period_to")),
          transactions: [],
          devices: [],
        },
        w,
      );
    };
    // Äldsta först, så att de läggs in i ordning.
    const all = withAmount
      .map((r) => {
        const w: ExtractWarning[] = [];
        return { payout: one(r, w), w };
      })
      .sort((a, b) =>
        (a.payout.periodFrom ?? a.payout.paidOn ?? "") <
        (b.payout.periodFrom ?? b.payout.paidOn ?? "")
          ? -1
          : 1,
      );
    warnings.push(...all[0]!.w);
    return {
      extracted: { ...all[0]!.payout, others: all.slice(1, 51).map((x) => x.payout) },
      warnings,
    };
  }
  let bad = 0;
  const tx: ExtractedTransaction[] = [];
  let amount = 0;
  let gross = 0;
  let fees = 0;
  let hasFees = false;
  let hasGross = false;
  let hasAmount = false;
  let paidOn: string | null = null;
  const devices = new Map<string, number>();
  for (const r of data) {
    const a = parseLooseOre(cell(r, "amount"));
    const g = parseLooseOre(cell(r, "gross"));
    const f = parseLooseOre(cell(r, "fees"));
    if (a === null && g === null) {
      bad += 1;
      continue;
    }
    if (a !== null) {
      amount += a;
      hasAmount = true;
    }
    if (g !== null) {
      gross += g;
      hasGross = true;
    }
    if (f !== null) {
      fees += Math.abs(f);
      hasFees = true;
    }
    const date = parseLooseDate(cell(r, "transaction_date"));
    const serial = (cell(r, "device_serial") ?? "").trim() || null;
    const value = a ?? (g !== null ? g - (f !== null ? Math.abs(f) : 0) : 0);
    if (serial) devices.set(serial, (devices.get(serial) ?? 0) + value);
    paidOn ??= parseLooseDate(cell(r, "paid_on"));
    tx.push({
      id: (cell(r, "transaction_id") ?? "").trim().slice(0, 100) || null,
      date,
      amountOre: value,
      deviceSerial: serial,
    });
  }
  if (bad > 0) warnings.push({ code: "BAD_ROWS", rows: bad });
  if (tx.length > MAX_TRANSACTIONS) warnings.push({ code: "TRUNCATED", rows: tx.length });
  const dates = tx.flatMap((t) => (t.date ? [t.date] : [])).sort();
  const extracted: ExtractedPayout = {
    paidOn,
    amountOre: hasAmount ? amount : null,
    feesOre: hasFees ? fees : null,
    grossOre: hasGross ? gross : null,
    refundsOre: null,
    periodFrom: dates[0] ?? null,
    periodTo: dates[dates.length - 1] ?? null,
    transactions: tx.slice(0, MAX_TRANSACTIONS),
    devices: [...devices.entries()].map(([serial, amountOre]) => ({ serial, amountOre })),
  };
  return { extracted: withDerived(extracted, warnings), warnings };
}

function abs(v: number | null): number | null {
  return v === null ? null : Math.abs(v);
}

function empty(): ExtractedPayout {
  return {
    paidOn: null,
    amountOre: null,
    feesOre: null,
    grossOre: null,
    refundsOre: null,
    periodFrom: null,
    periodTo: null,
    transactions: [],
    devices: [],
  };
}

/** Räknar ut beloppet från brutto − avgift när bara de finns, och kontrollerar summorna. */
function withDerived(e: ExtractedPayout, warnings: ExtractWarning[]): ExtractedPayout {
  let amountOre = e.amountOre;
  if (amountOre === null && e.grossOre !== null) {
    amountOre = e.grossOre - (e.feesOre ?? 0) - (e.refundsOre ?? 0);
  }
  if (amountOre === null) warnings.push({ code: "NO_AMOUNT" });
  return checkSums({ ...e, amountOre }, warnings);
}

/** brutto − avgift − återbetalningar = belopp inom 1 kr, annars en varning. */
export function checkSums(e: ExtractedPayout, warnings: ExtractWarning[]): ExtractedPayout {
  if (e.amountOre !== null && e.grossOre !== null && e.feesOre !== null) {
    const diff = e.grossOre - e.feesOre - (e.refundsOre ?? 0) - e.amountOre;
    if (Math.abs(diff) > 100) warnings.push({ code: "SUMS_MISMATCH", diffOre: diff });
  }
  return e;
}

/** Fem exempelrader per kolumn för kolumnsteget. */
export function sampleRows(rows: readonly (readonly string[])[], n = 5): string[][] {
  return rows
    .filter((r) => r.some((c) => c.trim() !== ""))
    .slice(0, n)
    .map((r) => r.map((c) => c.slice(0, 80)));
}

/** Bara de valda kolumnerna (det som sparas i utkastet efter kolumnsteget). */
export function trimTable(
  table: { readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] },
  cols: ColumnMap,
): { headers: string[]; rows: string[][] } {
  const idx = [...new Set(Object.values(cols).filter((v): v is number => v !== undefined))].sort(
    (a, b) => a - b,
  );
  return {
    headers: idx.map((i) => table.headers[i] ?? ""),
    rows: table.rows.map((r) => idx.map((i) => r[i] ?? "")),
  };
}
