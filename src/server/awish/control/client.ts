/**
 * Klient för de nya anropen i Awishs gRPC-API v1.2.41 (AwishControlApi i ./types.ts).
 *
 * - Läsningar provas upp till tre gånger vid UNAVAILABLE/DEADLINE_EXCEEDED (0,5 s, 1,5 s).
 * - Skrivningar signeras (../sign.ts) och provas ALDRIG igen automatiskt: ett nytt försök
 *   efter ett avbrutet svar kunde starta om automaten två gånger eller mata ut två pack.
 *   Tidsgräns 10 s; uteblir svaret blir utfallet "okänt" (AwishUnknownOutcomeError).
 * - Under testerna (VITEST eller NODE_ENV=test) vägrar klienten andra adresser än
 *   127.0.0.1/localhost, så att ett test aldrig når riktiga Awish.
 *
 * Inloggningsuppgifter och signaturer skrivs aldrig ut.
 */

import "server-only";

import * as grpc from "@grpc/grpc-js";

import {
  AWISH_DEADLINE_MS,
  AwishApiError,
  awishMetadata,
  awishServiceConstructor,
  type AwishCredentials,
  type AwishPage,
} from "../grpc-client";
import { DEFAULT_AWISH_SIGN_MODE, signRequest, type AwishSignMode } from "../sign";
import { AwishControlInputError, mapControlError } from "./errors";
import type {
  AwishCategory,
  AwishChannelInfo,
  AwishControlApi,
  AwishControlWriteResult,
  AwishCurrencyInfo,
  AwishGoodInput,
  AwishMachineConfig,
  AwishMachineDetail,
  AwishMember,
  AwishMemberPatch,
  AwishMerchantDetail,
  AwishProductDetail,
} from "./types";

/** Tidsgräns för en skrivning: användaren väntar på svaret. */
export const CONTROL_WRITE_DEADLINE_MS = 10_000;
const READ_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500];

export interface ControlClientOptions {
  address: string;
  tls: boolean;
  signMode?: AwishSignMode;
  deadlineMs?: number;
  writeDeadlineMs?: number;
  /** Klockan i ms (signeringens timestamp). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function optStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "" ? null : s;
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function optNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isLoopback(address: string): boolean {
  const host = address
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** Kastar om ett test försöker nå något annat än låtsas-Awish på 127.0.0.1. */
export function assertTestSafeAddress(
  address: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const testing = Boolean(env.VITEST) || env.NODE_ENV === "test";
  if (testing && !isLoopback(address)) {
    throw new Error(`Tester får inte anropa Awish (${address}). Använd låtsas-Awish.`);
  }
}

/** google.protobuf.Struct (som proto-loader ger den) som vanligt objekt. */
export function structToPlain(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const s = obj(value);
  if (!("fields" in s)) return Object.keys(s).length > 0 ? s : null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj(s.fields))) out[k] = valueToPlain(v);
  return out;
}

function valueToPlain(value: unknown): unknown {
  const v = obj(value);
  const kind = typeof v.kind === "string" ? v.kind : null;
  const pick = (k: string) => kind === k || (kind === null && k in v && v[k] !== undefined);
  if (pick("nullValue")) return null;
  if (pick("stringValue")) return str(v.stringValue);
  if (pick("numberValue")) return Number(v.numberValue);
  if (pick("boolValue")) return v.boolValue === true;
  if (pick("structValue")) return structToPlain(v.structValue);
  if (pick("listValue")) {
    const values = obj(v.listValue).values;
    return Array.isArray(values) ? values.map(valueToPlain) : [];
  }
  return null;
}

/** SuccessResponse: code 0 eller 2xx är lyckat, annars AwishApiError med Awishs text. */
export function toControlWriteResult(raw: unknown): AwishControlWriteResult {
  const r = obj(raw);
  const code = Number(r.code ?? 0);
  const message = str(r.message).replace(/\s+/g, " ").trim().slice(0, 300);
  const ok = Number.isFinite(code) && (code === 0 || (code >= 200 && code < 300));
  if (!ok) {
    throw new AwishApiError(
      "server",
      `Awish sa nej${Number.isFinite(code) ? ` (kod ${code})` : ""}${message ? `: ${message}` : ""}.`,
      null,
      message || null,
    );
  }
  return {
    code,
    message,
    requestId: optStr(r.request_id),
    data: structToPlain(r.data),
  };
}

