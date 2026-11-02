/**
 * CSV → rader med radnummer (papaparse). Hanterar BOM, avgränsarna , ; och
 * tab (gissas om den inte anges), citattecken, radbrytningar inom citat,
 * blandade radslut och tomma rader. Avkodar UTF-8, och Windows-1252 om filen
 * inte är giltig UTF-8 (Excel-export).
 *
 * Radnumren är filens radnummer (rubriken på rad 1), som i ett kalkylblad,
 * så att felraderna i importloggen går att hitta i filen.
 */

import Papa from "papaparse";

import { ImportValidationError } from "./errors";
import { SUPPORTED_DELIMITERS, type Delimiter } from "./mapping";

export interface CsvRecord {
  /** Radnummer i filen där posten börjar (1 = första raden). */
  lineNumber: number;
  cells: string[];
  /** Tolkningsfel från papaparse för posten (t.ex. citattecken som inte stängs). */
  error?: string;
}

export interface CsvTable {
  delimiter: Delimiter;
  encoding: "utf-8" | "windows-1252";
  records: CsvRecord[];
}

/** Största fil som tas emot (50 MB). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const BOM = String.fromCharCode(0xfeff);

/** Avkodar filens bytes till text (UTF-8, annars Windows-1252). */
export function decodeFile(content: string | Uint8Array): {
  text: string;
  encoding: CsvTable["encoding"];
} {
  if (typeof content === "string") {
    return { text: content, encoding: "utf-8" };
  }
  if (content.byteLength > MAX_FILE_BYTES) {
    throw new ImportValidationError("Filen är för stor (högst 50 MB).");
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(content), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(content), encoding: "windows-1252" };
  }
}

const PAPA_ERROR_SV: Record<string, string> = {
  MissingQuotes: "Citattecken som inte stängs.",
  UndetectableDelimiter: "Kunde inte avgöra avgränsaren.",
  TooFewFields: "För få fält.",
  TooManyFields: "För många fält.",
  InvalidQuotes: "Felaktiga citattecken.",
};

export function parseCsvTable(
  content: string | Uint8Array,
  options: { delimiter?: Delimiter } = {},
): CsvTable {
  const decoded = decodeFile(content);
  let text = decoded.text;
  if (text.length > MAX_FILE_BYTES) {
    throw new ImportValidationError("Filen är för stor (högst 50 MB).");
  }
  if (text.startsWith(BOM)) {
    text = text.slice(1);
  }
  // Blandade radslut (CRLF, LF, CR) → LF, så att papaparse inte låser sig vid
  // den första radens radslut.
  text = text.replace(/\r\n?/g, "\n");

  const records: CsvRecord[] = [];
  let detected: string | undefined;
  let prevCursor = 0;
  let line = 1;
  let countedTo = 0;

  const lineAt = (pos: number): number => {
    for (let i = countedTo; i < pos; i += 1) {
      if (text.charCodeAt(i) === 10) {
        line += 1;
      }
    }
    countedTo = Math.max(countedTo, pos);
    return line;
  };

  Papa.parse<string[]>(text, {
    delimiter: options.delimiter ?? "",
    delimitersToGuess: [...SUPPORTED_DELIMITERS],
    newline: "\n",
    skipEmptyLines: "greedy",
    step: (result) => {
      detected ??= result.meta.delimiter;
      // Postens början: första tecken efter föregående post som inte är
      // blanktecken (tomma rader hoppas över).
      let start = prevCursor;
      while (start < text.length && /\s/.test(text.charAt(start))) {
        start += 1;
      }
      const record: CsvRecord = {
        lineNumber: lineAt(start),
        cells: result.data.map((c) => (typeof c === "string" ? c : String(c ?? ""))),
      };
      if (result.errors.length > 0) {
        record.error = result.errors
          .map((e) => PAPA_ERROR_SV[e.code] ?? e.message)
          .filter((m, i, all) => all.indexOf(m) === i)
          .join(" ");
      }
      records.push(record);
      prevCursor = result.meta.cursor;
    },
  });

  const delimiter = (options.delimiter ?? detected ?? ",") as Delimiter;
  return {
    delimiter: (SUPPORTED_DELIMITERS as readonly string[]).includes(delimiter) ? delimiter : ",",
    encoding: decoded.encoding,
    records,
  };
}
