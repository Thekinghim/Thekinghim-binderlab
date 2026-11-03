/**
 * Klient för Awish officiella gRPC-API (tjänsten provider.Provider, se
 * provider-proto.ts och docs/awish-api.md). Bara läsande anrop: Merchant,
 * Machines, Orders och Order.
 *
 * Inloggningen är metadata på varje anrop (leverantörens dokumentation, avsnitt
 * 8.1): `appid` = AppId, `token` = MD5 av `${AppSecret}.${AppKey}` som hex, och
 * `lang` = "en-US" (felmeddelandenas språk). Dokumentationens exempel (Rust,
 * `generate_md5`) ger gemener; det är OVERIFIERAT mot riktiga servern och ligger i
 * konstanten TOKEN_HEX_CASE så att det är lätt att byta.
 *
 * Varje anrop har en tidsgräns (15 s). UNAVAILABLE och DEADLINE_EXCEEDED provas
 * igen (högst 3 försök, 0,5 s och 1,5 s väntan); andra fel aldrig. Fel blir
 * AwishApiError med ett svenskt meddelande. Inloggningsuppgifterna skrivs aldrig
 * ut, inte heller i felmeddelanden.
 */

import "server-only";

import { createHash } from "node:crypto";

import * as grpc from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import protobuf from "protobufjs";

import type { AwishGrpcOrder } from "@/import/adapters/awish-grpc";

import { AWISH_PROVIDER_PROTO } from "./provider-proto";

/** Leverantörens server enligt dokumentationen (ingen TLS i exemplet). */
export const DEFAULT_AWISH_GRPC_ADDRESS = "49.51.72.74:50051";
/** OVERIFIERAT: dokumentationens exempel ger gemener. Byt till "upper" om servern nekar. */
export const TOKEN_HEX_CASE: "lower" | "upper" = "lower";
export const AWISH_LANG = "en-US";
export const AWISH_DEADLINE_MS = 15_000;
export const AWISH_MAX_ATTEMPTS = 3;
/** Dokumentationen (kinesiska varianten) anger högst 20 per sida. */
export const AWISH_PER_PAGE = 20;

export interface AwishCredentials {
  appId: string;
  appSecret: string;
  appKey: string;
}

export interface AwishClientOptions {
  address: string;
  tls: boolean;
  deadlineMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Absolut tidpunkt (ms) då körningen måste vara klar. Varje anrops tidsgräns
   * kortas till den tid som återstår, och inget nytt försök görs om det inte hinner.
   * Är tiden slut kastas AwishApiError med kind "budget" (inget anrop görs).
   */
  deadlineAt?: number;
  clock?: () => number;
}

/** Ett anrop påbörjas inte med mindre tid kvar än så här. */
export const AWISH_MIN_CALL_MS = 1_000;

/** Adress och TLS ur miljön (AWISH_GRPC_ADDRESS, AWISH_GRPC_TLS). */
export function awishClientConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): Pick<AwishClientOptions, "address" | "tls"> {
  const address = env.AWISH_GRPC_ADDRESS?.trim() || DEFAULT_AWISH_GRPC_ADDRESS;
  const tls = (env.AWISH_GRPC_TLS ?? "false").trim().toLowerCase() === "true";
  return { address, tls };
}

/** Token enligt dokumentationen: MD5 av "AppSecret.AppKey" som hex. */
export function awishToken(appSecret: string, appKey: string): string {
  const hex = createHash("md5").update(`${appSecret}.${appKey}`, "utf8").digest("hex");
  return TOKEN_HEX_CASE === "upper" ? hex.toUpperCase() : hex.toLowerCase();
}

export function awishMetadata(creds: AwishCredentials): grpc.Metadata {
  const md = new grpc.Metadata();
  md.set("appid", creds.appId);
  md.set("token", awishToken(creds.appSecret, creds.appKey));
  md.set("lang", AWISH_LANG);
  return md;
}

// ---------------------------------------------------------------------------
// Proto
// ---------------------------------------------------------------------------

const LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

let cachedDefinition: grpc.GrpcObject | null = null;

