/**
 * awish_extension: ordrar som Binderlabs Chrome-tillägg har läst ur Awish-panelen
 * (dash.awish.vip, orderlistan) och skickat till POST /api/ingest/awish i batcher.
 *
 * Tillägget skickar samma fält som CSV-adaptern läser, som källans text (inte
 * tolkade värden): ordernummer, produktnamn, automat, beloppscellen ("Amount:
 * 170.00"), betalstatus ("Paid Success"), betaltid i källans tid, betalmetod,
 * rad-ID och orderdatum. Raderna tolkas med exakt samma regler som en uppladdad
 * orderlista: batchen skrivs om till en CSV med Awish rubriker och går genom
 * parseAwishCsv (belopp, tidszon, Excel-exponent, betald/ej betald). Därefter
 * är allt gemensamt (pipeline.ts): titlar, okända automater i kön, dubbletter
 * och konflikter på ordernummer.
 *
 * Radnumret i importloggen är radens plats i batchen (från 1). Källans sida och
 * plats på sidan sparas i import_rows.raw ("Sida", "Rad på sidan"). Se
 * docs/awish-tillagg.md.
 */

import { z } from "zod";

import type {
  AdapterInput,
  FetchResult,
  OptionalField,
  RawOrder,
  RawRowError,
  SourceAdapter,
} from "../adapter";
import { ImportValidationError } from "../errors";
import type { ColumnMapping } from "../mapping";
import { AWISH_CSV_PARSER_VERSION, parseAwishCsv } from "./awish-csv";

export const AWISH_EXTENSION_PARSER_VERSION = "awish_extension/1";

/** Högst så många rader per batch (tillägget skickar 200 åt gången). */
export const MAX_BATCH_ROWS = 500;

/** Längsta text i ett fält. Awish celler är korta; mer än så är något annat. */
const MAX_CELL = 2000;

const cell = z.string().max(MAX_CELL, `Ett fält är längre än ${MAX_CELL} tecken.`);
const optionalCell = cell.nullable().optional();

/** En rad från tillägget: källans text per fält (samma fält som CSV-mappningen). */
export const extensionRowSchema = z
  .object({
    externalId: cell,
    title: cell,
    machine: cell,
    amount: cell,
    isPaid: cell,
    paidAt: cell,
    paymentMethod: optionalCell,
    rowId: optionalCell,
    orderDate: optionalCell,
    /** Sidan i Awish orderlista (från 1) och raden på sidan, för spårbarhet. */
    page: z.number().int().min(0).max(1_000_000).optional(),
    pageRow: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export type ExtensionRow = z.infer<typeof extensionRowSchema>;

export const extensionBatchSchema = z
  .object({
    rows: z
      .array(extensionRowSchema)
      .max(MAX_BATCH_ROWS, `Högst ${MAX_BATCH_ROWS} rader per batch.`),
    /** Fält som källan inte har med alls (t.ex. en lista utan Payment Method). */
    absent: z
      .array(z.enum(["paymentMethod"]))
      .max(1)
      .optional(),
  })
  .passthrough();

export type ExtensionBatch = z.infer<typeof extensionBatchSchema>;

export interface AwishExtensionInput extends AdapterInput {
  rows: readonly ExtensionRow[];
  absent?: ReadonlyArray<OptionalField>;
}

/** Rubrikerna i den interna CSV:n, Awish egna namn. */
const HEADERS = {
  rowId: "ID",
  orderDate: "Date",
  title: "Name",
  externalId: "Order No.",
  machine: "Order Machine",
  paymentMethod: "Payment Method",
  amount: "Order Amount",
  isPaid: "Is Paid",
  paidAt: "Payment Time",
} as const;
const PAGE_HEADER = "Sida";
const PAGE_ROW_HEADER = "Rad på sidan";

const COLUMN_ORDER = [
  "rowId",
  "orderDate",
  "title",
  "externalId",
  "machine",
  "paymentMethod",
  "amount",
  "isPaid",
  "paidAt",
] as const;

function lines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Batchen som CSV med Awish rubriker, och radnumret i CSV:n där varje rad börjar
 * (en cell kan innehålla radbrytningar, t.ex. "Amount: 170.00\nPaid Amount: 170.00").
 */
export function batchToCsv(rows: readonly ExtensionRow[]): {
  csv: string;
  rowByLine: Map<number, number>;
} {
  const header = [...COLUMN_ORDER.map((f) => HEADERS[f]), PAGE_HEADER, PAGE_ROW_HEADER];
  const out: string[] = [header.map(quote).join(",")];
  const rowByLine = new Map<number, number>();
  let line = 2;
  rows.forEach((row, index) => {
    const values = [
      ...COLUMN_ORDER.map((f) => lines(row[f] ?? "")),
      row.page === undefined ? "" : String(row.page),
      row.pageRow === undefined ? "" : String(row.pageRow),
    ];
    const text = values.map(quote).join(",");
    rowByLine.set(line, index + 1);
    line += (text.match(/\n/g)?.length ?? 0) + 1;
    out.push(text);
  });
  return { csv: `${out.join("\n")}\n`, rowByLine };
}

/** Tolkar en batch från tillägget med CSV-adapterns regler. */
export function parseAwishExtensionBatch(input: AwishExtensionInput): FetchResult {
  if (input.rows.length === 0) {
    throw new ImportValidationError("Batchen är tom.");
  }
  if (input.rows.length > MAX_BATCH_ROWS) {
    throw new ImportValidationError(`Högst ${MAX_BATCH_ROWS} rader per batch.`);
  }
  const absent = new Set(input.absent ?? []);
  const { csv, rowByLine } = batchToCsv(input.rows);
  const columns: ColumnMapping = {
    externalId: HEADERS.externalId,
    title: HEADERS.title,
    machine: HEADERS.machine,
    amount: HEADERS.amount,
    isPaid: HEADERS.isPaid,
    paidAt: HEADERS.paidAt,
    paymentMethod: absent.has("paymentMethod") ? null : HEADERS.paymentMethod,
    rowId: HEADERS.rowId,
    orderDate: HEADERS.orderDate,
  };
  const parsed = parseAwishCsv({
    // En sparad CSV-mappning på datakällan gäller inte här: rubrikerna är fasta.
    context: { ...input.context, config: {} },
    file: { name: "tillagg.csv", content: csv },
    mapping: { columns, delimiter: "," },
  });

  const rowNumber = (line: number): number => rowByLine.get(line) ?? line - 1;
  const rows: RawOrder[] = parsed.rows.map((r) => ({
    ...r,
    sourceRowNumber: rowNumber(r.sourceRowNumber),
  }));
  const errors: RawRowError[] = parsed.errors.map((e) => ({
    ...e,
    sourceRowNumber: rowNumber(e.sourceRowNumber),
  }));
  return {
    rows,
    errors,
    machines: parsed.machines,
    absentFields: parsed.absentFields,
    parserVersion: `${AWISH_EXTENSION_PARSER_VERSION}+${AWISH_CSV_PARSER_VERSION}`,
    mapping: {
      version: 1,
      kind: "awish_extension",
      columns,
      absent: [...absent],
    },
  };
}

export const awishExtensionAdapter: SourceAdapter<AwishExtensionInput> = {
  provider: "awish_extension",
  async fetch(input) {
    return parseAwishExtensionBatch(input);
  },
};
