/**
 * Automatplattformar: vad Binderlab behöver från den plattform som automaterna körs på
 * (Awish/DingShang i dag). Allt i Binderlab efter det här gränssnittet (titlar, automater,
 * order, lager, rapporter, ekonomi) är oberoende av plattformen.
 *
 * Två nivåer:
 *
 *   1. Order in (krävs). Varje plattform levererar order som `FetchResult` (se
 *      src/import/adapter.ts): ordernummer, titel som plattformen skriver den, automatens
 *      namn/id, belopp i öre, tid i UTC och om ordern är betald. Den gemensamma pipelinen
 *      (src/import/pipeline.ts) gör resten: dubbletter, nya titlar, kö för okända automater,
 *      lagerhändelser och importlogg.
 *        - Filplattformar tar emot en uppladdad fil: `parseFile`.
 *        - API-plattformar öppnar en anslutning: `connect` → `PlatformConnection.readOrders`.
 *
 *   2. Mer (valfritt, styrs av `capabilities`): lista automater, läsa fack och saldo per
 *      automat, och skriva tillbaka (påfyllning, varor/priser). Saknas en förmåga visar
 *      Binderlab det som inte går (t.ex. "Saldo okänt") i stället för att gissa.
 *
 * Se src/server/platforms/README.md för hur en ny plattform läggs till.
 */

import type { DataSourceProvider, FetchResult } from "@/import/adapter";
import type { MappingOverride } from "@/import/mapping";

/** En plattform (ett leverantörsgränssnitt), inte en datakälla. */
export type PlatformId = "awish" | "manual_csv";

export interface PlatformCapabilities {
  /** Order hämtas automatiskt (schemalagt jobb) i stället för att laddas upp. */
  readonly automaticOrders: boolean;
  /** Tar emot uppladdade filer (CSV). */
  readonly acceptsFiles: boolean;
  /** Kan lista plattformens automater (med id och anslutning). */
  readonly listMachines: boolean;
  /** Kan läsa fack och antal per automat (saldo i automaten). */
  readonly readSlots: boolean;
  /** Kan skriva påfyllning (antal i facken) tillbaka till plattformen. */
  readonly writeRefill: boolean;
  /** Kan skapa och ändra varor och priser i plattformen. */
  readonly writeGoods: boolean;
}

/** Beskrivning av en plattform: ren data, går att använda i alla lager (även klienten). */
export interface PlatformInfo {
  readonly id: PlatformId;
  /** Namnet som visas i appen. */
  readonly name: string;
  /** data_sources.provider-värden som hör till plattformen. */
  readonly providers: readonly DataSourceProvider[];
  /** Den provider en ny datakälla för plattformen får (null = skapas inte av användaren här). */
  readonly fileProvider: DataSourceProvider | null;
  readonly capabilities: PlatformCapabilities;
  /** Var integrationen finns och vad den bygger på (för dokumentation och granskning). */
  readonly notes: string;
}

/** En automat i plattformen. */
export interface PlatformMachine {
  /** Plattformens id för automaten (source_machines.external_id). */
  readonly externalId: string;
  readonly name: string;
  /** Serie-/maskinnummer om plattformen har ett. */
  readonly deviceNo: string | null;
  /** Ansluten just nu; null = plattformen säger inget. */
  readonly online: boolean | null;
}

/** Ett fack i en automat. */
export interface PlatformSlot {
  /** Kanalens/fackets namn ("A3"), eller "" om plattformen inte har något. */
  readonly channel: string;
  /** Varan som plattformen skriver den, eller null för ett tomt fack utan vara. */
  readonly productName: string | null;
  readonly units: number;
  readonly capacity: number;
}

/** Indata för att tolka en uppladdad fil. */
export interface PlatformFileInput {
  readonly context: {
    organizationId: string;
    dataSourceId: string;
    sourceTimezone: string;
    config: Record<string, unknown>;
    secretRef: string | null;
  };
  readonly provider: DataSourceProvider;
  readonly file: { name: string; content: string | Uint8Array };
  readonly mapping?: MappingOverride;
}

/** En sida order från en API-plattform. */
export interface PlatformOrderPage {
  readonly result: FetchResult;
  /** Fler sidor finns (enligt plattformen). */
  readonly hasMore: boolean;
}

/** En öppen anslutning till en API-plattform. Stängs med close(). */
export interface PlatformConnection {
  readOrders(page: {
    page: number;
    perPage: number;
    sourceTimezone: string;
    /** Bara de här automaterna (plattformens id), om plattformen kan filtrera. */
    machineIds?: readonly string[];
  }): Promise<PlatformOrderPage>;
  listMachines?(): Promise<PlatformMachine[]>;
  readSlots?(machineExternalId: string): Promise<PlatformSlot[]>;
  close(): void;
}

/** Skrivning av påfyllning till plattformen, per organisation och automater i Binderlab. */
export interface PlatformRefillWriter {
  /**
   * Skriver Binderlabs antal per titel till automaternas fack. `status: "off"` när
   * plattformen inte är påslagen för organisationen; fel per automat står i `machines`.
   */
  pushRefill(
    organizationId: string,
    machineIds: readonly string[],
  ): Promise<{
    status: "off" | "done";
    machines: ReadonlyArray<{ machineId: string; ok: boolean; message?: string | null }>;
  }>;
}

/** En plattform med implementation (bara på servern). */
export interface MachinePlatform<Credentials = unknown> extends PlatformInfo {
  /** Filplattformar: tolka en uppladdad fil till order. */
  parseFile?(input: PlatformFileInput): Promise<FetchResult>;
  /** API-plattformar: öppna en anslutning med datakällans inloggning. */
  connect?(credentials: Credentials): PlatformConnection;
  /** Skriva påfyllning tillbaka (capabilities.writeRefill). */
  refill?: PlatformRefillWriter;
}
