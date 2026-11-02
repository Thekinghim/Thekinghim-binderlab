/**
 * awish_csv: Awish orderlista exporterad som CSV och uppladdad i appen.
 *
 * Kolumner: ID, Date, Name, Order No., Order Machine, Payment Method,
 * Order Amount, Is Paid, Payment Time (Actions ignoreras).
 * - Name = produkttitel, Order Machine = automatens namn.
 * - Order Amount innehåller beloppet märkt "Amount:".
 * - Betald = "Paid Success". Tiden är Payment Time i källans tidszon.
 * - Ingen kolumn för antal (alltid 1 pack per order), utmatning eller
 *   återbetalning.
 */

import type {
  AdapterInput,
  FetchResult,
  RawMachine,
  RawOrder,
  RawRowError,
  SourceAdapter,
} from "../adapter";
import { parseAmountOre } from "../amount";
import { parseCsvTable } from "../csv-table";
import { ImportValidationError, MappingError } from "../errors";
import {
  countKnownHeaders,
  isPaidValue,
  mappingOverrideSchema,
  resolveColumns,
  type ColumnMapping,
  type MappingOverride,
  type ResolvedMapping,
} from "../mapping";
import { formatInZone, parseSourceDateTime, zonedToUtc } from "../zoned";
import { ZodError } from "zod";

export const AWISH_CSV_PARSER_VERSION = "awish_csv/1";

export interface AwishCsvInput extends AdapterInput {
  file: { name: string; content: string | Uint8Array };
  /** Användarens överstyrning av kolumnmappningen. */
  mapping?: MappingOverride;
}

export interface AwishCsvFetchResult extends FetchResult {
  mapping: ResolvedMapping & { encoding: string };
}