function toChannel(raw: unknown): AwishChannelInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const c = obj(raw);
  return {
    id: str(c.id),
    name: str(c.name).trim(),
    addr: str(c.addr),
    motorId: str(c.motor_id),
    floorType: num(c.floor_type),
    total: num(c.total),
  };
}

export function toProductDetail(raw: unknown): AwishProductDetail {
  const p = obj(raw);
  const good = p.good && typeof p.good === "object" ? obj(p.good) : null;
  return {
    id: str(p.id),
    machineId: str(p.machine_id),
    status: p.status === true,
    floorStatus: optStr(p.floor_status),
    lockStatus: optStr(p.lock_status),
    currentInventory: Math.max(0, num(p.current_inventory)),
    capacity: Math.max(0, num(p.inventory)),
    goodId: good ? optStr(good.id) : null,
    goodName: good ? optStr(good.name)?.trim() || null : null,
    channel: toChannel(p.channel),
  };
}

function toMachineConfig(raw: unknown): AwishMachineConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = obj(raw);
  return {
    volume: optNum(c.volume),
    brightness: optNum(c.brightness),
    language: optStr(c.language),
    appVersion: optStr(c.app_version),
    standbyAdsAutoplay: c.standby_ads_autoplay === true,
    standbyAdsEnabled: c.standby_ads_enabled === true,
    standbyAdsSwitchInterval: num(c.standby_ads_switch_interval),
    carouselAdsEnabled: c.carousel_ads_enabled === true,
    carouselAdsSwitchInterval: num(c.carousel_ads_switch_interval),
    temperature: optStr(c.temperature),
    uptimeMinutesToday: optNum(c.uptime_minutes_today),
  };
}

export function toMachineDetail(raw: unknown): AwishMachineDetail {
  const m = obj(raw);
  return {
    id: str(m.id),
    name: str(m.name),
    machineNo: str(m.machine_no),
    isOnline: m.is_online === true,
    status: str(m.status),
    config: toMachineConfig(m.config),
  };
}

export function toMerchantDetail(raw: unknown): AwishMerchantDetail {
  const m = obj(raw);
  const config = obj(m.config);
  // MerchantConfig innehåller appid, app_secret och app_key: de läses aldrig ut här.
  return {
    id: str(m.id),
    title: str(m.title),
    expiredAt: optStr(m.expired_at),
    timezone: optStr(config.timezone),
    whitelistIp: optStr(config.whitelist_ip),
    taxEnabled: typeof config.tax_enabled === "boolean" ? config.tax_enabled : null,
  };
}

export function toMember(raw: unknown): AwishMember {
  const m = obj(raw);
  return {
    id: str(m.id),
    name: str(m.name),
    telMasked: str(m.tel),
    emailMasked: str(m.email),
    memberNo: str(m.member_no),
    machineId: optStr(m.machine_id),
    principalBalance: str(m.principal_balance),
    bonusBalance: str(m.bonus_balance),
    totalBalance: str(m.total_balance),
    points: num(m.points),
    levelId: num(m.level_id),
    status: num(m.status),
    registeredAt: str(m.registered_at),
    remark: optStr(m.remark),
  };
}

/** Versionen ur Version-svaret: data.version, annars meddelandet om det ser ut som en version. */
export function versionOf(raw: unknown): string {
  const r = obj(raw);
  const code = Number(r.code ?? 0);
  if (Number.isFinite(code) && code !== 0 && (code < 200 || code >= 300)) {
    throw new AwishApiError("server", `Awish sa nej (kod ${code}).`);
  }
  const data = structToPlain(r.data);
  const candidates = [data?.version, data?.Version, data?.value, r.message];
  for (const c of candidates) {
    if (typeof c === "string" && /^v?\d+(\.\d+){1,3}$/.test(c.trim())) {
      return c.trim().replace(/^v/, "");
    }
  }
  throw new AwishApiError("changed", "Awish skickade ingen version.");
}

