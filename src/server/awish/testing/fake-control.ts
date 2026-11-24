/**
 * Låtsas-Awish: de nya anropen i gRPC-API v1.2.41 (styrning, katalog, medlemmar, Version).
 * Skrivningarna kontrollerar signaturen som Awishs server (verifyAwishSignature, ±300 s):
 * fel signatur ger UNAUTHENTICATED "signature verify failed", för gammal tid "signature
 * verify failed, timestamp is out of time window". Används bara av testerna.
 */

import * as grpc from "@grpc/grpc-js";

import { verifyAwishSignature, type AwishSignMode } from "../sign";

export interface FakeCategory {
  id: string;
  title: string;
  priority?: number;
  is_visible?: boolean;
}

export interface FakeCurrency {
  id: string;
  name: string;
  code: string;
  symbol: string;
}

export interface FakeGood {
  id: string;
  name: string;
  description?: string;
  prices: Array<{ id: string; price: string; currency_id: string }>;
  category_id?: string;
}

export interface FakeMember {
  id: string;
  name: string;
  tel: string;
  email: string;
  member_no: string;
  machine_id?: string;
  status: number;
  level_id: number;
  remark?: string;
  principal_balance: string;
  registered_at: string;
}

export interface FakeMachineConfig {
  volume?: number;
  brightness?: number;
  standby_ads_autoplay: boolean;
  standby_ads_enabled: boolean;
  carousel_ads_enabled: boolean;
  carousel_ads_switch_interval: number;
  standby_ads_switch_interval: number;
}

export interface FakePowerSchedule {
  power_on: string;
  power_off: string;
  weekdays: number[];
}

export interface FakeShipment {
  machine_id: string;
  addr: string;
  code: string | null;
  motor_ids: string[];
  floor_type: number | null;
}

/** De nya fälten i låtsas-Awishs läge (FakeAwishState utökar det). */
export interface FakeControlState {
  /** Version-svaret. */
  version: string;
  merchantTimezone: string;
  /** MerchantConfig.whitelist_ip (null = skickas inte). */
  whitelistIp: string | null;
  categories: FakeCategory[];
  currencies: FakeCurrency[];
  goods: FakeGood[];
  members: FakeMember[];
  /** Skärm och reklam per Awish-automat. */
  machineConfigs: Record<string, FakeMachineConfig>;
  powerSchedules: Record<string, FakePowerSchedule>;
  powerCommands: Array<{ machine_id: string; method: string }>;
  shipments: FakeShipment[];
  /** Awish-automater som är offline (ControlPower, ExecuteShipment och Machine). */
  offlineMachines: Set<string>;
  /** Automater som inte stöder strömschema. */
  unsupportedPower: Set<string>;
  /** Hur servern bygger request_body ("off" = ingen kontroll). */
  signMode: AwishSignMode | "off";
  signToleranceS: number | null;
  /** Servern kontrollerar mot en annan nyckel än appid (då godtas ingen signatur). */
  signKeyOverride: string | null;
  /** Serverns klocka i förhållande till testets (sekunder). */
  clockOffsetS: number;
  /** CreateBanner, UpdateBanner och CreatePickupCode kräver signatur (som i v1.2.40+). */
  requireSignOnLegacyWrites: boolean;
  /** Fel för nästa skrivning (t.ex. "machine offline", "not support"). */
  nextWriteError: { code: number; details: string } | null;
  /** Begäran som togs emot i UpdateMerchant (för att se att config aldrig skickas). */
  merchantUpdates: Array<Record<string, unknown>>;
  /**
   * Vilka fältnummer för timestamp/sign servern läser i de sju meddelandena där
   * dokumentationen och proto-filen skiljer sig: proto-filens eller dokumentationens (10/11).
   */
  signFields: "proto" | "doc";
  /** Nästa skrivning nekas i svaret (SuccessResponse med code och message), inte som gRPC-fel. */
  nextBodyRefusal: { code: number; message: string } | null;
  /** Members skickar hela telefonnumret och e-postadressen (Awish maskerar inte). */
  unmaskedMembers: boolean;
}

