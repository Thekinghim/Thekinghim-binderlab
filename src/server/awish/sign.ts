/**
 * Signering av Awishs "riskabla" skrivningar (gRPC-API v1.2.40+, AW-DOC-110 avsnitt 8.13).
 *
 * Dokumentationen fastställer:
 *   meddelande = `${timestamp}.${request_body}`
 *   sign       = HMAC-SHA256(nyckel = appid, meddelande) som hex med gemener
 *   timestamp  = Unix-sekunder; servern godtar ±300 s (Some(300)).
 *
 * Vad request_body är står inte i dokumentationen. Awishs referensbibliotek
 * (@cakioe/hmac-signer 1.0.5, wasm byggt av Rust) gör `JSON.stringify(body)` i JS och
 * serialiserar sedan om objektet med serde_json och BTreeMap (sorterade nycklar), och kräver
 * att det är ett JSON-objekt där fälten "sign" och "timestamp" inte räknas med. Därför är
 * standardformen här: begäran som JSON-objekt utan sign och timestamp, kompakt och med
 * nycklarna sorterade (rekursivt).
 *
 * Det som fortfarande är osäkert är hur Awish bygger om JSON från protobuf (tas ej satta
 * fält med eller blir de null? Blir id tal?). Därför finns tre lägen (AwishSignMode), och
 * "Testa signering" under Datakällor provar dem mot Awish och sparar det som fungerar.
 *
 * Signaturen loggas aldrig; granskningsraderna sparar begäran utan sign och timestamp.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import protobuf from "protobufjs";

import {
  DOC_SIGN_FIELD,
  DOC_TIMESTAMP_FIELD,
  signFieldsFromEnv,
  withDocSignFields,
  type AwishSignFields,
} from "./proto-doc-fields";
import { AWISH_PROVIDER_PROTO } from "./provider-proto";

/** Hur request_body byggs. present_sorted är standard. */
export type AwishSignMode = "present_sorted" | "full_sorted" | "present_proto_order";

export const AWISH_SIGN_MODES: readonly AwishSignMode[] = [
  "present_sorted",
  "full_sorted",
  "present_proto_order",
];

export const DEFAULT_AWISH_SIGN_MODE: AwishSignMode = "present_sorted";

/** Servern godtar en tidsskillnad på högst så här många sekunder (Some(300)). */
export const AWISH_SIGN_TOLERANCE_S = 300;

export function isAwishSignMode(value: unknown): value is AwishSignMode {
  return typeof value === "string" && (AWISH_SIGN_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Proto-reflektion (vilka fält är 64-bitars heltal, uppräkningar och meddelanden)
// ---------------------------------------------------------------------------

let cachedRoot: protobuf.Root | null = null;

function protoRoot(): protobuf.Root {
  if (cachedRoot) return cachedRoot;
  const root = new protobuf.Root();
  for (const file of [
    "google/protobuf/empty.proto",
    "google/protobuf/wrappers.proto",
    "google/protobuf/any.proto",
    "google/protobuf/struct.proto",
  ]) {
    const common = protobuf.common.get(file);
    if (!common) throw new Error(`protobufjs saknar ${file}.`);
    root.addJSON(common.nested ?? {});
  }
  protobuf.parse(withDocSignFields(AWISH_PROVIDER_PROTO), root, { keepCase: true });
  root.resolveAll();
  cachedRoot = root;
  return root;
}

function messageType(name: string): protobuf.Type {
  const full = name.includes(".") ? name : `provider.${name}`;
  return protoRoot().lookupType(full);
}

const LONG_TYPES = new Set(["int64", "uint64", "sint64", "fixed64", "sfixed64"]);
const INT_TYPES = new Set(["int32", "uint32", "sint32", "fixed32", "sfixed32"]);
const SKIPPED_TOP_LEVEL = new Set(["sign", "timestamp", DOC_SIGN_FIELD, DOC_TIMESTAMP_FIELD]);

/** Har meddelandet dokumentationens extra fält 10/11 (se proto-doc-fields.ts)? */
export function hasDocSignFields(messageTypeName: string): boolean {
  return Boolean(messageType(messageTypeName).fields[DOC_SIGN_FIELD]);
}
const INTEGER_TEXT = /^-?\d+$/;

/** Ett JSON-värde där stora heltal hålls som text och skrivs utan citattecken. */
type Canon =
  { t: "raw"; v: string } | { t: "arr"; v: Canon[] } | { t: "obj"; v: Array<[string, Canon]> };

function isOptional(field: protobuf.Field): boolean {
  return (field.options as Record<string, unknown> | undefined)?.proto3_optional === true;
}

function longText(value: unknown, where: string): string {
  const text =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : typeof value === "string"
          ? value.trim()
          : "";
  if (!INTEGER_TEXT.test(text)) throw new TypeError(`${where}: inget heltal.`);
  // Inledande nollor (utom "0") är inte giltig JSON.
  return text.replace(/^(-?)0+(?=\d)/, "$1");
}

function scalar(field: protobuf.Field, value: unknown, where: string): Canon {
  if (field.resolvedType instanceof protobuf.Enum) {
    const values = field.resolvedType.values;
    if (typeof value === "string" && value in values) {
      return { t: "raw", v: String(values[value]) };
    }
    if (typeof value === "number" && Number.isInteger(value)) return { t: "raw", v: String(value) };
    throw new TypeError(`${where}: okänt värde.`);
  }
  if (LONG_TYPES.has(field.type)) return { t: "raw", v: longText(value, where) };
  if (INT_TYPES.has(field.type)) {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n))
      throw new TypeError(`${where}: inget heltal.`);
    return { t: "raw", v: String(n) };
  }
  if (field.type === "double" || field.type === "float") {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new TypeError(`${where}: inget tal.`);
    return { t: "raw", v: JSON.stringify(n) };
  }
  if (field.type === "bool") {
    if (typeof value !== "boolean") throw new TypeError(`${where}: inte sant/falskt.`);
    return { t: "raw", v: value ? "true" : "false" };
  }
  if (field.type === "string") {
    if (typeof value !== "string") throw new TypeError(`${where}: ingen text.`);
    return { t: "raw", v: JSON.stringify(value) };
  }
  throw new TypeError(`${where}: fälttypen ${field.type} signeras inte.`);
}