function pageOf<T>(raw: unknown, map: (item: unknown) => T): AwishPage<T> {
  const r = obj(raw);
  const data = Array.isArray(r.data) ? r.data : [];
  return {
    items: data.map(map),
    total: optNum(r.total),
    currentPage: optNum(r.current_page),
    perPage: optNum(r.per_page),
    lastPage: optNum(r.last_page),
    hasMore: typeof r.has_more === "boolean" ? r.has_more : null,
  };
}

const ID = /^\d{1,20}$/;

function id(value: string, what: string): string {
  const v = String(value ?? "").trim();
  if (!ID.test(v)) throw new AwishControlInputError(`Ogiltigt id för ${what}.`);
  return v;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/** Tar bort undefined (skickas inte). */
function defined(o: Obj): Obj {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function goodFields(i: Partial<AwishGoodInput>): Obj {
  return defined({
    name: i.name,
    description: i.description,
    prices: i.prices?.map((p) =>
      defined({
        id: p.id === undefined ? undefined : id(p.id, "pris"),
        price: p.price,
        currency_id: id(p.currencyId, "valuta"),
        original_price: p.originalPrice,
        member_price: p.memberPrice,
        cost_price: p.costPrice,
      }),
    ),
    thumb: i.thumb,
    media: i.media,
    content: i.content,
    barcode: i.barcode,
    age_verification_enabled: i.ageVerificationEnabled,
    age_verification_min: i.ageVerificationMin,
    is_tax_exempt: i.isTaxExempt,
    tax_rate: i.taxRate,
    is_returnable: i.isReturnable,
    category_id: i.categoryId === undefined ? undefined : id(i.categoryId, "kategori"),
  });
}

function memberFields(i: AwishMemberPatch): Obj {
  // Aldrig saldo, lösenord eller utgångstid från Binderlab.
  return defined({
    name: i.name,
    tel: i.tel,
    email: i.email,
    member_no: i.memberNo,
    machine_id: i.machineId === undefined ? undefined : id(i.machineId, "automat"),
    level_id: i.levelId,
    status: i.status,
    remark: i.remark,
  });
}

type Unary = (
  request: Obj,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: unknown) => void,
) => void;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAwishControlClient(
  creds: AwishCredentials,
  opts: ControlClientOptions,
): AwishControlApi {
  assertTestSafeAddress(opts.address);
  const Ctor = awishServiceConstructor();
  const credentials = opts.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  const client = new Ctor(opts.address, credentials, {
    "grpc.max_receive_message_length": 16 * 1024 * 1024,
  });
  const readDeadline = opts.deadlineMs ?? AWISH_DEADLINE_MS;
  const writeDeadline = opts.writeDeadlineMs ?? CONTROL_WRITE_DEADLINE_MS;
  const signMode = opts.signMode ?? DEFAULT_AWISH_SIGN_MODE;
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

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

  const read = async (method: string, request: Obj = {}): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(method, request, readDeadline);
      } catch (error) {
        const mapped = mapControlError(error, opts.address);
        if (!mapped.retryable || attempt >= READ_ATTEMPTS) throw mapped;
        await sleep(BACKOFF_MS[attempt - 1] ?? 1500);
      }
    }
  };

  const write = async (
    method: string,
    messageType: string,
    request: Obj,
  ): Promise<AwishControlWriteResult> => {
    let signed: Obj;
    try {
      signed = signRequest(messageType, request, creds.appId, {
        mode: signMode,
        nowSeconds: Math.floor(clock() / 1000),
      });
    } catch (error) {
      if (error instanceof AwishControlInputError) throw error;
      throw new AwishControlInputError("Uppgifterna gick inte att skicka till Awish.");
    }
    try {
      return toControlWriteResult(await once(method, signed, writeDeadline));
    } catch (error) {
      throw mapControlError(error, opts.address, { write: true });
    }
  };

  return {
    async version() {
      return versionOf(await read("Version"));
    },
    async merchantDetail() {
      return toMerchantDetail(obj(await read("Merchant")).data);
    },
    async machineDetail(awishMachineId) {
      const res = obj(await read("Machine", { id: id(awishMachineId, "automat") }));
      if (!res.data) throw new AwishApiError("not_found", "Awish hittar inte automaten.");
      return toMachineDetail(res.data);
    },
    async productDetails(awishMachineId) {
      const res = obj(await read("Products", { machine_id: id(awishMachineId, "automat") }));
      return (Array.isArray(res.data) ? res.data : []).map(toProductDetail);
    },
    async categories() {
      const res = obj(await read("Categories"));
      return (Array.isArray(res.data) ? res.data : []).map((c): AwishCategory => ({
        id: str(obj(c).id),
        title: str(obj(c).title),
      }));
    },
    async currencies() {
      const res = obj(await read("Currencies"));
      return (Array.isArray(res.data) ? res.data : []).map((c): AwishCurrencyInfo => {
        const x = obj(c);
        return { id: str(x.id), name: str(x.name), code: str(x.code), symbol: str(x.symbol) };
      });
    },
    async members(page) {
      return pageOf(
        await read("Members", { current_page: page.currentPage, per_page: page.perPage }),
        toMember,
      );
    },
    async updateMerchantTimezone(timezone) {
      const tz = String(timezone ?? "").trim();
      if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 64) {
        throw new AwishControlInputError("Ogiltig tidszon.");
      }
      // Bara timezone (fält 4). config (appid, app_secret, app_key) skickas aldrig.
      return write("UpdateMerchant", "UpdateMerchantRequest", { timezone: tz });
    },
    async deleteBanner(i) {
      return write("DeleteBanner", "DeleteBannerRequest", {
        machine_id: id(i.machineId, "automat"),
        id: id(i.id, "kampanjbild"),
      });
    },
    async createCategory(i) {
      return write(
        "CreateCategory",
        "CreateCategoryRequest",
        defined({ title: i.title, priority: i.priority, is_visible: i.isVisible }),
      );
    },
    async updateCategory(i) {
      return write(
        "UpdateCategory",
        "UpdateCategoryRequest",
        defined({
          id: id(i.id, "kategori"),
          title: i.title,
          priority: i.priority,
          is_visible: i.isVisible,
        }),
      );
    },
    async deleteCategory(categoryId) {
      return write("DeleteCategory", "DeleteCategoryRequest", { id: id(categoryId, "kategori") });
    },
    async createGood(i) {
      return write("CreateGood", "CreateGoodRequest", goodFields(i));
    },
    async updateGood(goodId, patch) {
      return write("UpdateGood", "UpdateGoodRequest", {
        id: id(goodId, "vara"),
        ...goodFields(patch),
      });
    },
    async deleteGood(goodId) {
      return write("DeleteGood", "DeleteGoodRequest", { id: id(goodId, "vara") });
    },
    async updateProduct(i) {
      if (
        i.currentInventory !== undefined &&
        (!Number.isSafeInteger(i.currentInventory) || i.currentInventory < 0)
      ) {
        throw new AwishControlInputError("Antalet måste vara ett heltal, 0 eller mer.");
      }
      return write(
        "UpdateProduct",
        "UpdateProductRequest",
        defined({
          id: id(i.id, "fack"),
          good_id: i.goodId === undefined ? undefined : id(i.goodId, "vara"),
          category_id: i.categoryId === undefined ? undefined : id(i.categoryId, "kategori"),
          status: i.status,
          current_inventory: i.currentInventory,
        }),
      );
    },
    async batchUpdateProducts(i) {
      if (i.ids.length === 0) throw new AwishControlInputError("Välj minst ett fack.");
      return write(
        "BatchUpdateProducts",
        "BatchUpdateProductRequest",
        defined({
          ids: i.ids.map((x) => id(x, "fack")),
          machine_id: id(i.machineId, "automat"),
          good_id: i.goodId === undefined ? undefined : id(i.goodId, "vara"),
          category_id: i.categoryId === undefined ? undefined : id(i.categoryId, "kategori"),
          status: i.status,
        }),
      );
    },
    async replenishProductInventory(i) {
      if (i.ids.length === 0) throw new AwishControlInputError("Välj minst ett fack.");
      return write("ReplenishProductInventory", "ReplenishProductInventoryRequest", {
        machine_id: id(i.machineId, "automat"),
        ids: i.ids.map((x) => id(x, "fack")),
      });
    },
    async controlPower(i) {
      if (i.method !== "REBOOT" && i.method !== "SHUTDOWN") {
        throw new AwishControlInputError("Okänt kommando.");
      }
      return write("ControlPower", "PowerControlRequest", {
        machine_id: id(i.machineId, "automat"),
        method: i.method,
      });
    },
    async setPowerSchedule(i) {
      if (!TIME.test(i.powerOn) || !TIME.test(i.powerOff)) {
        throw new AwishControlInputError("Tiderna ska vara TT:MM:SS.");
      }
      if (i.powerOn === i.powerOff) {
        throw new AwishControlInputError("På och Av kan inte vara samma tid.");
      }
      if (
        i.weekdays.length !== 7 ||
        i.weekdays.some((d) => d !== 0 && d !== 1) ||
        !i.weekdays.includes(1)
      ) {
        throw new AwishControlInputError("Välj minst en veckodag.");
      }
      return write("SetPowerSchedule", "PowerScheduleRequest", {
        machine_id: id(i.machineId, "automat"),
        power_on: i.powerOn,
        power_off: i.powerOff,
        weekdays: [...i.weekdays],
      });
    },
    async clearPowerSchedule(machineId) {
      return write("ClearPowerSchedule", "ClearPowerScheduleRequest", {
        machine_id: id(machineId, "automat"),
      });
    },
    async executeShipment(i) {
      if (i.motorIds.length === 0) throw new AwishControlInputError("Facket saknar motor.");
      return write(
        "ExecuteShipment",
        "ShipmentRequest",
        defined({
          machine_id: id(i.machineId, "automat"),
          addr: id(i.addr, "kort"),
          code: i.code === undefined ? undefined : id(i.code, "fack"),
          motor_ids: i.motorIds.map((m) => id(m, "motor")),
          floor_type: i.floorType,
          is_lp: i.isLp,
          is_dc: i.isDc,
        }),
      );
    },
    async updateMachineConfig(i) {
      for (const n of [i.carouselAdsSwitchInterval, i.standbyAdsSwitchInterval]) {
        if (n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 3600)) {
          throw new AwishControlInputError("Intervallet ska vara 1–3600 sekunder.");
        }
      }
      return write(
        "UpdateMachineConfig",
        "UpdateMachineConfigRequest",
        defined({
          machine_id: id(i.machineId, "automat"),
          standby_ads_autoplay: i.standbyAdsAutoplay,
          standby_ads_enabled: i.standbyAdsEnabled,
          carousel_ads_enabled: i.carouselAdsEnabled,
          carousel_ads_switch_interval: i.carouselAdsSwitchInterval,
          standby_ads_switch_interval: i.standbyAdsSwitchInterval,
        }),
      );
    },
    async batchCreateMembers(items) {
      if (items.length === 0) throw new AwishControlInputError("Ingen medlem att skapa.");
      return write("BatchCreateMembers", "BatchCreateMembersRequest", {
        members: items.map((m) => memberFields(m)),
      });
    },
    async updateMember(memberId, patch) {
      return write("UpdateMember", "UpdateMemberRequest", {
        id: id(memberId, "medlem"),
        ...memberFields(patch),
      });
    },
    async deleteMember(memberId) {
      return write("DeleteMember", "DeleteMemberRequest", { id: id(memberId, "medlem") });
    },
    close() {
      client.close();
    },
  };
}
