/**
 * CSV i svenskt Excel-format.
 *
 * - Semikolon som fältavgränsare (komma är decimaltecken i sv-SE).
 * - Decimalkomma, inga tusentalsavgränsare, vanligt bindestreck som minus.
 * - UTF-8 med BOM, så att Excel läser å, ä, ö rätt utan importguide.
 * - CRLF som radslut och citattecken enligt RFC 4180: fält som innehåller
 *   avgränsare, citattecken eller radbrytning omges av "…" och inre " dubbleras.
 * - Text som börjar med = + - @ (formelinjektion) föregås av ' så att
 *   kalkylprogrammet visar den som text. Tal påverkas inte.
 *
 * Modulen importerar inget via "@/" så att testerna kan köras utan konfiguration.
 */

export const CSV_SEPARATOR = ";";
export const CSV_EOL = "\r\n";
export const BOM = "﻿";

export type CsvCell = string | number | boolean | Date | null | undefined;

/** Minsta kolumnform. DataTable:s Column<T> uppfyller den. */
export type CsvColumn<T> = {
  header: string;
  /** Värde i exporten. Saknas den används sortValue, annars blir cellen tom. */
  csv?: (row: T) => CsvCell;
  sortValue?: (row: T) => number | string;
};

export type CsvOptions = {
  /** Lägg till UTF-8 BOM först. Standard true. */
  bom?: boolean;
  /** Skydda mot formelinjektion i text. Standard true. */
  escapeFormulas?: boolean;
};

const numberFmt = new Intl.NumberFormat("sv-SE", {
  useGrouping: false,
  maximumFractionDigits: 10,
});

/** 79987.5 → "79987,5" · -3 → "-3" · NaN → "" */
export function csvNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  // Intl ger U+2212 för minus i sv-SE; kalkylprogram kräver bindestreck.
  return numberFmt.format(value).replace(/[−-]/g, "-");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Datum som "2026-11-01 17:17:05" (lokal tid), som Excel tolkar som datum. */
export function csvDate(d: Date): string {
  if (!Number.isFinite(d.getTime())) return "";
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

const NEEDS_QUOTES = /[";\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** Ett fält, citerat vid behov. */
export function csvField(value: CsvCell, options: CsvOptions = {}): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return csvNumber(value);
  if (typeof value === "boolean") return value ? "Ja" : "Nej";
  if (value instanceof Date) return csvDate(value);

  let s = value;
  if ((options.escapeFormulas ?? true) && FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Bygger hela filen: BOM, rubrikrad med kolumnernas header, en rad per post. */
export function toCsv<T>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<CsvColumn<T>>,
  options: CsvOptions = {},
): string {
  const lines: string[] = new Array(rows.length + 1);
  lines[0] = columns.map((c) => csvField(c.header, options)).join(CSV_SEPARATOR);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as T;
    let line = "";
    for (let j = 0; j < columns.length; j++) {
      const col = columns[j] as CsvColumn<T>;
      const v = col.csv ? col.csv(row) : col.sortValue ? col.sortValue(row) : "";
      if (j > 0) line += CSV_SEPARATOR;
      line += csvField(v, options);
    }
    lines[i + 1] = line;
  }
  return ((options.bom ?? true) ? BOM : "") + lines.join(CSV_EOL) + CSV_EOL;
}

/** "Intäkt / Automat" → "intakt-automat" (säkert filnamn, utan .csv) */
export function csvFileName(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.csv$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "export";
}

/** Startar nedladdning i webbläsaren. Gör ingenting på servern. */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${csvFileName(filename)}.csv`;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Ge webbläsaren tid att börja läsa innan URL:en släpps.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
