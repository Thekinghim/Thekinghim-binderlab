/**
 * Konstanter som både servern och webbläsaren använder (inga beroenden, så att
 * inget av importens serverkod hamnar i klientpaketet).
 */

/** Största fil som tas emot. Samma som MAX_FILE_BYTES i @/import (kontrolleras i test). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Filen laddas upp i bitar om 768 KiB: under server actions gräns på 1 MB inklusive
 * formulärdata, och långt under proxyns buffert på 10 MB.
 */
export const CHUNK_BYTES = 768 * 1024;

/** Tidszoner som går att välja för en datakälla (Awish ligger troligen i Shanghai-tid). */
export const SOURCE_TIMEZONES = [
  { value: "Asia/Shanghai", label: "Kina, Asia/Shanghai (UTC+8)" },
  { value: "Europe/Stockholm", label: "Sverige, Europe/Stockholm" },
  { value: "UTC", label: "UTC" },
] as const;

/** Filtren i importens radlogg (?visa=). */
export const IMPORT_ROW_FILTERS = ["problem", "fel", "konflikter", "nya"] as const;
export type ImportRowFilter = (typeof IMPORT_ROW_FILTERS)[number];

export const PROVIDER_LABELS: Record<string, string> = {
  awish_csv: "Awish · orderlista (CSV)",
  awish_grpc: "Awish · API (gRPC)",
  awish_web: "Awish · webb",
};