/** Paketdefinitionen ur den inbäddade proto-texten (ingen fil läses). */
export function awishPackage(): grpc.GrpcObject {
  if (cachedDefinition) return cachedDefinition;
  const root = new protobuf.Root();
  for (const file of [
    "google/protobuf/empty.proto",
    "google/protobuf/wrappers.proto",
    "google/protobuf/any.proto",
  ]) {
    const common = protobuf.common.get(file);
    if (!common) throw new Error(`protobufjs saknar ${file}.`);
    root.addJSON(common.nested ?? {});
  }
  protobuf.parse(AWISH_PROVIDER_PROTO, root, { keepCase: true });
  root.resolveAll();
  const definition = fromJSON(root.toJSON(), LOADER_OPTIONS);
  cachedDefinition = grpc.loadPackageDefinition(definition);
  return cachedDefinition;
}

/** Tjänstens konstruktor (används av klienten och av testernas låtsasserver). */
export function awishServiceConstructor(): grpc.ServiceClientConstructor {
  const pkg = awishPackage().provider as grpc.GrpcObject;
  return pkg.Provider as grpc.ServiceClientConstructor;
}

// ---------------------------------------------------------------------------
// Typer (efter tolkningen: uint64 som text, valfria fält kan saknas)
// ---------------------------------------------------------------------------

export interface AwishMerchant {
  id: string;
  title: string;
  status: string;
  expiredAt: string | null;
  /** Merchant.config.timezone finns inte i proto-filen; läses om servern ändå skickar den. */
  timezone: string | null;
}

export interface AwishMachine {
  id: string;
  name: string;
  machineNo: string;
  address: string | null;
  isOnline: boolean;
  status: string;
}

/** Samma form som adaptern tolkar (src/import/adapters/awish-grpc.ts). */
export type AwishOrder = AwishGrpcOrder;

export interface AwishPage<T> {
  items: T[];
  total: number | null;
  currentPage: number | null;
  perPage: number | null;
  lastPage: number | null;
  /** has_more (valfritt i proto-filen); null = skickades inte. */
  hasMore: boolean | null;
}

export interface AwishApi {
  merchant(): Promise<AwishMerchant>;
  machines(page: { currentPage: number; perPage: number }): Promise<AwishPage<AwishMachine>>;
  orders(page: {
    currentPage: number;
    perPage: number;
    machineIds?: string[];
  }): Promise<AwishPage<AwishOrder>>;
  order(id: string): Promise<AwishOrder | null>;
  close(): void;
}

type Obj = Record<string, unknown>;

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function optStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "" ? null : s;
}

function optInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function obj(value: unknown): Obj {
  return value && typeof value === "object" ? (value as Obj) : {};
}

export function toMerchant(raw: unknown): AwishMerchant {
  const m = obj(raw);
  const config = obj(m.config);
  return {
    id: str(m.id),
    title: str(m.title),
    status: str(m.status),
    expiredAt: optStr(m.expired_at),
    timezone: optStr(config.timezone),
  };
}

export function toMachine(raw: unknown): AwishMachine {
  const m = obj(raw);
  return {
    id: str(m.id),
    name: str(m.name),
    machineNo: str(m.machine_no),
    address: optStr(m.address),
    isOnline: m.is_online === true,
    status: str(m.status),
  };
}

export function toOrder(raw: unknown): AwishOrder {
  const o = obj(raw);
  const records = Array.isArray(o.order_records) ? o.order_records : [];
  return {
    id: str(o.id),
    date: str(o.date),
    tradeId: optStr(o.trade_id),
    title: optStr(o.title),
    amount: str(o.amount),
    payTime: optStr(o.pay_time),
    status: str(o.status),
    isFree: o.is_free === true,
    taxTotal: optStr(o.tax_total),
    pickupCodeId: optStr(o.pickup_code_id),
    paymentId: str(o.payment_id),
    machineId: str(o.machine_id),
    records: records.map((r) => {
      const rec = obj(r);
      return {
        productId: str(rec.product_id),
        quantity: str(rec.quantity),
        price: str(rec.price),
      };
    }),
    totalCashAmount: optStr(o.total_cash_amount),
    changeCashAmount: optStr(o.change_cash_amount),
  };
}