/** Hur många rader i början som kan vara rubrikraden (rader före den hoppas över). */
const HEADER_SEARCH_ROWS = 10;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function uniqueHeaders(cells: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((cell, index) => {
    const base = cell.trim() === "" ? `Kolumn ${index + 1}` : cell.trim();
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function savedColumns(config: Record<string, unknown>): Partial<ColumnMapping> | null {
  const saved = config.csvMapping;
  if (!saved || typeof saved !== "object") {
    return null;
  }
  const parsed = mappingOverrideSchema.safeParse(saved);
  return parsed.success ? (parsed.data.columns ?? null) : null;
}

export function parseAwishCsv(input: AwishCsvInput): AwishCsvFetchResult {
  const override = input.mapping ? mappingOverrideSchema.parse(input.mapping) : undefined;
  const table = parseCsvTable(input.file.content, { delimiter: override?.delimiter });
  if (table.records.length === 0) {
    throw new ImportValidationError("Filen är tom.");
  }

  // Rubrikraden: första raden (bland de första tio) med minst fyra kända
  // rubriker, annars första raden. Med överstyrning: första raden som har
  // alla överstyrda rubriker.
  const wanted = Object.values(override?.columns ?? {}).filter(
    (v): v is string => typeof v === "string",
  );
  let headerIndex = 0;
  for (let i = 0; i < Math.min(HEADER_SEARCH_ROWS, table.records.length); i += 1) {
    const cells = (table.records[i]?.cells ?? []).map((c) => c.trim());
    const hasWanted =
      wanted.length > 0 &&
      wanted.every((w) => cells.some((c) => c.toLowerCase() === w.trim().toLowerCase()));
    if (hasWanted || (wanted.length === 0 && countKnownHeaders(cells) >= 4)) {
      headerIndex = i;
      break;
    }
  }
  const headerRecord = table.records[headerIndex];
  if (!headerRecord) {
    throw new ImportValidationError("Filen saknar rubrikrad.");
  }
  const headers = uniqueHeaders(headerRecord.cells);
  const { columns, source } = resolveColumns(headers, {
    saved: savedColumns(input.context.config),
    override: override?.columns,
  });
  const indexOf = (field: keyof ColumnMapping): number => {
    const header = columns[field];
    return header === null ? -1 : headers.indexOf(header);
  };

  const idx = {
    externalId: indexOf("externalId"),
    title: indexOf("title"),
    machine: indexOf("machine"),
    amount: indexOf("amount"),
    isPaid: indexOf("isPaid"),
    paidAt: indexOf("paidAt"),
    paymentMethod: indexOf("paymentMethod"),
  };
  const tz = input.context.sourceTimezone;

  const rows: RawOrder[] = [];
  const errors: RawRowError[] = [];
  const machines = new Map<string, RawMachine>();

  for (const record of table.records.slice(headerIndex + 1)) {
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      raw[h] = record.cells[i] ?? "";
    });
    const extra = record.cells.slice(headers.length);
    extra.forEach((value, i) => {
      if (value.trim() !== "") {
        raw[`Extra ${i + 1}`] = value;
      }
    });
    const cell = (i: number): string => (i < 0 ? "" : (record.cells[i] ?? ""));

    const problems: string[] = [];
    if (record.error) {
      problems.push(record.error);
    }
    if (extra.some((v) => v.trim() !== "")) {
      problems.push("Raden har fler kolumner än rubrikraden.");
    }

    const isPaid = isPaidValue(cell(idx.isPaid));
    const externalId = cell(idx.externalId).trim();
    if (externalId === "") {
      problems.push("Ordernummer saknas.");
    } else if (externalId.length > 200) {
      problems.push("Ordernumret är längre än 200 tecken.");
    }
    const rawTitle = cell(idx.title).trim();
    if (rawTitle === "") {
      problems.push("Produktnamn (titel) saknas.");
    } else if (rawTitle.length > 500) {
      problems.push("Produktnamnet är längre än 500 tecken.");
    }
    const machineName = collapse(cell(idx.machine));
    if (machineName === "") {
      problems.push("Automat saknas.");
    }
    const amount = parseAmountOre(cell(idx.amount));
    if (!amount.ok) {
      problems.push(amount.message);
    }

    const notes: string[] = [];
    let paidAtUtc: Date | null = null;
    const time = parseSourceDateTime(cell(idx.paidAt));
    if (!time.ok) {
      problems.push(time.message);
    } else if (time.kind === "absolute") {
      paidAtUtc = time.utc;
    } else {
      const resolved = zonedToUtc(time.local, tz);
      paidAtUtc = resolved.utc;
      if (resolved.resolution === "ambiguous") {
        notes.push(
          `Tiden ${cell(idx.paidAt).trim()} finns två gånger i ${tz} (sommartid slutar). ` +
            `Den tidigaste valdes: ${resolved.utc.toISOString()} UTC.`,
        );
      } else if (resolved.resolution === "gap") {
        notes.push(
          `Tiden ${cell(idx.paidAt).trim()} finns inte i ${tz} (sommartid börjar). ` +
            `Den flyttades fram till ${formatInZone(resolved.utc, tz)}.`,
        );
      }
    }

    if (problems.length > 0 || paidAtUtc === null || !amount.ok) {
      errors.push({
        sourceRowNumber: record.lineNumber,
        raw,
        message: problems.join(" "),
        externalId: externalId === "" ? undefined : externalId,
        isPaid,
      });
      continue;
    }

    const paymentMethod = collapse(cell(idx.paymentMethod));
    rows.push({
      externalId,
      rawTitle,
      sourceMachineName: machineName,
      paymentMethod: paymentMethod === "" ? null : paymentMethod,
      amountOre: amount.ore,
      paidAtUtc,
      isPaid,
      sourceRowNumber: record.lineNumber,
      raw,
      notes: notes.length > 0 ? notes : undefined,
    });
    if (isPaid && !machines.has(machineName)) {
      machines.set(machineName, { externalId: machineName, externalName: machineName });
    }
  }

  return {
    rows,
    machines: [...machines.values()],
    errors,
    parserVersion: AWISH_CSV_PARSER_VERSION,
    mapping: {
      version: 1,
      columns,
      source,
      delimiter: table.delimiter,
      headers,
      headerRowNumber: headerRecord.lineNumber,
      encoding: table.encoding,
    },
  };
}

export const awishCsvAdapter: SourceAdapter<AwishCsvInput> = {
  provider: "awish_csv",
  async fetch(input) {
    try {
      return parseAwishCsv(input);
    } catch (error) {
      if (error instanceof MappingError || error instanceof ImportValidationError) {
        throw error;
      }
      if (error instanceof ZodError) {
        throw new MappingError("Kolumnmappningen är ogiltig.");
      }
      throw error;
    }
  },
};
