/**
 * Miljövariabler för ekonomiområdet (se .env.example och docs/miljoer.md, avsnittet Ekonomi).
 *
 *   ACCOUNTING_PROVIDER   none (standard) | local | fortnox | visma_enet | bokio
 *                         Bokföringsprogrammet som verifikationerna skickas till. Beställaren har
 *                         inte valt program: standard är none, och sidan visar "Ej konfigurerad"
 *                         med SIE-filen som väg. local skriver verifikationerna som SIE-fil till
 *                         .data/outbox/bokforing (utveckling och test).
 *   ACCOUNTING_OUTBOX_DIR Katalog för local. Standard .data/outbox/bokforing.
 *   PAYOUT_SOURCE         csv (standard) | awish_api. Varifrån utbetalningarna kommer.
 *                         awish_api är förberedd men kräver Awish dokumentation (se payout-source.ts).
 *   CONTRACT_FILE_STORE   local | supabase. Var avtalsfilerna sparas. Standard: local när
 *                         AUTH_PROVIDER=dev, annars supabase (bucket 'contracts').
 *   CONTRACT_FILE_DIR     Katalog för local. Standard .data/contracts.
 *
 * Läses när de används (inte vid import), så att tester kan sätta dem.
 */

import "server-only";

import path from "node:path";

export const ACCOUNTING_PROVIDERS = ["none", "local", "fortnox", "visma_enet", "bokio"] as const;
export type AccountingProviderKind = (typeof ACCOUNTING_PROVIDERS)[number];

export const PAYOUT_SOURCES = ["csv", "awish_api"] as const;
export type PayoutSourceKind = (typeof PAYOUT_SOURCES)[number];

export type ContractFileStoreKind = "local" | "supabase";

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = value?.trim().toLowerCase();
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export interface AccountingConfig {
  readonly provider: AccountingProviderKind;
  /** Värdet som stod i miljön om det inte gick att tolka (visas som fel på sidan). */
  readonly providerInvalid: string | null;
  readonly outboxDir: string;
  readonly payoutSource: PayoutSourceKind;
  readonly contractFileStore: ContractFileStoreKind;
  readonly contractFileDir: string;
}

export function accountingConfig(env: NodeJS.ProcessEnv = process.env): AccountingConfig {
  const rawProvider = env.ACCOUNTING_PROVIDER?.trim() ?? "";
  const provider = pick(rawProvider, ACCOUNTING_PROVIDERS, "none");
  // Samma standardvärden som src/lib/env.ts: APP_ENV är development utanför next start,
  // och då är inloggningen dev.
  const appEnv = env.APP_ENV?.trim() || (env.NODE_ENV === "production" ? "" : "development");
  const authProvider = env.AUTH_PROVIDER?.trim() || (appEnv === "development" ? "dev" : "supabase");
  const devAuth = authProvider === "dev";
  return {
    provider,
    providerInvalid:
      rawProvider && provider === "none" && rawProvider.toLowerCase() !== "none"
        ? rawProvider
        : null,
    outboxDir: path.resolve(
      env.ACCOUNTING_OUTBOX_DIR?.trim() || path.join(process.cwd(), ".data", "outbox", "bokforing"),
    ),
    payoutSource: pick(env.PAYOUT_SOURCE, PAYOUT_SOURCES, "csv"),
    contractFileStore: pick(
      env.CONTRACT_FILE_STORE,
      ["local", "supabase"] as const,
      devAuth ? "local" : "supabase",
    ),
    contractFileDir: path.resolve(
      env.CONTRACT_FILE_DIR?.trim() || path.join(process.cwd(), ".data", "contracts"),
    ),
  };
}
