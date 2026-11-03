/**
 * Kantfall i gRPC-synken (från granskningen): sidantal som servern inte skickar,
 * två långa avbrott i rad, felöversättning av transportfel och körningens
 * tidsgräns.
 */
import * as grpc from "@grpc/grpc-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AwishGrpcOrder } from "@/import/adapters/awish-grpc";

import {
  AwishApiError,
  awishServiceConstructor,
  createAwishClient,
  mapGrpcError,
} from "./grpc-client";
import {
  collectOrders,
  EMPTY_CURSOR,
  parseCursor,
  type OrdersPage,
  type SyncCursor,
} from "./paging";
import { fakeOrder, startFakeAwish } from "./testing/fake-server";

const NOW = new Date("2026-11-03T12:00:00Z");

function makeOrders(n: number): AwishGrpcOrder[] {
  return Array.from({ length: n }, (_, i) => {
    const id = i + 1;
    const t = new Date(NOW.getTime() - (n - id) * 3_600_000);
    const pay = t.toISOString().slice(0, 19).replace("T", " ");
    return {
      id: String(id),
      date: pay.slice(0, 10),
      tradeId: null,
      title: "T",
      amount: "1.00",
      payTime: pay,
      status: "PAY_SUCCESS",
      isFree: false,
      taxTotal: null,
      pickupCodeId: null,
      paymentId: "5",
      machineId: "1",
      records: [],
      totalCashAmount: null,
      changeCashAmount: null,
    };
  });
}

/** En server som inte skickar total/last_page (valfria i proto-filen). */
function unpaged(
  all: () => AwishGrpcOrder[],
  order: "desc" | "asc",
  mode: "none" | "has_more" | "zero" = "none",
) {
  const calls: number[] = [];
  const fetchPage = async (page: number): Promise<OrdersPage> => {
    calls.push(page);
    const sorted = [...all()].sort((a, b) =>
      order === "desc" ? Number(b.id) - Number(a.id) : Number(a.id) - Number(b.id),
    );
    const items = sorted.slice((page - 1) * 20, page * 20);
    return {
      items,
      total: mode === "zero" ? 0 : null,
      perPage: mode === "none" ? null : 20,
      lastPage: mode === "zero" ? 0 : null,
      hasMore: mode === "has_more" ? page * 20 < sorted.length : null,
    };
  };
  return { fetchPage, calls };
}

describe("sidantal som servern inte skickar", () => {
  for (const order of ["desc", "asc"] as const) {
    for (const mode of ["none", "has_more", "zero"] as const) {
      it(`${order}, ${mode}: hela historiken läses (100 order)`, async () => {
        const all = makeOrders(100);
        const src = unpaged(() => all, order, mode);
        const r = await collectOrders({
          fetchPage: src.fetchPage,
          cursor: { ...EMPTY_CURSOR },
          maxKnownId: null,
          now: NOW,
          sourceTimezone: "UTC",
          maxPages: 50,
        });
        expect(r.orders.length).toBe(100);
        expect(r.cursor.historyDone).toBe(true);
        expect(r.order).toBe(order);
      });
    }
  }

  it("asc utan sidantal: sista sidan hittas och nya order läses därifrån", async () => {
    let all = makeOrders(205);
    const src = unpaged(() => all, "asc");
    let cursor: SyncCursor = { ...EMPTY_CURSOR };
    const seen = new Set<string>();
    for (let i = 0; i < 5 && !cursor.historyDone; i += 1) {
      const r = await collectOrders({
        fetchPage: src.fetchPage,
        cursor,
        maxKnownId: null,
        now: NOW,
        sourceTimezone: "UTC",
        maxPages: 50,
      });
      r.orders.forEach((o) => seen.add(o.id));
      cursor = r.cursor;
    }
    expect(seen.size).toBe(205);
    all = makeOrders(210);
    const r = await collectOrders({
      fetchPage: src.fetchPage,
      cursor,
      maxKnownId: "205",
      now: NOW,
      sourceTimezone: "UTC",
      maxPages: 50,
    });
    for (const id of ["206", "210"]) expect(r.orders.some((o) => o.id === id)).toBe(true);
    expect(r.pagingFields).toEqual([]);
  });

  it("sidfälten som servern skickar rapporteras", async () => {
    const all = makeOrders(5);
    const src = unpaged(() => all, "desc", "has_more");
    const r = await collectOrders({
      fetchPage: src.fetchPage,
      cursor: { ...EMPTY_CURSOR },
      maxKnownId: null,
      now: NOW,
      sourceTimezone: "UTC",
      maxPages: 50,
    });
    expect(r.pagingFields).toEqual(["per_page", "has_more"]);
  });
});

describe("gRPC-svar utan valfria sidfält", () => {
  let server: grpc.Server;
  let address = "";
  beforeAll(async () => {
    server = new grpc.Server();
    server.addService(awishServiceConstructor().service, {
      Orders: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => cb(null, { data: [] }),
    } as unknown as grpc.UntypedServiceImplementation);
    address = await new Promise<string>((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, port) =>
        e ? reject(e) : resolve(`127.0.0.1:${port}`),
      ),
    );
  });
  afterAll(() => server.forceShutdown());

  it("utelämnade valfria fält blir null, inte 0", async () => {
    const api = createAwishClient(
      { appId: "a", appSecret: "b", appKey: "c" },
      { address, tls: false },
    );
    try {
      const page = await api.orders({ currentPage: 1, perPage: 20 });
      expect(page.total).toBeNull();
      expect(page.lastPage).toBeNull();
      expect(page.hasMore).toBeNull();
    } finally {
      api.close();
    }
  });
});

