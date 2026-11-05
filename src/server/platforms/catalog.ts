/**
 * Plattformarna som Binderlab kan ta order från: ren data utan beroenden, så att sidor,
 * larm och klientkomponenter kan fråga "tar den här datakällan emot filer?" eller "laddas
 * den upp för hand?" utan att känna till Awish. Implementationerna ligger i ./awish.ts och
 * ./manual-csv.ts (bara servern), registret i ./index.ts.
 */

import type { DataSourceProvider } from "@/import/adapter";

import type { PlatformId, PlatformInfo } from "./types";

export const PLATFORM_INFO: Readonly<Record<PlatformId, PlatformInfo>> = {
  awish: {
    id: "awish",
    name: "Awish (DingShang)",
    providers: ["awish_grpc", "awish_csv", "awish_web", "awish_extension"],
    fileProvider: "awish_csv",
    capabilities: {
      automaticOrders: true,
      acceptsFiles: true,
      listMachines: true,
      readSlots: true,
      writeRefill: true,
      writeGoods: true,
    },
    notes:
      "Order, automater och fack via Awish officiella gRPC-API (src/server/awish/grpc-client.ts). " +
      "Påfyllning, varor och priser via Awish webbpanels API med leverantörens skriftliga " +
      "godkännande 5 nov. 2026 (src/server/awish/web-client.ts). Orderlistan som CSV är reserv.",
  },
  manual_csv: {
    id: "manual_csv",
    name: "Annan automat (CSV)",
    providers: ["manual_csv"],
    fileProvider: "manual_csv",
    capabilities: {
      automaticOrders: false,
      acceptsFiles: true,
      listMachines: false,
      readSlots: false,
      writeRefill: false,
      writeGoods: false,
    },
    notes:
      "Ingen integration: operatören laddar upp försäljningen som CSV (Datum, Automat, Produkt, " +
      "Belopp). Saldo i automaten räknas från påfyllningar och försäljning i Binderlab.",
  },
};

/** Plattformen som en datakälla hör till. Okänd provider → null. */
export function platformIdOf(provider: string): PlatformId | null {
  for (const info of Object.values(PLATFORM_INFO)) {
    if ((info.providers as readonly string[]).includes(provider)) return info.id;
  }
  return null;
}

/** Datakällan tar emot uppladdade filer (CSV). */
export function providerAcceptsFiles(provider: string): boolean {
  return provider === "awish_csv" || provider === "manual_csv";
}

/**
 * Datakällan fylls på för hand (uppladdning), inte av ett schemalagt jobb. Styr larmen
 * (36 timmar utan ny försäljning = datat är inte importerat) och täckningen per automat
 * (samma regel i databasen: private.sales_data_until_rows).
 */
export function isManualProvider(provider: string): boolean {
  return providerAcceptsFiles(provider);
}

/** Providers som användaren kan skapa en ny fil-datakälla för, i visningsordning. */
export const FILE_PROVIDERS = [
  "awish_csv",
  "manual_csv",
] as const satisfies readonly DataSourceProvider[];
export type FileProvider = (typeof FILE_PROVIDERS)[number];
