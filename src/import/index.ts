/**
 * Import av order från datakällor. Se docs/awish.md och docs/datamodell.md (avsnitt 4).
 *
 * Servern använder `runImport` (förhandsvisning och import av en fil). Rena
 * delar (belopp, tid, mappning, CSV) kan användas var som helst.
 */

export * from "./adapter";
export * from "./amount";
export * from "./errors";
export * from "./mapping";
export * from "./zoned";
export {
  parseCsvTable,
  decodeFile,
  MAX_FILE_BYTES,
  type CsvRecord,
  type CsvTable,
} from "./csv-table";
export {
  awishCsvAdapter,
  parseAwishCsv,
  AWISH_CSV_PARSER_VERSION,
  type AwishCsvInput,
} from "./adapters/awish-csv";
export {
  awishGrpcAdapter,
  assertSecretRefInNamespace,
  mapAwishOrders,
  AWISH_GRPC_PARSER_VERSION,
  type AwishGrpcInput,
  type AwishGrpcOrder,
  type AwishGrpcMachine,
} from "./adapters/awish-grpc";