export function defaultControlState(): FakeControlState {
  return {
    version: "1.2.41",
    merchantTimezone: "Europe/Stockholm",
    whitelistIp: null,
    categories: [{ id: "1", title: "Pokémon", priority: 1, is_visible: true }],
    currencies: [
      { id: "1", name: "Svensk krona", code: "SEK", symbol: "kr" },
      { id: "2", name: "US Dollar", code: "USD", symbol: "$" },
    ],
    goods: [],
    members: [],
    machineConfigs: {},
    powerSchedules: {},
    powerCommands: [],
    shipments: [],
    offlineMachines: new Set(),
    unsupportedPower: new Set(),
    signMode: "present_sorted",
    signToleranceS: 300,
    signKeyOverride: null,
    clockOffsetS: 0,
    requireSignOnLegacyWrites: false,
    nextWriteError: null,
    merchantUpdates: [],
    signFields: "proto",
    nextBodyRefusal: null,
    unmaskedMembers: false,
  };
}

/** Ett fack som låtsas-Awish håller (samma som FakeProduct i fake-server.ts). */
export interface FakeControlProduct {
  id?: string;
  channel: string;
  good: string | null;
  current: number;
  capacity: number;
  addr?: string;
  motor_id?: string;
  floor_type?: number;
  good_id?: string;
  category_id?: string;
  status?: boolean;
}

export interface FakeControlHost extends FakeControlState {
  appId: string;
  machines: Array<{ id: string; name: string; machine_no: string; is_online?: boolean }>;
  products: Record<string, FakeControlProduct[]>;
  writeCode: number;
}

type Call = grpc.ServerUnaryCall<Record<string, unknown>, unknown>;
type Callback = grpc.sendUnaryData<unknown>;
export type FakeGuard = (method: string, call: Call, callback: Callback) => boolean;

/** Fackets id som Products visar det (eget id, annars plats + 1). */
export function fakeProductId(p: FakeControlProduct, index: number): string {
  return p.id ?? String(index + 1);
}

function mask(text: string, keepStart: number, keepEnd: number): string {
  if (text.length <= keepStart + keepEnd) return "*".repeat(text.length);
  return `${text.slice(0, keepStart)}****${text.slice(text.length - keepEnd)}`;
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return mask(email, 1, 0);
  return `${(user ?? "").slice(0, 1)}***@${domain}`;
}

/** Kontrollerar signaturen. Svarar med fel och ger false om den inte godtas. */
export function checkSignature(
  state: FakeControlHost,
  messageType: string,
  call: Call,
  callback: Callback,
): boolean {
  if (state.signMode === "off") return true;
  const verdict = verifyAwishSignature({
    appId: state.signKeyOverride ?? state.appId,
    messageType,
    request: call.request,
    mode: state.signMode,
    nowSeconds: Math.floor(Date.now() / 1000) + state.clockOffsetS,
    toleranceS: state.signToleranceS,
    fields: state.signFields,
  });
  if (verdict === "ok") return true;
  callback({
    code: grpc.status.UNAUTHENTICATED,
    details:
      verdict === "out_of_window"
        ? "signature verify failed, timestamp is out of time window"
        : verdict === "missing"
          ? "sign is required"
          : "signature verify failed",
  });
  return false;
}