function pageOf<T>(raw: unknown, map: (item: unknown) => T): AwishPage<T> {
  const r = obj(raw);
  const data = Array.isArray(r.data) ? r.data : [];
  return {
    items: data.map(map),
    total: optInt(r.total),
    currentPage: optInt(r.current_page),
    perPage: optInt(r.per_page),
    lastPage: optInt(r.last_page),
    hasMore: typeof r.has_more === "boolean" ? r.has_more : null,
  };
}

// ---------------------------------------------------------------------------
// Fel
// ---------------------------------------------------------------------------

export type AwishErrorKind =
  | "auth"
  | "not_found"
  | "unavailable"
  | "timeout"
  | "invalid_response"
  | "server"
  /** Körningens tidsgräns (deadlineAt) nåddes; fortsätter nästa körning. */
  | "budget";

export class AwishApiError extends Error {
  readonly kind: AwishErrorKind;
  readonly grpcCode: number | null;

  constructor(kind: AwishErrorKind, message: string, grpcCode: number | null = null) {
    super(message);
    this.name = "AwishApiError";
    this.kind = kind;
    this.grpcCode = grpcCode;
  }

  get retryable(): boolean {
    return this.kind === "unavailable" || this.kind === "timeout";
  }
}

/** Awish mellanprogram svarar med korta engelska meddelanden; de blir svenska här. */
const KNOWN_MESSAGES: Array<{ match: RegExp; kind: AwishErrorKind; text: string }> = [
  {
    match: /appid is missing|missing appid/i,
    kind: "auth",
    text: "Awish fick inget AppId. Spara AppId under Datakällor igen.",
  },
  {
    match: /merchant (is )?not found|merchant does not exist/i,
    kind: "auth",
    text: "Awish hittar inget konto med det AppId. Kontrollera AppId under Datakällor.",
  },
  {
    match: /token is missing|missing token/i,
    kind: "auth",
    text: "Awish fick ingen token. Spara AppSecret och AppKey under Datakällor igen.",
  },
  {
    // Bara mellanprogrammets text om kontot, inte t.ex. "certificate has expired".
    match: /merchant (has |is )?expired|account (has |is )?expired/i,
    kind: "auth",
    text: "Awish-kontot har gått ut. Förläng det hos Awish (Merchant → Merchant Detail).",
  },
  {
    match: /permission denied|invalid token|token (is )?invalid|invalid signature|unauthori[sz]ed/i,
    kind: "auth",
    text: "Awish nekade anropet. AppSecret eller AppKey stämmer inte. Kontrollera dem under Merchant → Developer Center.",
  },
];

