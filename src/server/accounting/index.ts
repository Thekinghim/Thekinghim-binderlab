/**
 * Ekonomiområdet på servern (fas 9): avstämning av leverantörens utbetalningar, förslag på
 * verifikationer och SIE-export, kassaflöde, fasta kostnader och butiksavtal med avtalsfil.
 *
 * - ./service.ts   laddare och ändringar bundna till en Viewer (rollkontroll + RLS)
 * - ./queries.ts   frågorna (körs i användarens transaktion)
 * - ./payout-csv.ts / ./payout-source.ts   utbetalningsfilen och adaptern för API senare
 * - ./bookkeeping.ts   adapter för bokföringsprogram (ej konfigurerad / lokal utkorg)
 * - ./contract-files.ts   avtalsfiler (FileStore, bucket 'contracts')
 * - ./config.ts   miljövariabler
 */

export * from "./service";
export { currentViewer } from "./session";
export {
  bookkeepingAdapter,
  BookkeepingNotConfiguredError,
  type BookkeepingStatus,
} from "./bookkeeping";
export {
  contractFileStore,
  contractFileStoreStatus,
  CONTRACT_FILE_TYPES,
  MAX_CONTRACT_FILE_BYTES,
} from "./contract-files";
export { PAYOUT_FILE_COLUMNS, MAX_PAYOUT_FILE_BYTES } from "./payout-csv";
export type {
  AgreementRecord,
  ContractRecord,
  FixedCostRecord,
  PayoutImportRecord,
  PayoutRecord,
  ReviewRecord,
} from "./queries";