export function controlHandlers(
  state: FakeControlHost,
  guard: FakeGuard,
): Record<string, (call: Call, callback: Callback) => void> {
  let nextId = 5000;
  const newId = () => String((nextId += 1));
  const ok = (callback: Callback, data?: Record<string, unknown>) => {
    const code = state.writeCode;
    state.writeCode = 0;
    callback(null, {
      code: String(code === 0 ? 200 : code),
      message: code === 0 ? "success" : "fake error",
      ...(data ? { data: toStruct(data) } : {}),
      request_id: `fake-${nextId}`,
    });
  };
  /** Gemensamt för skrivningar: metadata, signatur, injicerat fel. */
  const write = (method: string, messageType: string, call: Call, callback: Callback) => {
    if (!guard(method, call, callback)) return false;
    if (!checkSignature(state, messageType, call, callback)) return false;
    if (state.nextWriteError) {
      const err = state.nextWriteError;
      state.nextWriteError = null;
      callback({ code: err.code, details: err.details });
      return false;
    }
    if (state.writeCode !== 0) {
      ok(callback);
      return false;
    }
    if (state.nextBodyRefusal) {
      const refusal = state.nextBodyRefusal;
      state.nextBodyRefusal = null;
      callback(null, { code: String(refusal.code), message: refusal.message, request_id: "fake" });
      return false;
    }
    return true;
  };
  const r = (call: Call) => call.request;
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const has = (call: Call, field: string) =>
    call.request[field] !== undefined && call.request[field] !== null;
  const machineOnline = (id: string) => {
    const m = state.machines.find((x) => x.id === id);
    return m !== undefined && m.is_online !== false && !state.offlineMachines.has(id);
  };
  const findProduct = (id: string) => {
    for (const [machineId, list] of Object.entries(state.products)) {
      const index = list.findIndex((p, i) => fakeProductId(p, i) === id);
      if (index >= 0) return { machineId, product: list[index]! };
    }
    return null;
  };
  const config = (machineId: string): FakeMachineConfig =>
    (state.machineConfigs[machineId] ??= {
      volume: 60,
      brightness: 80,
      standby_ads_autoplay: true,
      standby_ads_enabled: true,
      carousel_ads_enabled: false,
      carousel_ads_switch_interval: 10,
      standby_ads_switch_interval: 15,
    });

  return {
    Version(call, callback) {
      if (!guard("Version", call, callback)) return;
      callback(null, {
        code: "200",
        message: "ok",
        data: toStruct({ version: state.version }),
        request_id: "fake",
      });
    },
    Machine(call, callback) {
      if (!guard("Machine", call, callback)) return;
      const id = s(r(call).id);
      const m = state.machines.find((x) => x.id === id);
      if (!m) {
        callback({ code: grpc.status.NOT_FOUND, details: "machine not found" });
        return;
      }
      const c = config(id);
      callback(null, {
        code: "200",
        message: "ok",
        data: {
          id: m.id,
          name: m.name,
          machine_no: m.machine_no,
          status: "1",
          is_online: machineOnline(id),
          config: {
            id: m.id,
            volume: c.volume,
            brightness: c.brightness,
            language: "sv",
            app_version: "2.4.0",
            standby_ads_autoplay: c.standby_ads_autoplay,
            standby_ads_enabled: c.standby_ads_enabled,
            standby_ads_switch_interval: c.standby_ads_switch_interval,
            carousel_ads_enabled: c.carousel_ads_enabled,
            carousel_ads_switch_interval: c.carousel_ads_switch_interval,
          },
        },
      });
    },
    Categories(call, callback) {
      if (!guard("Categories", call, callback)) return;
      callback(null, {
        code: "200",
        message: "ok",
        data: state.categories.map((c) => ({ id: c.id, title: c.title })),
      });
    },
    Currencies(call, callback) {
      if (!guard("Currencies", call, callback)) return;
      callback(null, { code: "200", message: "ok", data: state.currencies });
    },
    Members(call, callback) {
      if (!guard("Members", call, callback)) return;
      const perPage = Math.min(Number(r(call).per_page ?? 20) || 20, 50);
      const page = Math.max(1, Number(r(call).current_page ?? 1) || 1);
      const items = state.members.slice((page - 1) * perPage, page * perPage);
      callback(null, {
        code: "200",
        message: "ok",
        data: items.map((m) => ({
          id: m.id,
          name: m.name,
          tel: state.unmaskedMembers ? m.tel : mask(m.tel, 3, 2),
          email: state.unmaskedMembers ? m.email : maskEmail(m.email),
          member_no: m.member_no,
          ...(m.machine_id ? { machine_id: m.machine_id } : {}),
          principal_balance: m.principal_balance,
          bonus_balance: "0.00",
          total_balance: m.principal_balance,
          points: "0",
          total_points: "0",
          level_id: String(m.level_id),
          status: String(m.status),
          registered_at: m.registered_at,
          ...(m.remark ? { remark: m.remark } : {}),
        })),
        total: String(state.members.length),
        current_page: String(page),
        per_page: String(perPage),
        last_page: String(Math.max(1, Math.ceil(state.members.length / perPage))),
      });
    },
    UpdateMerchant(call, callback) {
      if (!write("UpdateMerchant", "UpdateMerchantRequest", call, callback)) return;
      state.merchantUpdates.push({ ...call.request });
      if (has(call, "timezone")) state.merchantTimezone = s(r(call).timezone);
      ok(callback);
    },
    DeleteBanner(call, callback) {
      if (!write("DeleteBanner", "DeleteBannerRequest", call, callback)) return;
      const list = (state as unknown as { banners: Record<string, Array<{ id: string }>> })
        .banners?.[s(r(call).machine_id)];
      const index = list ? list.findIndex((b) => b.id === s(r(call).id)) : -1;
      if (!list || index < 0) {
        callback({ code: grpc.status.NOT_FOUND, details: "banner not found" });
        return;
      }
      list.splice(index, 1);
      ok(callback);
    },
    CreateCategory(call, callback) {
      if (!write("CreateCategory", "CreateCategoryRequest", call, callback)) return;
      const id = newId();
      state.categories.push({
        id,
        title: s(r(call).title),
        ...(has(call, "priority") ? { priority: Number(r(call).priority) } : {}),
        ...(has(call, "is_visible") ? { is_visible: r(call).is_visible === true } : {}),
      });
      ok(callback, { id });
    },
    UpdateCategory(call, callback) {
      if (!write("UpdateCategory", "UpdateCategoryRequest", call, callback)) return;
      const c = state.categories.find((x) => x.id === s(r(call).id));
      if (!c) {
        callback({ code: grpc.status.NOT_FOUND, details: "category not found" });
        return;
      }
      if (has(call, "title")) c.title = s(r(call).title);
      if (has(call, "priority")) c.priority = Number(r(call).priority);
      if (has(call, "is_visible")) c.is_visible = r(call).is_visible === true;
      ok(callback);
    },
    DeleteCategory(call, callback) {
      if (!write("DeleteCategory", "DeleteCategoryRequest", call, callback)) return;
      const before = state.categories.length;
      state.categories = state.categories.filter((x) => x.id !== s(r(call).id));
      if (state.categories.length === before) {
        callback({ code: grpc.status.NOT_FOUND, details: "category not found" });
        return;
      }
      ok(callback);
    },
    CreateGood(call, callback) {
      if (!write("CreateGood", "CreateGoodRequest", call, callback)) return;
      const id = newId();
      state.goods.push({
        id,
        name: s(r(call).name),
        description: s(r(call).description),
        prices: (Array.isArray(r(call).prices)
          ? (r(call).prices as Array<Record<string, unknown>>)
          : []
        ).map((p) => ({ id: newId(), price: s(p.price), currency_id: s(p.currency_id) })),
        ...(has(call, "category_id") ? { category_id: s(r(call).category_id) } : {}),
      });
      ok(callback, { id });
    },
    UpdateGood(call, callback) {
      if (!write("UpdateGood", "UpdateGoodRequest", call, callback)) return;
      const g = state.goods.find((x) => x.id === s(r(call).id));
      if (!g) {
        callback({ code: grpc.status.NOT_FOUND, details: "good not found" });
        return;
      }
      if (has(call, "name")) g.name = s(r(call).name);
      if (has(call, "description")) g.description = s(r(call).description);
      if (has(call, "category_id")) g.category_id = s(r(call).category_id);
      const prices = r(call).prices;
      if (Array.isArray(prices) && prices.length > 0) {
        g.prices = (prices as Array<Record<string, unknown>>).map((p) => ({
          id: s(p.id) === "0" || s(p.id) === "" ? newId() : s(p.id),
          price: s(p.price),
          currency_id: s(p.currency_id),
        }));
      }
      ok(callback);
    },
    DeleteGood(call, callback) {
      if (!write("DeleteGood", "DeleteGoodRequest", call, callback)) return;
      const before = state.goods.length;
      state.goods = state.goods.filter((x) => x.id !== s(r(call).id));
      if (state.goods.length === before) {
        callback({ code: grpc.status.NOT_FOUND, details: "good not found" });
        return;
      }
      ok(callback);
    },
    UpdateProduct(call, callback) {
      if (!write("UpdateProduct", "UpdateProductRequest", call, callback)) return;
      const found = findProduct(s(r(call).id));
      if (!found) {
        callback({ code: grpc.status.NOT_FOUND, details: "product not found" });
        return;
      }
      const p = found.product;
      if (has(call, "good_id")) {
        const goodId = s(r(call).good_id);
        p.good_id = goodId;
        const good = state.goods.find((g) => g.id === goodId);
        if (good) p.good = good.name;
      }
      if (has(call, "category_id")) p.category_id = s(r(call).category_id);
      if (has(call, "status")) p.status = r(call).status === true;
      if (has(call, "current_inventory")) p.current = Number(r(call).current_inventory);
      ok(callback);
    },
    BatchUpdateProducts(call, callback) {
      if (!write("BatchUpdateProducts", "BatchUpdateProductRequest", call, callback)) return;
      const list = state.products[s(r(call).machine_id)] ?? [];
      const ids = (Array.isArray(r(call).ids) ? (r(call).ids as unknown[]) : []).map(s);
      list.forEach((p, i) => {
        if (!ids.includes(fakeProductId(p, i))) return;
        if (has(call, "good_id")) p.good_id = s(r(call).good_id);
        if (has(call, "category_id")) p.category_id = s(r(call).category_id);
        if (has(call, "status")) p.status = r(call).status === true;
      });
      ok(callback);
    },
    ReplenishProductInventory(call, callback) {
      if (!write("ReplenishProductInventory", "ReplenishProductInventoryRequest", call, callback))
        return;
      const list = state.products[s(r(call).machine_id)] ?? [];
      const ids = (Array.isArray(r(call).ids) ? (r(call).ids as unknown[]) : []).map(s);
      list.forEach((p, i) => {
        if (ids.includes(fakeProductId(p, i))) p.current = p.capacity;
      });
      ok(callback);
    },
    ControlPower(call, callback) {
      if (!write("ControlPower", "PowerControlRequest", call, callback)) return;
      const machineId = s(r(call).machine_id);
      if (!machineOnline(machineId)) {
        callback({ code: grpc.status.FAILED_PRECONDITION, details: "machine offline" });
        return;
      }
      state.powerCommands.push({ machine_id: machineId, method: s(r(call).method) });
      ok(callback);
    },
    SetPowerSchedule(call, callback) {
      if (!write("SetPowerSchedule", "PowerScheduleRequest", call, callback)) return;
      const machineId = s(r(call).machine_id);
      if (state.unsupportedPower.has(machineId)) {
        callback({ code: grpc.status.FAILED_PRECONDITION, details: "machine not support" });
        return;
      }
      state.powerSchedules[machineId] = {
        power_on: s(r(call).power_on),
        power_off: s(r(call).power_off),
        weekdays: (Array.isArray(r(call).weekdays) ? (r(call).weekdays as unknown[]) : []).map(
          Number,
        ),
      };
      ok(callback);
    },
    ClearPowerSchedule(call, callback) {
      if (!write("ClearPowerSchedule", "ClearPowerScheduleRequest", call, callback)) return;
      delete state.powerSchedules[s(r(call).machine_id)];
      ok(callback);
    },
    ExecuteShipment(call, callback) {
      if (!write("ExecuteShipment", "ShipmentRequest", call, callback)) return;
      const machineId = s(r(call).machine_id);
      if (!machineOnline(machineId)) {
        callback({ code: grpc.status.FAILED_PRECONDITION, details: "machine offline" });
        return;
      }
      state.shipments.push({
        machine_id: machineId,
        addr: s(r(call).addr),
        code: has(call, "code") ? s(r(call).code) : null,
        motor_ids: (Array.isArray(r(call).motor_ids) ? (r(call).motor_ids as unknown[]) : []).map(
          s,
        ),
        floor_type: has(call, "floor_type") ? Number(r(call).floor_type) : null,
      });
      ok(callback);
    },
    UpdateMachineConfig(call, callback) {
      if (!write("UpdateMachineConfig", "UpdateMachineConfigRequest", call, callback)) return;
      const c = config(s(r(call).machine_id));
      for (const key of [
        "standby_ads_autoplay",
        "standby_ads_enabled",
        "carousel_ads_enabled",
      ] as const) {
        if (has(call, key)) c[key] = r(call)[key] === true;
      }
      for (const key of ["carousel_ads_switch_interval", "standby_ads_switch_interval"] as const) {
        if (has(call, key)) c[key] = Number(r(call)[key]);
      }
      ok(callback);
    },
    BatchCreateMembers(call, callback) {
      if (!write("BatchCreateMembers", "BatchCreateMembersRequest", call, callback)) return;
      const items = Array.isArray(r(call).members)
        ? (r(call).members as Array<Record<string, unknown>>)
        : [];
      for (const m of items) {
        state.members.push({
          id: newId(),
          name: s(m.name),
          tel: s(m.tel),
          email: s(m.email),
          member_no: s(m.member_no),
          ...(m.machine_id ? { machine_id: s(m.machine_id) } : {}),
          status: m.status === undefined || m.status === null ? 1 : Number(m.status),
          level_id: Number(m.level_id ?? 0),
          ...(m.remark ? { remark: s(m.remark) } : {}),
          principal_balance: "0.00",
          registered_at: "2026-11-24 10:00:00",
        });
      }
      ok(callback);
    },
    UpdateMember(call, callback) {
      if (!write("UpdateMember", "UpdateMemberRequest", call, callback)) return;
      const m = state.members.find((x) => x.id === s(r(call).id));
      if (!m) {
        callback({ code: grpc.status.NOT_FOUND, details: "member not found" });
        return;
      }
      if (has(call, "name")) m.name = s(r(call).name);
      if (has(call, "member_no")) m.member_no = s(r(call).member_no);
      if (has(call, "status")) m.status = Number(r(call).status);
      if (has(call, "remark")) m.remark = s(r(call).remark);
      if (has(call, "tel")) m.tel = s(r(call).tel);
      if (has(call, "email")) m.email = s(r(call).email);
      ok(callback);
    },
    DeleteMember(call, callback) {
      if (!write("DeleteMember", "DeleteMemberRequest", call, callback)) return;
      const before = state.members.length;
      state.members = state.members.filter((x) => x.id !== s(r(call).id));
      if (state.members.length === before) {
        callback({ code: grpc.status.NOT_FOUND, details: "member not found" });
        return;
      }
      ok(callback);
    },
  };
}

/** Ett vanligt objekt som google.protobuf.Struct. */
export function toStruct(value: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) fields[k] = toValue(v);
  return { fields };
}

function toValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: "NULL_VALUE" };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return { numberValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (Array.isArray(v)) return { listValue: { values: v.map(toValue) } };
  return { structValue: toStruct(v as Record<string, unknown>) };
}