describe("två långa avbrott i rad", () => {
  it("glappet efter det andra avbrottet läses också", async () => {
    let all = makeOrders(100);
    const fetchPage = async (page: number): Promise<OrdersPage> => {
      const sorted = [...all].sort((a, b) => Number(b.id) - Number(a.id));
      return {
        items: sorted.slice((page - 1) * 20, page * 20),
        total: sorted.length,
        perPage: 20,
        lastPage: Math.max(1, Math.ceil(sorted.length / 20)),
      };
    };
    const imported = new Set<string>(all.map((o) => o.id));
    const run = async (cursor: SyncCursor, maxPages: number) => {
      const max = [...imported].map(Number).sort((a, b) => b - a)[0];
      const r = await collectOrders({
        fetchPage,
        cursor,
        maxKnownId: String(max),
        now: NOW,
        sourceTimezone: "UTC",
        maxPages,
      });
      for (const o of r.orders) imported.add(o.id);
      return r.cursor;
    };
    let cursor: SyncCursor = { ...EMPTY_CURSOR, historyDone: true, order: "desc" };
    all = makeOrders(300);
    cursor = await run(cursor, 3);
    expect(cursor.gaps.length).toBe(1);
    all = makeOrders(500);
    cursor = await run(cursor, 3);
    expect(cursor.gaps.length).toBe(2);
    for (let i = 0; i < 10; i += 1) cursor = await run(cursor, 50);
    const missing = all.filter((o) => !imported.has(o.id)).map((o) => Number(o.id));
    expect(missing).toEqual([]);
    expect(cursor.gaps).toEqual([]);
  });

  it("ett sparat läge med det gamla fältet `gap` läses som ett glapp", () => {
    expect(parseCursor({ gap: { page: 4, stopAtId: "100" } }).gaps).toEqual([
      { page: 4, stopAtId: "100" },
    ]);
  });
});

describe("felöversättning: koden först", () => {
  it("UNAVAILABLE med 'expired' i texten (t.ex. TLS-certifikat) provas igen", () => {
    const e = mapGrpcError(
      {
        code: grpc.status.UNAVAILABLE,
        details: "No connection established. Last error: certificate has expired",
      },
      "x:1",
    );
    expect(e.retryable).toBe(true);
    expect(e.kind).toBe("unavailable");
  });

  it("DEADLINE_EXCEEDED med 'signature' i texten är en tidsgräns", () => {
    expect(
      mapGrpcError({ code: grpc.status.DEADLINE_EXCEEDED, details: "signature x" }, "x:1").kind,
    ).toBe("timeout");
  });

  it("bara kontots utgång blir 'har gått ut'", () => {
    expect(
      mapGrpcError({ code: grpc.status.PERMISSION_DENIED, details: "merchant has expired" }, "x:1")
        .message,
    ).toMatch(/gått ut/);
    expect(
      mapGrpcError({ code: grpc.status.INTERNAL, details: "token expired" }, "x:1").message,
    ).not.toMatch(/gått ut/);
  });
});

describe("körningens tidsgräns i klienten", () => {
  let fake: Awaited<ReturnType<typeof startFakeAwish>>;
  beforeAll(async () => {
    fake = await startFakeAwish({ orders: [fakeOrder(1)] });
  });
  afterAll(async () => {
    await fake.stop();
  });
  const creds = () => ({
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  });

  it("ingen tid kvar: inget anrop görs, felet är 'budget'", async () => {
    const before = fake.state.calls.length;
    const api = createAwishClient(creds(), {
      address: fake.address,
      tls: false,
      deadlineAt: Date.now() + 500,
    });
    try {
      await expect(api.merchant()).rejects.toMatchObject({ kind: "budget" });
      expect(fake.state.calls.length).toBe(before);
    } finally {
      api.close();
    }
  });

  it("tidsgränsen kortas till det som återstår (långsam server)", async () => {
    fake.state.delayMs = 3_000;
    const api = createAwishClient(creds(), {
      address: fake.address,
      tls: false,
      deadlineAt: Date.now() + 1_500,
    });
    const t0 = Date.now();
    try {
      const error = await api.merchant().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AwishApiError);
      expect((error as AwishApiError).kind).toBe("budget");
      expect(Date.now() - t0).toBeLessThan(2_500);
    } finally {
      fake.state.delayMs = 0;
      api.close();
    }
  });

  it("inget nytt försök om väntan skulle gå över tidsgränsen", async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const api = createAwishClient(creds(), {
      address: fake.address,
      tls: false,
      deadlineAt: 1_200,
      clock: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    try {
      fake.state.failNext = 3;
      await expect(api.merchant()).rejects.toMatchObject({ kind: "unavailable" });
      expect(sleeps).toEqual([]);
    } finally {
      fake.state.failNext = 0;
      api.close();
    }
  });

  it("synkens automatlista utan sidfält läser alla sidor", async () => {
    const { fetchMachines } = await import("./sync");
    fake.state.paging = "none";
    fake.state.machines = Array.from({ length: 45 }, (_, i) => ({
      id: String(i + 1),
      name: `M${i + 1}`,
      machine_no: `n${i + 1}`,
    }));
    const api = createAwishClient(creds(), { address: fake.address, tls: false });
    try {
      expect((await fetchMachines(api)).length).toBe(45);
      fake.state.paging = "has_more";
      fake.state.machines = fake.state.machines.slice(0, 40);
      expect((await fetchMachines(api)).length).toBe(40);
    } finally {
      fake.state.paging = "full";
      api.close();
    }
  });
});
