/**
 * Rapporttyperna: namn i URL:en och UI:t, typen i databasen (reports.kind) och vilken
 * mottagare (report_recipients.kind) som får vilken rapport. Rena konstanter.
 */

/** Rapporttyp i appen (URL: ?typ=butik). */
export type ReportType = "butik" | "bokforing" | "delagare";

/** reports.kind i databasen. */
export type ReportDbKind = "store_statement" | "accountant_statement" | "owner_statement";

/** report_recipients.kind i databasen. */
export type RecipientDbKind = "store" | "accountant" | "partner";

export const REPORT_TYPES: readonly ReportType[] = ["butik", "bokforing", "delagare"];

export const DB_KIND: Record<ReportType, ReportDbKind> = {
  butik: "store_statement",
  bokforing: "accountant_statement",
  delagare: "owner_statement",
};

export const TYPE_BY_DB_KIND: Record<ReportDbKind, ReportType> = {
  store_statement: "butik",
  accountant_statement: "bokforing",
  owner_statement: "delagare",
};

export const RECIPIENT_KIND: Record<ReportType, RecipientDbKind> = {
  butik: "store",
  bokforing: "accountant",
  delagare: "partner",
};

export const TYPE_BY_RECIPIENT_KIND: Record<RecipientDbKind, ReportType> = {
  store: "butik",
  accountant: "bokforing",
  partner: "delagare",
};

/** Rubrik i UI och PDF. */
export const TYPE_LABEL: Record<ReportType, string> = {
  butik: "Butiksrapport",
  bokforing: "Bokföringsunderlag",
  delagare: "Delägarrapport",
};

/** Vem rapporten är till, i plural (segmentväljaren). */
export const TYPE_AUDIENCE: Record<ReportType, string> = {
  butik: "Butikerna",
  bokforing: "Bokhållaren",
  delagare: "Delägaren",
};

export function isReportType(value: unknown): value is ReportType {
  return typeof value === "string" && (REPORT_TYPES as readonly string[]).includes(value);
}

export function isReportDbKind(value: unknown): value is ReportDbKind {
  return typeof value === "string" && value in TYPE_BY_DB_KIND;
}
