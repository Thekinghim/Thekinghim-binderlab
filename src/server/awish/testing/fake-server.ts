/**
 * Låtsas-Awish för testerna: en riktig gRPC-server (@grpc/grpc-js) på 127.0.0.1
 * med samma proto som klienten. Kontrollerar metadata som Awish mellanprogram
 * (appid, token = MD5 av "AppSecret.AppKey") och svarar med sidor ur en lista.
 * Används av enhetstesterna och databastesterna; aldrig av appen.
 */

import { createHash } from "node:crypto";

import * as grpc from "@grpc/grpc-js";

import type { AwishGrpcOrder } from "@/import/adapters/awish-grpc";

import { awishServiceConstructor } from "../grpc-client";

export interface FakeMachine {
  id: string;
  name: string;
  machine_no: string;
  /** Machine.is_online (standard true). */
  is_online?: boolean;
  /** Machine.status (standard "1"). */
  status?: string;
}

/** Ett fack i låtsas-Awish (Products). */
export interface FakeProduct {
  channel: string;
  good: string | null;
  current: number;
  capacity: number;
}

/** En kampanjbild i låtsas-Awish (Banners). */
export interface FakeBanner {
  id: string;
  title: string;
  cover_image: string;
  expired_at: number | null;
  is_visible: boolean;
  views_count: number;
  hit_count: number;
}

/** En hämtkod i låtsas-Awish (PickupCodes). */
export interface FakePickupCode {
  id: string;
  product_id: string;
  code: string;
  expired_at: number | null;
  status: boolean;
}

export interface FakeAwishState {
  appId: string;
  appSecret: string;
  appKey: string;
  merchantTitle: string;
  /** Merchant.expired_at (null = skickas inte). */
  merchantExpiredAt: string | null;
  /** Svarar sida 1 med nyaste först ("desc") eller äldsta först ("asc"). */
  order: "desc" | "asc";
  orders: AwishGrpcOrder[];
  machines: FakeMachine[];
  /** Facken per Awish-automat (machine_id). Saknas = tom lista. */
  products: Record<string, FakeProduct[]>;
  /** Högsta per_page som servern godtar (större ger så här många). */
  maxPerPage: number;
  /** Antal kommande anrop som svarar UNAVAILABLE. */
  failNext: number;
  /**
   * Vilka sidfält som skickas: "full" (total, per_page, last_page), "none" (inga,
   * de är valfria i proto-filen) eller "has_more" (bara has_more).
   */
  paging: "full" | "none" | "has_more";
  /** Väntan (ms) innan varje svar. */
  delayMs: number;
  /** Kampanjbilder per Awish-automat. */
  banners: Record<string, FakeBanner[]>;
  /** Hämtkoder per Awish-automat. */
  pickupCodes: Record<string, FakePickupCode[]>;
  /** SuccessResponse.code för nästa skrivande anrop (t.ex. 500 = Awish säger nej). */
  writeCode: number;
  /** Skapade koder syns inte i PickupCodes (för att prova att koderna inte går att läsa). */
  hideNewCodes: boolean;
  /** Alla anrop: metod och begäran. */
  calls: Array<{ method: string; request: Record<string, unknown>; token: string | null }>;
}

export interface FakeAwish {
  address: string;
  state: FakeAwishState;
  stop(): Promise<void>;
}

function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

function toProtoOrder(o: AwishGrpcOrder): Record<string, unknown> {
  return {
    id: o.id,
    date: o.date,
    trade_id: o.tradeId ?? undefined,
    title: o.title ?? undefined,
    amount: o.amount,
    pay_time: o.payTime ?? undefined,
    status: o.status,
    is_free: o.isFree,
    tax_total: o.taxTotal ?? undefined,
    pickup_code_id: o.pickupCodeId ?? undefined,
    payment_id: o.paymentId,
    machine_id: o.machineId,
    order_records: o.records.map((r, i) => ({
      id: String(i + 1),
      product_id: r.productId,
      quantity: r.quantity,
      price: r.price,
      tax_amount: "0",
      delivery_logs: [],
    })),
    total_cash_amount: o.totalCashAmount ?? undefined,
    change_cash_amount: o.changeCashAmount ?? undefined,
  };
}

type Call = grpc.ServerUnaryCall<Record<string, unknown>, unknown>;
type Callback = grpc.sendUnaryData<unknown>;