function defaultOf(field: protobuf.Field): Canon {
  if (field.repeated) return { t: "arr", v: [] };
  if (isOptional(field)) return { t: "raw", v: "null" };
  if (field.resolvedType instanceof protobuf.Type) return { t: "raw", v: "null" };
  if (field.resolvedType instanceof protobuf.Enum) return { t: "raw", v: "0" };
  if (LONG_TYPES.has(field.type) || INT_TYPES.has(field.type)) return { t: "raw", v: "0" };
  if (field.type === "double" || field.type === "float") return { t: "raw", v: "0" };
  if (field.type === "bool") return { t: "raw", v: "false" };
  if (field.type === "string") return { t: "raw", v: '""' };
  return { t: "raw", v: "null" };
}

function isWireDefault(field: protobuf.Field, value: unknown): boolean {
  if (field.repeated) return Array.isArray(value) && value.length === 0;
  if (isOptional(field) || field.resolvedType instanceof protobuf.Type) return false;
  if (field.resolvedType instanceof protobuf.Enum) {
    return value === 0 || (typeof value === "string" && field.resolvedType.values[value] === 0);
  }
  if (LONG_TYPES.has(field.type) || INT_TYPES.has(field.type)) {
    return value === 0 || value === "0" || value === 0n;
  }
  if (field.type === "double" || field.type === "float") return value === 0;
  if (field.type === "bool") return value === false;
  if (field.type === "string") return value === "";
  return false;
}

function canonMessage(
  type: protobuf.Type,
  value: Record<string, unknown>,
  mode: AwishSignMode,
  topLevel: boolean,
  path: string,
): Canon {
  for (const key of Object.keys(value)) {
    if (topLevel && SKIPPED_TOP_LEVEL.has(key)) continue;
    // Virtuella oneof-fält som proto-loader lägger till (t.ex. "_title": "title").
    if (type.oneofs?.[key]) continue;
    if (!type.fields[key] && value[key] !== undefined && value[key] !== null) {
      throw new TypeError(`${path}.${key}: fältet finns inte i ${type.name}.`);
    }
  }
  const entries: Array<[string, Canon, number]> = [];
  for (const field of type.fieldsArray) {
    if (topLevel && SKIPPED_TOP_LEVEL.has(field.name)) continue;
    const raw = value[field.name];
    const where = `${path}.${field.name}`;
    if (raw === undefined || raw === null) {
      if (mode === "full_sorted") entries.push([field.name, defaultOf(field), field.id]);
      continue;
    }
    // "present": det som går över tråden. Ett vanligt (inte optional) skalärt fält med
    // standardvärdet skickas inte av protobuf, så servern kan inte se det; en tom lista inte
    // heller. Optional-fält och meddelanden har närvaro och räknas när de är satta.
    if (mode !== "full_sorted" && isWireDefault(field, raw)) continue;
    let canon: Canon;
    if (field.repeated) {
      if (!Array.isArray(raw)) throw new TypeError(`${where}: ingen lista.`);
      canon = {
        t: "arr",
        v: raw.map((item, i) => one(field, item, mode, `${where}[${i}]`)),
      };
    } else {
      canon = one(field, raw, mode, where);
    }
    entries.push([field.name, canon, field.id]);
  }
  if (mode === "present_proto_order") entries.sort((a, b) => a[2] - b[2]);
  else entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { t: "obj", v: entries.map(([k, c]) => [k, c]) };
}

