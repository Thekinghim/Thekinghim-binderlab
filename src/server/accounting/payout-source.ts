/**
 * Varifrån leverantörens utbetalningar kommer.
 *
 * Gränssnittet är detsamma som för orderna (`SourceAdapter` i src/import): adaptern hämtar
 * eller tolkar källan, allt efter den (dubbletter, konflikter, logg) är gemensamt i
 * ./service.ts.
 *
 * - `CsvPayoutSource` (nu): en uppladdad fil, tolkad av ./payout-csv.ts.
 * - `AwishPayoutApi` (senare): hämtning från Awish (betalväxelns avräkning). Kastar
 *   `PayoutSourceNotConfiguredError` tills Awish har lämnat dokumentation för avräkningen
 *   (se `AWISH_PAYOUT_MISSING`). Väljs med PAYOUT_SOURCE=awish_api.
 */

import "server-only";

import { accountingConfig, type PayoutSourceKind } from "./config";
import {
  parsePayoutFile,
  type ParsedPayout,
  type ParsedPayoutLine,
  type PayoutFileError,
  type PayoutFileFormat,
} from "./payout-csv";

export interface PayoutBatch {
  readonly format: PayoutFileFormat;
  readonly payouts: readonly ParsedPayout[];
  readonly lines: readonly ParsedPayoutLine[];
  readonly errors: readonly PayoutFileError[];
  readonly rows: number;
  /** Markören till nästa hämtning (API), null för en fil. */
  readonly nextCursor: string | null;
}

export interface PayoutSource {
  readonly kind: PayoutSourceKind;
  fetch(cursor: string | null): Promise<PayoutBatch>;
}

export class PayoutSourceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutSourceNotConfiguredError";
  }
}

/** Det som saknas från Awish för att hämta utbetalningar automatiskt. */
export const AWISH_PAYOUT_MISSING = [
  "Dokumentation för avräkningen (settlement): metod, fält, paginering och markör.",
  "Hur avgifter och återbetalningar redovisas per utbetalning och per order.",
  "Exempel på en utbetalning med specifikation per order (ordernummer och belopp).",
  "Vilken tidszon perioderna räknas i.",
] as const;

export class CsvPayoutSource implements PayoutSource {
  readonly kind = "csv" as const;
  constructor(private readonly content: Uint8Array | string) {}

  async fetch(): Promise<PayoutBatch> {
    const parsed = parsePayoutFile(this.content);
    return { ...parsed, nextCursor: null };
  }
}

export class AwishPayoutApi implements PayoutSource {
  readonly kind = "awish_api" as const;

  async fetch(): Promise<PayoutBatch> {
    throw new PayoutSourceNotConfiguredError(
      `Hämtning av utbetalningar från Awish är inte kopplad. Det som saknas: ${AWISH_PAYOUT_MISSING.join(" ")}`,
    );
  }
}

/** Läget för den automatiska hämtningen (för sidan). */
export function payoutSourceStatus(): {
  kind: PayoutSourceKind;
  automatic: boolean;
  detail: string;
} {
  const kind = accountingConfig().payoutSource;
  return kind === "awish_api"
    ? {
        kind,
        automatic: false,
        detail:
          "Hämtning från Awish är vald men inte kopplad. Ladda upp utbetalningarna som CSV så länge.",
      }
    : { kind, automatic: false, detail: "Utbetalningarna laddas upp som CSV från Awish." };
}
