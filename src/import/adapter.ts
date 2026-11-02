/**
 * Adaptermönstret för datakällor. En adapter hämtar och tolkar källans order
 * till `RawOrder` och vet ingenting om databasen. Allt efter adaptern (titlar,
 * automater, deduplicering, logg, lagerhändelser) är gemensamt och ligger i
 * `pipeline.ts`, så CSV, gRPC och en eventuell webbhämtning går genom exakt
 * samma kod.
 */

/** En order från källan, tolkad men inte kopplad. Belopp i öre, tid i UTC. */
export interface RawOrder {
  /** Källans ordernummer (Awish "Order No."). Unikt per datakälla. */
  externalId: string;
  /** Produktnamnet som källan skriver det ("Name"). Sparas oförändrat. */
  rawTitle: string;
  /** Källans namn på automaten ("Order Machine"). */
  sourceMachineName: string;
  /** Källans id för automaten, om källan har ett (gRPC). CSV saknar det. */
  sourceMachineId?: string;
  paymentMethod: string | null;
  amountOre: number;
  paidAtUtc: Date;
  isPaid: boolean;
  /** Rad i filen (CSV) eller löpnummer i hämtningen (API), från 1. */
  sourceRowNumber: number;
  /** Källraden som den var (rubrik → värde), sparas i import_rows.raw. */
  raw: Record<string, string>;
  /** Anmärkningar från tolkningen, t.ex. tvetydig tid vid sommartid. */
  notes?: string[];
}

/** En rad som inte gick att tolka till en order. */
export interface RawRowError {
  sourceRowNumber: number;
  raw: Record<string, string>;
  message: string;
  externalId?: string;
  /** false = raden är inte betald (räknas som ej betald, inte som fel). */
  isPaid: boolean | null;
}

/** En automat som källan känner till. */
export interface RawMachine {
  /** Nyckeln i source_machines.external_id: källans id, annars namnet. */
  externalId: string;
  externalName: string | null;
  externalDeviceNo?: string | null;
}

export interface FetchResult {
  rows: RawOrder[];
  machines: RawMachine[];
  /** Rader som inte gick att tolka (felrader och ej betalda med fel). */
  errors: RawRowError[];
  /** Markör för nästa hämtning (API). Saknas för filer. */
  nextCursor?: string;
  /** Tolkarens version, sparas i imports.parser_version. */
  parserVersion: string;
  /** Mappningen som användes (filer), sparas i imports.mapping. */
  mapping?: object;
}

/** Inställningar från datakällan som adaptern behöver. */
export interface AdapterContext {
  organizationId: string;
  dataSourceId: string;
  /** Källans tidszon (data_sources.source_timezone), t.ex. Asia/Shanghai. */
  sourceTimezone: string;
  /** data_sources.config (sparad kolumnmappning, merchant-id ...). */
  config: Record<string, unknown>;
  /** data_sources.secret_ref (namnet på hemligheten, aldrig värdet). */
  secretRef: string | null;
}

export type DataSourceProvider = "awish_csv" | "awish_grpc" | "awish_web";

/** Indata till en adapter: alltid datakällans inställningar, plus adapterns egna. */
export interface AdapterInput {
  context: AdapterContext;
}

export interface SourceAdapter<Input extends AdapterInput = AdapterInput> {
  readonly provider: DataSourceProvider;
  fetch(input: Input, cursor?: string): Promise<FetchResult>;
}

/** Nyckeln som en order kopplas till automaten med (source_machines.external_id). */
export function machineKeyOf(
  order: Pick<RawOrder, "sourceMachineId" | "sourceMachineName">,
): string {
  return order.sourceMachineId ?? order.sourceMachineName;
}