function one(field: protobuf.Field, value: unknown, mode: AwishSignMode, where: string): Canon {
  if (field.resolvedType instanceof protobuf.Type) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${where}: inget objekt.`);
    }
    return canonMessage(field.resolvedType, value as Record<string, unknown>, mode, false, where);
  }
  return scalar(field, value, where);
}

function write(c: Canon): string {
  if (c.t === "raw") return c.v;
  if (c.t === "arr") return `[${c.v.map(write).join(",")}]`;
  return `{${c.v.map(([k, v]) => `${JSON.stringify(k)}:${write(v)}`).join(",")}}`;
}

/**
 * request_body för ett meddelande: begäran (proto-namn med understreck) utan sign och
 * timestamp, kompakt JSON. Kastar TypeError om ett fält inte finns i meddelandet eller har
 * fel typ (då skickas ingenting).
 */
export function canonicalBody(
  messageTypeName: string,
  request: Record<string, unknown>,
  mode: AwishSignMode = DEFAULT_AWISH_SIGN_MODE,
): string {
  const type = messageType(messageTypeName);
  return write(canonMessage(type, request, mode, true, type.name));
}

/** HMAC-SHA256(appid, `${timestamp}.${body}`) som hex med gemener. */
export function awishSignature(appId: string, timestamp: number, body: string): string {
  return createHmac("sha256", Buffer.from(appId, "utf8"))
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
}

/**
 * Begäran med timestamp (nu, i sekunder) och sign. Begäran i övrigt ändras inte. För de sju
 * meddelandena där dokumentationen och proto-filen har olika fältnummer skickas samma
 * timestamp och sign även som doc_timestamp/doc_sign (fält 10/11), efter `fields`
 * (standard AWISH_SIGN_FIELDS, annars "both").
 */
export function signRequest<T extends Record<string, unknown>>(
  messageTypeName: string,
  request: T,
  appId: string,
  opts: { mode?: AwishSignMode; nowSeconds?: number; fields?: AwishSignFields } = {},
): T & { timestamp: number; sign: string } {
  const timestamp = Math.floor(opts.nowSeconds ?? Date.now() / 1000);
  const body = canonicalBody(messageTypeName, request, opts.mode ?? DEFAULT_AWISH_SIGN_MODE);
  const clean = Object.fromEntries(
    Object.entries(request).filter(
      ([k, v]) => !SKIPPED_TOP_LEVEL.has(k) && v !== undefined && v !== null,
    ),
  ) as T;
  const sign = awishSignature(appId, timestamp, body);
  if (!hasDocSignFields(messageTypeName)) return { ...clean, timestamp, sign };
  const fields = opts.fields ?? signFieldsFromEnv();
  const doc = { [DOC_TIMESTAMP_FIELD]: timestamp, [DOC_SIGN_FIELD]: sign };
  // Utan proto-filens sign/timestamp (servern läser bara 10/11).
  if (fields === "doc")
    return { ...clean, ...doc } as unknown as T & { timestamp: number; sign: string };
  if (fields === "proto") return { ...clean, timestamp, sign };
  return { ...clean, timestamp, sign, ...doc };
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Kontrollerar en signerad begäran som Awishs server gör (används av låtsas-Awish i
 * testerna). toleranceS null = ingen tidskontroll (Rusts None).
 */
export function verifyAwishSignature(a: {
  appId: string;
  messageType: string;
  request: Record<string, unknown>;
  mode: AwishSignMode;
  nowSeconds: number;
  toleranceS?: number | null;
  /** Vilka fältnummer servern läser (låtsas-Awish): proto-filens eller dokumentationens. */
  fields?: "proto" | "doc";
}): "ok" | "bad_sign" | "out_of_window" | "missing" {
  const doc = a.fields === "doc" && hasDocSignFields(a.messageType);
  const sign = doc ? a.request[DOC_SIGN_FIELD] : a.request.sign;
  const timestamp = Number(doc ? a.request[DOC_TIMESTAMP_FIELD] : a.request.timestamp);
  if (sign === undefined || sign === null || sign === "") return "missing";
  if (typeof sign !== "string" || !HEX_64.test(sign)) return "bad_sign";
  if (!Number.isSafeInteger(timestamp)) return "bad_sign";
  const tolerance = a.toleranceS === undefined ? AWISH_SIGN_TOLERANCE_S : a.toleranceS;
  if (tolerance !== null && Math.abs(a.nowSeconds - timestamp) > tolerance) {
    return "out_of_window";
  }
  let body: string;
  try {
    body = canonicalBody(a.messageType, a.request, a.mode);
  } catch {
    return "bad_sign";
  }
  const expected = Buffer.from(awishSignature(a.appId, timestamp, body), "hex");
  const given = Buffer.from(sign, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given) ? "ok" : "bad_sign";
}

/** Begäran utan sign och timestamp (för granskningsloggen). */
export function withoutSignature<T extends Record<string, unknown>>(
  request: T,
): Omit<T, "sign" | "timestamp"> {
  const { sign: _sign, timestamp: _timestamp, ...rest } = request;
  void _sign;
  void _timestamp;
  delete (rest as Record<string, unknown>)[DOC_SIGN_FIELD];
  delete (rest as Record<string, unknown>)[DOC_TIMESTAMP_FIELD];
  return rest;
}