/** Gör ett gRPC-fel till AwishApiError. Meddelandet innehåller aldrig hemligheter. */
export function mapGrpcError(error: unknown, address: string): AwishApiError {
  if (error instanceof AwishApiError) return error;
  const e = obj(error);
  const code = typeof e.code === "number" ? e.code : null;
  const details = typeof e.details === "string" ? e.details : String(e.message ?? "");
  // Transportfel avgörs av koden, inte av texten (t.ex. "certificate has expired" vid
  // TLS är UNAVAILABLE och ska provas igen, inte bli ett inloggningsfel).
  if (code === grpc.status.UNAVAILABLE) {
    return new AwishApiError(
      "unavailable",
      `Awish svarar inte (${address}). Synken försöker igen om tio minuter.`,
      code,
    );
  }
  if (code === grpc.status.DEADLINE_EXCEEDED) {
    return new AwishApiError(
      "timeout",
      `Awish svarade inte inom ${AWISH_DEADLINE_MS / 1000} sekunder.`,
      code,
    );
  }
  for (const known of KNOWN_MESSAGES) {
    if (known.match.test(details)) return new AwishApiError(known.kind, known.text, code);
  }
  switch (code) {
    case grpc.status.UNAUTHENTICATED:
    case grpc.status.PERMISSION_DENIED:
      return new AwishApiError(
        "auth",
        "Awish nekade anropet. Kontrollera AppId, AppSecret och AppKey under Datakällor.",
        code,
      );
    case grpc.status.NOT_FOUND:
      return new AwishApiError("not_found", "Awish hittade inte det som efterfrågades.", code);
    case grpc.status.UNIMPLEMENTED:
      return new AwishApiError(
        "server",
        "Awish-servern känner inte till anropet. Proto-filen kan vara inaktuell.",
        code,
      );
    default: {
      const clean = details.replace(/\s+/g, " ").trim().slice(0, 200);
      return new AwishApiError(
        "server",
        `Awish svarade med ett fel${code === null ? "" : ` (gRPC-kod ${code})`}${clean ? `: ${clean}` : ""}.`,
        code,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Klienten
// ---------------------------------------------------------------------------

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const BACKOFF_MS = [500, 1500];

/** Fel när körningens tidsgräns nås: inget mer hämtas, nästa körning fortsätter. */
export function budgetError(): AwishApiError {
  return new AwishApiError(
    "budget",
    "Körningens tidsgräns nåddes innan Awish hann svara. Synken fortsätter nästa gång.",
  );
}

function isLoopback(address: string): boolean {
  const host = address
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

let warnedPlaintext = false;

/** En varning per process: utan TLS går token (MD5 av AppSecret.AppKey) i klartext. */
function warnPlaintextOnce(address: string): void {
  if (warnedPlaintext || isLoopback(address)) return;
  warnedPlaintext = true;
  console.warn(
    `[awish] gRPC till ${address} utan TLS: appid och token skickas okrypterat (AWISH_GRPC_TLS=false). Se docs/awish-api.md, Säkerhet.`,
  );
}

type Unary = (
  request: Obj,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: unknown) => void,
) => void;

export function createAwishClient(creds: AwishCredentials, options: AwishClientOptions): AwishApi {
  const Ctor = awishServiceConstructor();
  if (!options.tls) warnPlaintextOnce(options.address);
  const credentials = options.tls
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();
  const client = new Ctor(options.address, credentials, {
    "grpc.max_receive_message_length": 16 * 1024 * 1024,
  });
  const deadlineMs = options.deadlineMs ?? AWISH_DEADLINE_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? AWISH_MAX_ATTEMPTS);
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.clock ?? Date.now;
  const remaining = (): number =>
    options.deadlineAt === undefined ? Number.POSITIVE_INFINITY : options.deadlineAt - clock();

  const once = (method: string, request: Obj, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const fn = (client as unknown as Record<string, Unary>)[method];
      if (typeof fn !== "function") {
        reject(new AwishApiError("server", `Okänt anrop ${method}.`));
        return;
      }
      fn.call(
        client,
        request,
        awishMetadata(creds),
        { deadline: new Date(Date.now() + timeoutMs) },
        (error, response) => (error ? reject(error) : resolve(response)),
      );
    });

  const call = async (method: string, request: Obj): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      const left = remaining();
      if (left < AWISH_MIN_CALL_MS) throw budgetError();
      const timeoutMs = Math.min(deadlineMs, Math.floor(left));
      try {
        return await once(method, request, timeoutMs);
      } catch (error) {
        const mapped = mapGrpcError(error, options.address);
        // Tidsgränsen kortades av körningens budget: det är budgeten som tog slut.
        if (mapped.kind === "timeout" && timeoutMs < deadlineMs) throw budgetError();
        if (!mapped.retryable || attempt >= maxAttempts) throw mapped;
        const backoff = BACKOFF_MS[attempt - 1] ?? 1500;
        // Hinner nästa försök inte med, ges felet direkt.
        if (remaining() - backoff < AWISH_MIN_CALL_MS) throw mapped;
        await sleep(backoff);
      }
    }
  };

  return {
    async merchant() {
      const res = obj(await call("Merchant", {}));
      return toMerchant(res.data);
    },
    async machines(page) {
      return pageOf(
        await call("Machines", { current_page: page.currentPage, per_page: page.perPage }),
        toMachine,
      );
    },
    async orders(page) {
      const request: Obj = { current_page: page.currentPage, per_page: page.perPage };
      if (page.machineIds && page.machineIds.length > 0) request.machine_ids = page.machineIds;
      return pageOf(await call("Orders", request), toOrder);
    },
    async order(id) {
      const res = obj(await call("Order", { id }));
      return res.data ? toOrder(res.data) : null;
    },
    close() {
      client.close();
    },
  };
}
