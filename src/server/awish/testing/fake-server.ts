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
}

export interface FakeAwishState {
  appId: string;
  appSecret: string;
  appKey: string;
  merchantTitle: string;
  /** Svarar sida 1 med nyaste först ("desc") eller äldsta först ("asc"). */
  order: "desc" | "asc";
  orders: AwishGrpcOrder[];
  machines: FakeMachine[];
  /** Högsta per_page som servern godtar (större ger så här många). */
  maxPerPage: number;
  /** Antal kommande anrop som svarar UNAVAILABLE. */
  failNext: number;
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
    order: "desc",
    orders: [],
    machines: [],
    maxPerPage: 20,
    failNext: 0,
    calls: [],
    ...initial,
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
  server.addService(Ctor.service, {
    Merchant(call: Call, callback: Callback) {
      if (!guard("Merchant", call, callback)) return;
      callback(null, {
        data: {
          id: "10000",
          title: state.merchantTitle,
          status: "APPROVED",
          created_at: "2024-04-18 23:48:27",
          expired_at: "2027-04-18 23:48:54",
          config: { debug: false, is_dev: false, appid: state.appId, app_key: "kva" },
        },
        request_id: "fake",
      });
    },
    Machines(call: Call, callback: Callback) {
      if (!guard("Machines", call, callback)) return;
      const page = paged(state.machines, call.request);
      callback(null, {
        ...page,
        data: page.data.map((m) => ({ ...m, status: "1", is_online: true })),
      });
    },
    Orders(call: Call, callback: Callback) {
      if (!guard("Orders", call, callback)) return;
      const ids = Array.isArray(call.request.machine_ids)
        ? (call.request.machine_ids as unknown[]).map(String)
        : [];
      const list = sortedOrders().filter((o) => ids.length === 0 || ids.includes(o.machineId));
      const page = paged(list, call.request);
      callback(null, { ...page, data: page.data.map(toProtoOrder) });
    },
    Order(call: Call, callback: Callback) {
      if (!guard("Order", call, callback)) return;
      const found = state.orders.find((o) => o.id === String(call.request.id));
      callback(null, { code: "0", message: "ok", data: found ? toProtoOrder(found) : undefined });
    },
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
