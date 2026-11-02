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
  awish_extension: "Awish · Chrome-tillägg",
};

/** Fälten i kolumnmappningen, i visningsordning. Samma som IMPORT_FIELDS i @/import. */
export const MAPPING_FIELDS = [
  "externalId",
  "title",
  "machine",
  "amount",
  "isPaid",
  "paidAt",
  "paymentMethod",
  "rowId",
  "orderDate",
] as const;

/** Svenska namn på fälten. Samma som FIELD_LABELS i @/import (kontrolleras i test). */
export const MAPPING_FIELD_LABELS: Record<(typeof MAPPING_FIELDS)[number], string> = {
  externalId: "Ordernummer",
  title: "Produkt (titel)",
  machine: "Automat",
  amount: "Belopp",
  isPaid: "Betalstatus",
  paidAt: "Betaltid",
  paymentMethod: "Betalmetod",
  rowId: "Rad-ID i källan",
  orderDate: "Orderdatum",
};

/** Fält som måste finnas. Samma som REQUIRED_FIELDS i @/import. */
export const REQUIRED_MAPPING_FIELDS: ReadonlyArray<(typeof MAPPING_FIELDS)[number]> = [
  "externalId",
  "title",
  "machine",
  "amount",
  "isPaid",
  "paidAt",
];