export async function startFakeAwish(initial: Partial<FakeAwishState> = {}): Promise<FakeAwish> {
  const state: FakeAwishState = {
    appId: "app-test",
    appSecret: "hemlig-secret",
    appKey: "nyckel-key",
    merchantTitle: "Testhandlare",
    merchantExpiredAt: "2027-04-18 23:48:54",
    order: "desc",
    orders: [],
    machines: [],
    products: {},
    maxPerPage: 20,
    failNext: 0,
    paging: "full",
    delayMs: 0,
    banners: {},
    pickupCodes: {},
    writeCode: 0,
    hideNewCodes: false,
    calls: [],
    ...initial,
  };
  let nextId = 900;
  const newId = () => String((nextId += 1));
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const newCode = (n: number): string => {
    let x = n * 7919 + 104729;
    let out = "";
    for (let i = 0; i < 8; i++) {
      out += CODE_CHARS[x % CODE_CHARS.length];
      x = Math.floor(x / CODE_CHARS.length) + i * 31 + 17;
    }
    return out;
  };
  const writeReply = (callback: Callback) => {
    const code = state.writeCode;
    state.writeCode = 0;
    callback(null, { code: String(code), message: code === 0 ? "success" : "fake error" });
  };

  const guard = (method: string, call: Call, callback: Callback): boolean => {
    const appid = call.metadata.get("appid")[0];
    const token = call.metadata.get("token")[0];
    state.calls.push({
      method,
      request: call.request,
      token: typeof token === "string" ? token : null,
    });
    if (state.failNext > 0) {
      state.failNext -= 1;
      callback({ code: grpc.status.UNAVAILABLE, details: "upstream connect error" });
      return false;
    }
    if (!appid) {
      callback({ code: grpc.status.UNAUTHENTICATED, details: "appid is missing" });
      return false;
    }
    if (appid !== state.appId) {
      callback({ code: grpc.status.NOT_FOUND, details: "merchant not found" });
      return false;
    }
    if (!token) {
      callback({ code: grpc.status.UNAUTHENTICATED, details: "token is missing" });
      return false;
    }
    if (token !== md5(`${state.appSecret}.${state.appKey}`)) {
      callback({ code: grpc.status.PERMISSION_DENIED, details: "permission denied" });
      return false;
    }
    return true;
  };

  const paged = <T>(items: T[], request: Record<string, unknown>) => {
    const perPage = Math.min(Number(request.per_page ?? 15) || 15, state.maxPerPage);
    const currentPage = Math.max(1, Number(request.current_page ?? 1) || 1);
    const start = (currentPage - 1) * perPage;
    if (state.paging !== "full") {
      return {
        data: items.slice(start, start + perPage),
        ...(state.paging === "has_more" ? { has_more: start + perPage < items.length } : {}),
        request_id: "fake",
      };
    }
    return {
      data: items.slice(start, start + perPage),
      total: String(items.length),
      current_page: String(currentPage),
      per_page: String(perPage),
      last_page: String(Math.max(1, Math.ceil(items.length / perPage))),
      request_id: "fake",
    };
  };

  const sortedOrders = (): AwishGrpcOrder[] =>
    [...state.orders].sort((a, b) => {
      const d = BigInt(a.id) - BigInt(b.id);
      const asc = d < 0n ? -1 : d > 0n ? 1 : 0;
      return state.order === "asc" ? asc : -asc;
    });

  const server = new grpc.Server();
  const Ctor = awishServiceConstructor();
  const delayed =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      if (state.delayMs > 0) setTimeout(() => fn(...args), state.delayMs);
      else fn(...args);
    };
  const handlers = {
    Merchant(call: Call, callback: Callback): void {
      if (!guard("Merchant", call, callback)) return;
      callback(null, {
        data: {
          id: "10000",
          title: state.merchantTitle,
          status: "APPROVED",
          created_at: "2024-04-18 23:48:27",
          ...(state.merchantExpiredAt === null ? {} : { expired_at: state.merchantExpiredAt }),
          config: { debug: false, is_dev: false, appid: state.appId, app_key: "kva" },
        },
        request_id: "fake",
      });
    },
    Machines(call: Call, callback: Callback): void {
      if (!guard("Machines", call, callback)) return;
      const page = paged(state.machines, call.request);
      callback(null, {
        ...page,
        data: page.data.map((m) => ({
          ...m,
          status: m.status ?? "1",
          is_online: m.is_online ?? true,
        })),
      });
    },
    Orders(call: Call, callback: Callback): void {
      if (!guard("Orders", call, callback)) return;
      const ids = Array.isArray(call.request.machine_ids)
        ? (call.request.machine_ids as unknown[]).map(String)
        : [];
      const list = sortedOrders().filter((o) => ids.length === 0 || ids.includes(o.machineId));
      const page = paged(list, call.request);
      callback(null, { ...page, data: page.data.map(toProtoOrder) });
    },
    Order(call: Call, callback: Callback): void {
      if (!guard("Order", call, callback)) return;
      const found = state.orders.find((o) => o.id === String(call.request.id));
      callback(null, { code: "0", message: "ok", data: found ? toProtoOrder(found) : undefined });
    },
    Products(call: Call, callback: Callback): void {
      if (!guard("Products", call, callback)) return;
      const machineId = String(call.request.machine_id ?? "");
      const list = state.products[machineId] ?? [];
      callback(null, {
        data: list.map((p, i) => ({
          id: String(i + 1),
          machine_id: machineId,
          status: true,
          current_inventory: String(p.current),
          inventory: String(p.capacity),
          channel: { id: String(i + 1), name: p.channel, addr: String(i + 1) },
          ...(p.good === null
            ? {}
            : { good: { id: String(100 + i), name: p.good, price: "170.00", content: "" } }),
        })),
        request_id: "fake",
      });
    },
    Banners(call: Call, callback: Callback): void {
      if (!guard("Banners", call, callback)) return;
      const list = state.banners[String(call.request.machine_id ?? "")] ?? [];
      callback(null, {
        data: list.map((b) => ({
          id: b.id,
          is_visible: b.is_visible,
          ...(b.expired_at === null ? {} : { expired_at: String(b.expired_at) }),
          cover_image: b.cover_image,
          sort_id: "0",
          hit_count: String(b.hit_count),
          views_count: String(b.views_count),
          title: b.title,
          view_type: "0",
          media_type: 1,
        })),
        request_id: "fake",
      });
    },
    CreateBanner(call: Call, callback: Callback): void {
      if (!guard("CreateBanner", call, callback)) return;
      if (state.writeCode !== 0) return writeReply(callback);
      const machineId = String(call.request.machine_id ?? "");
      const list = (state.banners[machineId] ??= []);
      list.push({
        id: newId(),
        title: String(call.request.title ?? ""),
        cover_image: String(call.request.cover_image ?? ""),
        expired_at: call.request.expired_at == null ? null : Number(call.request.expired_at),
        is_visible: true,
        views_count: 0,
        hit_count: 0,
      });
      writeReply(callback);
    },
    UpdateBanner(call: Call, callback: Callback): void {
      if (!guard("UpdateBanner", call, callback)) return;
      if (state.writeCode !== 0) return writeReply(callback);
      const machineId = String(call.request.machine_id ?? "");
      const banner = (state.banners[machineId] ?? []).find((b) => b.id === String(call.request.id));
      if (!banner) {
        callback({ code: grpc.status.NOT_FOUND, details: "banner not found" });
        return;
      }
      if (call.request.title != null) banner.title = String(call.request.title);
      if (call.request.cover_image != null) banner.cover_image = String(call.request.cover_image);
      if (call.request.expired_at != null) banner.expired_at = Number(call.request.expired_at);
      writeReply(callback);
    },
    PickupCodes(call: Call, callback: Callback): void {
      if (!guard("PickupCodes", call, callback)) return;
      const machineId = String(call.request.machine_id ?? "");
      const list = state.pickupCodes[machineId] ?? [];
      callback(null, {
        data: list.map((c) => ({
          id: c.id,
          machine_id: machineId,
          ...(c.expired_at === null ? {} : { expired_at_millis: String(c.expired_at * 1000) }),
          product_id: c.product_id,
          code: c.code,
          quantity: "1",
          status: c.status,
        })),
        request_id: "fake",
      });
    },
    CreatePickupCode(call: Call, callback: Callback): void {
      if (!guard("CreatePickupCode", call, callback)) return;
      if (state.writeCode !== 0) return writeReply(callback);
      const machineId = String(call.request.machine_id ?? "");
      const productId = String(call.request.product_id ?? "");
      const slots = state.products[machineId] ?? [];
      // Facket (Products.id) är plats + 1 i listan, som Products-svaret ovan.
      if (!slots[Number(productId) - 1]) {
        callback({ code: grpc.status.NOT_FOUND, details: "product not found" });
        return;
      }
      const quantity = Math.max(1, Number(call.request.quantity ?? 1) || 1);
      if (!state.hideNewCodes) {
        const list = (state.pickupCodes[machineId] ??= []);
        for (let i = 0; i < quantity; i++) {
          const id = newId();
          list.push({
            id,
            product_id: productId,
            code: newCode(Number(id)),
            expired_at: call.request.expired_at == null ? null : Number(call.request.expired_at),
            status: true,
          });
        }
      }
      writeReply(callback);
    },
  };
  server.addService(Ctor.service, {
    Merchant: delayed(handlers.Merchant),
    Machines: delayed(handlers.Machines),
    Orders: delayed(handlers.Orders),
    Order: delayed(handlers.Order),
    Products: delayed(handlers.Products),
    Banners: delayed(handlers.Banners),
    CreateBanner: delayed(handlers.CreateBanner),
    UpdateBanner: delayed(handlers.UpdateBanner),
    PickupCodes: delayed(handlers.PickupCodes),
    CreatePickupCode: delayed(handlers.CreatePickupCode),
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, p) =>
      error ? reject(error) : resolve(p),
    ),
  );
  return {
    address: `127.0.0.1:${port}`,
    state,
    stop: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve());
      }),
  };
}

/** En order för testerna med rimliga standardvärden. */
export function fakeOrder(id: number | string, over: Partial<AwishGrpcOrder> = {}): AwishGrpcOrder {
  return {
    id: String(id),
    date: "2026-11-02",
    tradeId: `DS-${id}`,
    title: "Pokémon TCG: Surging Sparks Booster",
    amount: "170.00",
    payTime: "2026-11-02 00:17:00",
    status: "PAY_SUCCESS",
    isFree: false,
    taxTotal: null,
    pickupCodeId: null,
    paymentId: "5",
    machineId: "2",
    records: [{ productId: "11", quantity: "1", price: "170.00" }],
    totalCashAmount: null,
    changeCashAmount: null,
    ...over,
  };
}
