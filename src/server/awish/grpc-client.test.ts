import { createHash } from "node:crypto";

import * as grpc from "@grpc/grpc-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  AwishApiError,
  awishClientConfigFromEnv,
  awishMetadata,
  awishToken,
  createAwishClient,
  mapGrpcError,
  TOKEN_HEX_CASE,
} = await import("./grpc-client");
const { fakeOrder, startFakeAwish } = await import("./testing/fake-server");

type Fake = Awaited<ReturnType<typeof startFakeAwish>>;

describe("signering och metadata", () => {
  it("token = MD5 av AppSecret.AppKey med gemener (dokumentationens exempel)", () => {
    const expected = createHash("md5").update("sekret.nyckel").digest("hex");
    expect(TOKEN_HEX_CASE).toBe("lower");
    expect(awishToken("sekret", "nyckel")).toBe(expected);
    expect(awishToken("sekret", "nyckel")).toMatch(/^[0-9a-f]{32}$/);
    // Ordningen spelar roll: AppSecret först.
    expect(awishToken("nyckel", "sekret")).not.toBe(expected);
  });

  it("metadata har appid, token och lang en-US, men aldrig hemligheten själv", () => {
    const md = awishMetadata({ appId: "app1", appSecret: "S", appKey: "K" });
    expect(md.get("appid")).toEqual(["app1"]);
    expect(md.get("token")).toEqual([awishToken("S", "K")]);
    expect(md.get("lang")).toEqual(["en-US"]);
    expect(JSON.stringify(md.toJSON())).not.toMatch(/"S"|"K"/);
  });

  it("adress och TLS ur miljön", () => {
    expect(awishClientConfigFromEnv({})).toEqual({ address: "49.51.72.74:50051", tls: false });
    expect(awishClientConfigFromEnv({ AWISH_GRPC_ADDRESS: "x:1", AWISH_GRPC_TLS: "true" })).toEqual(
      { address: "x:1", tls: true },
    );
  });
});

describe("felöversättning", () => {
  it("Awish mellanprogram → svenska", () => {
    const cases: Array<[number, string, RegExp]> = [
      [grpc.status.UNAUTHENTICATED, "appid is missing", /inget AppId/],
      [grpc.status.NOT_FOUND, "merchant not found", /hittar inget konto/],
      [grpc.status.UNAUTHENTICATED, "token is missing", /ingen token/],
      [grpc.status.PERMISSION_DENIED, "permission denied", /AppSecret eller AppKey/],
      [grpc.status.UNAVAILABLE, "", /svarar inte/],
      [grpc.status.DEADLINE_EXCEEDED, "", /inom 15 sekunder/],
      [grpc.status.INTERNAL, "boom", /gRPC-kod 13.*boom/],
    ];
    for (const [code, details, re] of cases) {
      expect(mapGrpcError({ code, details }, "h:1").message, details).toMatch(re);
    }
    expect(mapGrpcError({ code: grpc.status.UNAVAILABLE }, "h:1").retryable).toBe(true);
    expect(mapGrpcError({ code: grpc.status.PERMISSION_DENIED }, "h:1").retryable).toBe(false);
  });
});

describe("klienten mot en låtsas-Awish (gRPC på 127.0.0.1)", () => {
  let fake: Fake;
  beforeAll(async () => {
    fake = await startFakeAwish({
      machines: [{ id: "2", name: "BL-001 Centrum", machine_no: "163271xx" }],
      orders: [
        fakeOrder(1),
        fakeOrder(2, { status: "PAY_NOTPAY", payTime: null }),
        fakeOrder("18446744073709551615"),
      ],
    });
  });
  afterAll(async () => {
    await fake.stop();
  });

  const creds = () => ({
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  });
  const noSleep = async () => {};

  it("Merchant, Machines och Orders med typer", async () => {
    const api = createAwishClient(creds(), { address: fake.address, tls: false, sleep: noSleep });
    try {
      expect(await api.merchant()).toMatchObject({ id: "10000", title: "Testhandlare" });
      const machines = await api.machines({ currentPage: 1, perPage: 20 });
      expect(machines.items).toEqual([
        expect.objectContaining({ id: "2", name: "BL-001 Centrum", machineNo: "163271xx" }),
      ]);
      expect(machines.total).toBe(1);
      const page = await api.orders({ currentPage: 1, perPage: 20 });
      expect(page.total).toBe(3);
      expect(page.lastPage).toBe(1);
      // uint64 som text utan precisionsförlust.
      expect(page.items[0]?.id).toBe("18446744073709551615");
      const unpaid = page.items.find((o) => o.id === "2");
      expect(unpaid).toMatchObject({ status: "PAY_NOTPAY", payTime: null, amount: "170.00" });
      expect(page.items[1]?.records[0]).toEqual({
        productId: "11",
        quantity: "1",
        price: "170.00",
      });
      expect(await api.order("1")).toMatchObject({ id: "1", paymentId: "5", machineId: "2" });
      expect(fake.state.calls.at(-1)?.token).toBe(
        awishToken(fake.state.appSecret, fake.state.appKey),
      );
    } finally {
      api.close();
    }
  });

  it("fel AppSecret ger ett svenskt fel och inga omförsök", async () => {
    const before = fake.state.calls.length;
    const api = createAwishClient(
      { ...creds(), appSecret: "fel" },
      { address: fake.address, tls: false, sleep: noSleep },
    );
    try {
      await expect(api.merchant()).rejects.toMatchObject({
        kind: "auth",
        message: expect.stringMatching(/AppSecret eller AppKey/),
      });
      expect(fake.state.calls.length - before).toBe(1);
    } finally {
      api.close();
    }
  });

  it("okänt AppId", async () => {
    const api = createAwishClient(
      { ...creds(), appId: "annan" },
      { address: fake.address, tls: false, sleep: noSleep },
    );
    try {
      await expect(api.merchant()).rejects.toThrow(/hittar inget konto/);
    } finally {
      api.close();
    }
  });

  it("UNAVAILABLE provas igen, högst tre försök", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const api = createAwishClient(creds(), { address: fake.address, tls: false, sleep });
    try {
      fake.state.failNext = 2;
      expect(await api.merchant()).toMatchObject({ title: "Testhandlare" });
      expect(sleeps).toEqual([500, 1500]);
      fake.state.failNext = 3;
      await expect(api.merchant()).rejects.toBeInstanceOf(AwishApiError);
      expect(fake.state.failNext).toBe(0);
    } finally {
      fake.state.failNext = 0;
      api.close();
    }
  });

  it("en server som inte svarar ger UNAVAILABLE på svenska", async () => {
    const api = createAwishClient(creds(), {
      address: "127.0.0.1:1",
      tls: false,
      sleep: noSleep,
      deadlineMs: 2000,
      maxAttempts: 1,
    });
    try {
      await expect(api.merchant()).rejects.toMatchObject({ retryable: true });
    } finally {
      api.close();
    }
  });
});
