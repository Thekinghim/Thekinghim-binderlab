/**
 * Typer som Datakällor-sidan skickar mellan server och klient. Inga funktioner,
 * inget som bara får finnas på servern. Sidan är bara för ägare och admin.
 */

// Bara typer (raderas vid kompilering), så att inget från importens serverkod
// hamnar i klientpaketet.
import type { ImportField } from "@/import/mapping";
import type { ImportSummary, RowStatus } from "@/import/pipeline";
import type { FirstRowCheck, ImportWarning } from "@/import/run-import";

export type { FirstRowCheck, ImportField, ImportSummary, ImportWarning, RowStatus };

export type ProviderKey = "awish_csv" | "awish_grpc" | "awish_web";
export type SourceStatus = "active" | "paused" | "error";
export type ImportStatus = "pending" | "running" | "succeeded" | "failed";
export type ImportTrigger = "upload" | "schedule" | "webhook";
export type FieldSource = "auto" | "saved" | "override" | "none";

/** Resultatet av en server action. */
export type ActionResult<T = undefined> =
  { ok: true; data: T; error?: undefined } | { ok: false; error: string; data?: undefined };

export interface ImportLogEntry {
  readonly id: string;
  readonly dataSourceId: string;
  readonly dataSourceName: string;
  readonly trigger: ImportTrigger;
  readonly fileName: string | null;
  readonly status: ImportStatus;
  /** ISO 8601 (UTC). */
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  /** Visningsnamnet på den som körde importen, eller null (systemet). */
  readonly createdBy: string | null;
  readonly rowsTotal: number;
  readonly rowsNew: number;
  readonly rowsDuplicate: number;
  readonly rowsConflict: number;
  readonly rowsError: number;
  /** Ej betalda rader (räknas inte rad för rad, se notPaidOf). */
  readonly rowsNotPaid: number;
}

export interface SourceView {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderKey;
  readonly sourceTimezone: string;
  readonly status: SourceStatus;
  readonly lastSyncedAt: string | null;
  readonly archived: boolean;
  /** Tar emot uppladdade filer (CSV). */
  readonly acceptsFiles: boolean;
  readonly orders: number;
  /** Källautomater som väntar på koppling. */
  readonly unmapped: number;
  readonly lastImport: ImportLogEntry | null;
  /** Kolumnmappningen som sparats på källan (fält → rubrik), eller null. */
  readonly savedMapping: Partial<Record<ImportField, string | null>> | null;
}

export interface QueueEntry {
  /** source_machines.id */
  readonly id: string;
  readonly dataSourceId: string;
  readonly dataSourceName: string;
  readonly externalId: string;
  readonly externalName: string | null;
  /** Order som väntar på automaten. */
  readonly pendingOrders: number;
  readonly firstOrderAt: string | null;
  readonly lastOrderAt: string | null;
  /** Automaten som namnet troligen avser (kod i namnet), eller null. */
  readonly suggestedMachineId: string | null;
}

export interface MachineOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly storeName: string | null;
}

export interface DatakallorData {
  readonly timeZone: string;
  readonly now: string;
  readonly sources: SourceView[];
  readonly imports: ImportLogEntry[];
  readonly queue: QueueEntry[];
  readonly machines: MachineOption[];
}

/** En tolkad rad i förhandsvisningen eller efter import. */
export interface PreviewRow {
  readonly rowNumber: number;
  readonly status: RowStatus;
  readonly externalId: string | null;
  readonly rawTitle: string | null;
  readonly titleKnown: boolean;
  readonly machineName: string | null;
  readonly machineMapped: boolean;
  readonly amountOre: number | null;
  readonly paymentMethod: string | null;
  /** ISO 8601 (UTC). */
  readonly orderedAt: string | null;
  readonly message: string | null;
  readonly notes: readonly string[];
}

export interface PreviewMapping {
  readonly headers: readonly string[];
  readonly columns: Record<ImportField, string | null>;
  readonly source: Record<ImportField, FieldSource>;
  readonly delimiter: string;
  readonly encoding: string | null;
}

export interface PreviewResult {
  readonly uploadId: string;
  readonly dryRun: boolean;
  readonly importId: string | null;
  readonly dataSource: { id: string; name: string; sourceTimezone: string };
  readonly organizationTimezone: string;
  readonly file: { name: string; bytes: number; sha256: string };
  readonly summary: ImportSummary;
  /** Ett urval: de första raderna och alla rader med fel eller konflikt (upp till en gräns). */
  readonly rows: PreviewRow[];
  /** Antal rader som inte visas (utanför urvalet). */
  readonly rowsHidden: number;
  readonly newTitles: ReadonlyArray<{ name: string; rows: number }>;
  readonly unknownMachines: ReadonlyArray<{
    externalId: string;
    name: string | null;
    rows: number;
    queued: boolean;
  }>;
  readonly firstRow: FirstRowCheck | null;
  readonly warnings: readonly ImportWarning[];
  readonly mapping: PreviewMapping | null;
  readonly previousImports: ReadonlyArray<{
    id: string;
    fileName: string | null;
    finishedAt: string | null;
    rowsNew: number;
  }>;
}

export interface ImportDetailRow {
  readonly rowNumber: number;
  readonly status: "new" | "conflict" | "error";
  readonly message: string | null;
  readonly orderId: string | null;
  readonly externalId: string | null;
  readonly title: string | null;
  readonly machine: string | null;
  readonly amount: string | null;
  readonly paidAt: string | null;
  /** Orderns tid (ISO, UTC) för rader som hör till en order (ny eller konflikt). */
  readonly orderedAt: string | null;
  /** Hela källraden (rubrik → värde). */
  readonly raw: Record<string, string>;
}

export interface ImportDetail {
  readonly entry: ImportLogEntry;
  readonly sourceTimezone: string;
  readonly parserVersion: string;
  readonly sha256: string | null;
  readonly mapping: Partial<Record<ImportField, string | null>> | null;
  readonly counts: { new: number; conflict: number; error: number };
  readonly rows: ImportDetailRow[];
  /** Fler rader än som visas för valt filter. */
  readonly truncated: boolean;
}

/** Filen saknar kolumner för obligatoriska fält: användaren väljer dem själv. */
export interface MappingNeeded {
  readonly uploadId: string;
  readonly fileName: string;
  readonly message: string;
  readonly missing: readonly ImportField[];
  readonly mapping: PreviewMapping;
}

export type PreviewOutcome =
  | { readonly kind: "preview"; readonly result: PreviewResult }
  | { readonly kind: "mapping"; readonly needed: MappingNeeded };
