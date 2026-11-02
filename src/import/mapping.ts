/**
 * Kolumnmappning för filimport: vilken rubrik i filen som motsvarar vilket
 * fält. Mappningen hittas automatiskt på rubrikerna (okänsligt för skiftläge,
 * mellanslag och skiljetecken, även svenska varianter) och kan överstyras av
 * användaren. Den mappning som användes sparas i `imports.mapping`.
 */

import { z } from "zod";

import { MappingError } from "./errors";

export const IMPORT_FIELDS = [
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

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Fält som måste finnas i varje fil. */
export const REQUIRED_FIELDS: readonly ImportField[] = [
  "externalId",
  "title",
  "machine",
  "amount",
  "isPaid",
  "paidAt",
];

export const FIELD_LABELS: Record<ImportField, string> = {
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

/**
 * Kända rubriker per fält, normaliserade (se `normalizeHeader`). Awish
 * orderlista först, sedan engelska och svenska varianter.
 */
const SYNONYMS: Record<ImportField, readonly string[]> = {
  externalId: [
    "orderno",
    "ordernumber",
    "ordernr",
    "ordernummer",
    "orderid",
    "ordersn",
    "orderno.",
    "beställningsnummer",
    "beställningsnr",
  ],
  title: [
    "name",
    "productname",
    "product",
    "goodsname",
    "itemname",
    "item",
    "produkt",
    "produktnamn",
    "namn",
    "titel",
    "title",
    "artikel",
    "vara",
  ],
  machine: [
    "ordermachine",
    "machine",
    "machinename",
    "device",
    "devicename",
    "automat",
    "automatnamn",
    "maskin",
    "maskinnamn",
  ],
  amount: [
    "orderamount",
    "amount",
    "totalamount",
    "total",
    "price",
    "belopp",
    "orderbelopp",
    "summa",
    "totalbelopp",
    "pris",
  ],
  isPaid: [
    "ispaid",
    "paid",
    "paymentstatus",
    "paystatus",
    "betald",
    "betalstatus",
    "betalningsstatus",
  ],
  paidAt: [
    "paymenttime",
    "paidtime",
    "paidat",
    "paytime",
    "betaltid",
    "betalningstid",
    "betalningstidpunkt",
    "betaldtid",
  ],
  paymentMethod: [
    "paymentmethod",
    "paymethod",
    "paymenttype",
    "betalmetod",
    "betalningsmetod",
    "betalsätt",
    "betalningssätt",
  ],
  rowId: ["id", "rowid", "radid"],
  orderDate: ["date", "orderdate", "ordertime", "createtime", "created", "datum", "orderdatum"],
};

/** Gemener, NFKC, bara bokstäver och siffror ("Order No." → "orderno"). */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const NORMALIZED_SYNONYMS: Record<ImportField, Set<string>> = Object.fromEntries(
  IMPORT_FIELDS.map((f) => [f, new Set(SYNONYMS[f].map(normalizeHeader))]),
) as Record<ImportField, Set<string>>;

export const SUPPORTED_DELIMITERS = [",", ";", "\t"] as const;
export type Delimiter = (typeof SUPPORTED_DELIMITERS)[number];

/** Rubrik per fält (exakt som i filen), null = fältet finns inte i filen. */
export type ColumnMapping = Record<ImportField, string | null>;

/** Användarens överstyrning: fält → rubrik (null tar bort fältet). */
export const mappingOverrideSchema = z
  .object({
    columns: z
      .object(
        Object.fromEntries(
          IMPORT_FIELDS.map((f) => [f, z.string().min(1).max(200).nullable().optional()]),
        ) as Record<ImportField, z.ZodOptional<z.ZodNullable<z.ZodString>>>,
      )
      .strict()
      .optional(),
    delimiter: z.enum(SUPPORTED_DELIMITERS).optional(),
  })
  .strict();

export type MappingOverride = z.infer<typeof mappingOverrideSchema>;

/** Mappningen som faktiskt användes (sparas i imports.mapping). */
export interface ResolvedMapping {
  version: 1;
  columns: ColumnMapping;
  /** Varifrån varje fält kom: automatiskt, sparad mappning eller användaren. */
  source: Record<ImportField, "auto" | "saved" | "override" | "none">;
  delimiter: Delimiter;
  headers: string[];
  headerRowNumber: number;
}

function emptyMapping(): ColumnMapping {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as ColumnMapping;
}

/** Hittar fälten automatiskt på rubrikerna. Varje rubrik används högst en gång. */
export function autoMap(headers: readonly string[]): ColumnMapping {
  const columns = emptyMapping();
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const synonyms = NORMALIZED_SYNONYMS[field];
    // Synonymernas ordning avgör: "Order Amount" före "Amount" om båda finns.
    const ranked = [...synonyms];
    let bestIndex = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    for (let index = 0; index < headers.length; index += 1) {
      if (used.has(index)) {
        continue;
      }
      const rank = ranked.indexOf(normalizeHeader(headers[index] ?? ""));
      if (rank >= 0 && rank < bestRank) {
        bestIndex = index;
        bestRank = rank;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      columns[field] = headers[bestIndex] ?? null;
    }
  }
  return columns;
}

/** Antal kända fält i en rad (för att hitta rubrikraden). */
export function countKnownHeaders(cells: readonly string[]): number {
  const mapped = autoMap(cells);
  return IMPORT_FIELDS.filter((f) => mapped[f] !== null).length;
}

function findHeader(headers: readonly string[], wanted: string): string | null {
  const exact = headers.find((h) => h === wanted);
  if (exact !== undefined) {
    return exact;
  }
  const norm = normalizeHeader(wanted);
  return headers.find((h) => normalizeHeader(h) === norm) ?? null;
}

export function missingRequired(columns: ColumnMapping): ImportField[] {
  return REQUIRED_FIELDS.filter((f) => columns[f] === null);
}

/**
 * Slutlig mappning: automatisk, sedan sparad (från datakällan, om alla dess
 * rubriker finns i filen) och sist användarens överstyrning. Kastar
 * MappingError om ett obligatoriskt fält saknas eller en rubrik inte finns.
 */
export function resolveColumns(
  headers: readonly string[],
  options: { saved?: Partial<ColumnMapping> | null; override?: MappingOverride["columns"] } = {},
): { columns: ColumnMapping; source: ResolvedMapping["source"] } {
  const columns = autoMap(headers);
  const source = Object.fromEntries(
    IMPORT_FIELDS.map((f) => [f, columns[f] === null ? "none" : "auto"]),
  ) as ResolvedMapping["source"];

  const apply = (
    overrides: Partial<Record<ImportField, string | null | undefined>>,
    kind: "saved" | "override",
  ): void => {
    for (const field of IMPORT_FIELDS) {
      const wanted = overrides[field];
      if (wanted === undefined) {
        continue;
      }
      if (wanted === null) {
        columns[field] = null;
        source[field] = "none";
        continue;
      }
      const header = findHeader(headers, wanted);
      if (header === null) {
        if (kind === "saved") {
          continue;
        }
        throw new MappingError(
          `Kolumnen "${wanted}" (${FIELD_LABELS[field]}) finns inte i filen.`,
          [field],
        );
      }
      // En rubrik kan bara ha ett fält: flytta den från ett annat fält.
      for (const other of IMPORT_FIELDS) {
        if (other !== field && columns[other] === header) {
          columns[other] = null;
          source[other] = "none";
        }
      }
      columns[field] = header;
      source[field] = kind;
    }
  };

  if (options.saved) {
    const saved = options.saved;
    const allPresent = IMPORT_FIELDS.every((f) => {
      const h = saved[f];
      return h === undefined || h === null || findHeader(headers, h) !== null;
    });
    if (allPresent) {
      apply(saved, "saved");
    }
  }
  if (options.override) {
    apply(options.override, "override");
  }

  const missing = missingRequired(columns);
  if (missing.length > 0) {
    throw new MappingError(
      `Filen saknar kolumner för: ${missing.map((f) => FIELD_LABELS[f]).join(", ")}. ` +
        "Välj vilka kolumner som motsvarar fälten.",
      missing,
    );
  }
  return { columns, source };
}

/** Värden i "Is Paid" som betyder betald. Allt annat räknas som ej betalt. */
const PAID_VALUES = new Set(
  ["paid success", "paidsuccess", "paid", "success", "betald", "betalt", "ja", "yes", "true"].map(
    (v) => v.replace(/\s+/g, " "),
  ),
);

export function isPaidValue(value: string | null | undefined): boolean {
  const v = (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return PAID_VALUES.has(v);
}
