/**
 * Formar importens resultat (runImport) till det som skickas till webbläsaren:
 * ett urval av raderna i stället för alla (en fil med hela historiken kan ha
 * hundratusentals rader), mappningen och sammanfattningen. Ren funktion.
 */

import { IMPORT_FIELDS, type ImportField } from "@/import/mapping";
import type { ImportRowResult } from "@/import/pipeline";
import type { ImportWarning, RunImportResult } from "@/import/run-import";

import { formatWhen, plural } from "./display";
import type { FieldSource, PreviewMapping, PreviewResult, PreviewRow } from "./types";

/** De första raderna i filen som alltid visas. */
export const PREVIEW_HEAD_ROWS = 100;
/** Högst så många rader med fel eller konflikt visas (resten finns i importloggen). */
export const PREVIEW_PROBLEM_ROWS = 400;

function toRow(r: ImportRowResult): PreviewRow {
  return {
    rowNumber: r.rowNumber,
    status: r.status,
    externalId: r.externalId,
    rawTitle: r.rawTitle,
    titleKnown: r.titleKnown,
    machineName: r.machineName,
    machineMapped: r.machineMapped,
    amountOre: r.amountOre,
    paymentMethod: r.paymentMethod,
    orderedAt: r.orderedAt,
    message: r.message,
    notes: r.notes,
  };
}

/**
 * Urvalet: de första `head` raderna plus alla rader med fel eller konflikt (högst
 * `problems`), i filens ordning.
 */
export function selectPreviewRows(
  rows: readonly ImportRowResult[],
  head = PREVIEW_HEAD_ROWS,
  problems = PREVIEW_PROBLEM_ROWS,
): { rows: PreviewRow[]; hidden: number } {
  const picked: ImportRowResult[] = [];
  let problemCount = 0;
  rows.forEach((r, index) => {
    const problem = r.status === "error" || r.status === "conflict";
    if (index < head) {
      picked.push(r);
      if (problem) problemCount += 1;
    } else if (problem && problemCount < problems) {
      picked.push(r);
      problemCount += 1;
    }
  });
  return { rows: picked.map(toRow), hidden: rows.length - picked.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mappningen som adaptern använde (imports.mapping), i en form som klienten kan visa. */
export function previewMapping(mapping: unknown): PreviewMapping | null {
  if (!isRecord(mapping) || !isRecord(mapping.columns)) return null;
  // Manuell CSV hittar sina kolumner själv (Datum, Automat, Produkt, Belopp): ingen editor.
  if (mapping.kind === "manual_csv") return null;
  const columns = {} as Record<ImportField, string | null>;
  const source = {} as Record<ImportField, FieldSource>;
  const rawSource = isRecord(mapping.source) ? mapping.source : {};
  for (const field of IMPORT_FIELDS) {
    const header = mapping.columns[field];
    columns[field] = typeof header === "string" ? header : null;
    const s = rawSource[field];
    source[field] =
      s === "auto" || s === "saved" || s === "override" || s === "none"
        ? s
        : columns[field] === null
          ? "none"
          : "auto";
  }
  const headers = Array.isArray(mapping.headers)
    ? mapping.headers.filter((h): h is string => typeof h === "string")
    : [];
  return {
    headers,
    columns,
    source,
    delimiter: typeof mapping.delimiter === "string" ? mapping.delimiter : ",",
    encoding: typeof mapping.encoding === "string" ? mapping.encoding : null,
  };
}

/**
 * Varningarna från importen med svensk tid och rätt böjning ("1 rad avviker",
 * "1 ny titel", "Samma fil importerades 2 nov. 10:50"). Okända koder lämnas orörda.
 */
export function localizeWarnings(
  warnings: readonly ImportWarning[],
  result: Pick<RunImportResult, "previousImports" | "summary" | "newTitles" | "unknownMachines">,
  timeZone: string,
  now: Date = new Date(),
): ImportWarning[] {
  const rest = (message: string) => {
    const i = message.indexOf(":");
    return i === -1 ? "" : message.slice(i);
  };
  return warnings.map((w): ImportWarning => {
    switch (w.code) {
      case "duplicate_file": {
        const first = result.previousImports[0];
        const when = first?.finishedAt ? ` ${formatWhen(first.finishedAt, timeZone, now)}` : "";
        const gave = first ? ` (${plural(first.rowsNew, "ny order", "nya order")})` : "";
        return {
          ...w,
          message: `Samma fil importerades${when}${gave}. Order som redan finns räknas som dubbletter och ändras inte.`,
        };
      }
      case "conflicts": {
        const n = result.summary.conflict;
        return {
          ...w,
          message: `${plural(n, "rad", "rader")} avviker från order som redan finns. Orderna ändras inte; se importloggen.`,
        };
      }
      case "errors": {
        const n = result.summary.error;
        return {
          ...w,
          message: `${plural(n, "rad", "rader")} kunde inte tolkas och hoppas över.`,
        };
      }
      case "new_titles": {
        const n = result.newTitles.length;
        return { ...w, message: `${plural(n, "ny titel", "nya titlar")}${rest(w.message)}` };
      }
      case "unknown_machines": {
        const n = result.unknownMachines.length;
        return {
          ...w,
          message: `${plural(n, "automat", "automater")} är inte ${n === 1 ? "kopplad" : "kopplade"}${rest(w.message)}`,
        };
      }
      default:
        return w;
    }
  });
}

/** runImport-resultatet → det klienten får (förhandsvisning eller genomförd import). */
export function toPreviewResult(uploadId: string, result: RunImportResult): PreviewResult {
  const { rows, hidden } = selectPreviewRows(result.rows);
  return {
    uploadId,
    dryRun: result.dryRun,
    importId: result.importId,
    dataSource: {
      id: result.dataSource.id,
      name: result.dataSource.name,
      sourceTimezone: result.dataSource.sourceTimezone,
      provider: result.dataSource.provider,
    },
    organizationTimezone: result.organizationTimezone,
    file: { name: result.file.name, bytes: result.file.bytes, sha256: result.file.sha256 },
    summary: result.summary,
    rows,
    rowsHidden: hidden + (result.rowsTruncated ? result.summary.total - result.rows.length : 0),
    newTitles: result.newTitles.map((t) => ({ name: t.name, rows: t.rows })),
    unknownMachines: result.unknownMachines.map((m) => ({
      externalId: m.externalId,
      name: m.name,
      rows: m.rows,
      queued: m.queued,
    })),
    firstRow: result.firstRow,
    warnings: localizeWarnings(result.warnings, result, result.organizationTimezone),
    mapping: previewMapping(result.mapping),
    previousImports: result.previousImports,
  };
}
