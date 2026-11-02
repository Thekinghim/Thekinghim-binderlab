/**
 * CSV → rader med radnummer (papaparse). Hanterar BOM, avgränsarna , ; och
 * tab (gissas om den inte anges), citattecken, radbrytningar inom citat,
 * blandade radslut och tomma rader. Avkodar UTF-8, och Windows-1252 om filen
 * inte är UTF-8 alls (Excel-export). En trasig UTF-8-fil avvisas.
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

/**
 * Går igenom hela filen som UTF-8. Returnerar antalet giltiga
 * flerbytessekvenser (t.ex. "é" = C3 A9) och positionen för den första
 * ogiltiga byten (-1 om filen är giltig UTF-8).
 */
export function scanUtf8(bytes: Uint8Array): { multibyte: number; firstInvalid: number } {
  let multibyte = 0;
  let firstInvalid = -1;
  let i = 0;
  const invalid = (): void => {
    if (firstInvalid < 0) {
      firstInvalid = i;
    }
    i += 1;
  };
  outer: while (i < bytes.length) {
    const b = bytes[i] ?? 0;
    if (b < 0x80) {
      i += 1;
      continue;
    }
    let len = 0;
    let min = 0;
    if (b >= 0xc2 && b <= 0xdf) {
      len = 2;
      min = 0x80;
    } else if (b >= 0xe0 && b <= 0xef) {
      len = 3;
      min = 0x800;
    } else if (b >= 0xf0 && b <= 0xf4) {
      len = 4;
      min = 0x10000;
    } else {
      invalid();
      continue;
    }
    let cp = b & (0xff >> (len + 1));
    for (let k = 1; k < len; k += 1) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) {
        invalid();
        continue outer;
      }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      invalid();
      continue;
    }
    multibyte += 1;
    i += len;
  }
  return { multibyte, firstInvalid };
}

function lineOfByte(bytes: Uint8Array, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) {
      line += 1;
    }
  }
  return line;
}

/**
 * Avkodar filens bytes till text: UTF-8, eller Windows-1252 om filen inte är
 * UTF-8 alls (Excel-export). En fil som har giltiga UTF-8-tecken (å, ä, ö, é
 * ...) och dessutom en ogiltig byte är en trasig UTF-8-fil, inte Windows-1252:
 * att avkoda den som Windows-1252 skulle göra "Pokémon" till "PokÃ©mon" i hela
 * filen och skapa falska titlar och konflikter. Den avvisas med radnumret.
 */
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
  const scan = scanUtf8(content);
  if (scan.firstInvalid < 0) {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(content), encoding: "utf-8" };
  }
  if (scan.multibyte > 0) {
    throw new ImportValidationError(
      `Filen är UTF-8 men har ett ogiltigt tecken på rad ${lineOfByte(content, scan.firstInvalid)} ` +
        `(byte ${scan.firstInvalid + 1}). Filen har troligen skadats eller sparats om. ` +
        "Exportera orderlistan på nytt från Awish.",
    );
  }
  return { text: new TextDecoder("windows-1252").decode(content), encoding: "windows-1252" };
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
