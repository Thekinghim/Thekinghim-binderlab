/**
 * Kampanjbilder och hämtkoder mot låtsas-Awish (aldrig riktiga Awish): läsning,
 * skrivning, att skrivande anrop aldrig provas igen och att Awish "nej" blir ett fel.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  AwishApiError,
  AWISH_MEDIA_IMAGE,
  createAwishClient,
  toBanner,
  toPickupCode,
  toWriteResult,
} = await import("./grpc-client");
const { startFakeAwish } = await import("./testing/fake-server");

type Fake = Awaited<ReturnType<typeof startFakeAwish>>;

let fake: Fake;
const client = () =>
  createAwishClient(
    { appId: fake.state.appId, appSecret: fake.state.appSecret, appKey: fake.state.appKey },
    { address: fake.address, tls: false, sleep: async () => {} },
  );

beforeAll(async () => {
  fake = await startFakeAwish({
    products: {
      "2": [
        { channel: "A1", good: "Surging Sparks", current: 3, capacity: 8 },
        { channel: "A2", good: "Black Bolt", current: 0, capacity: 8 },
      ],
    },
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("tolkning", () => {
  it("Banner och PickupCode", () => {
    expect(
      toBanner({
        id: "7",
        is_visible: true,
        expired_at: "1767225600",
        cover_image: "https://x/y.png",
        title: "Nytt",
        hit_count: "3",
        views_count: "120",
        media_type: 1,
      }),
    ).toEqual({
      id: "7",
      isVisible: true,
      expiredAt: 1767225600,
      coverImage: "https://x/y.png",
      title: "Nytt",
      hitCount: 3,
      viewsCount: 120,
      mediaType: 1,
    });
    expect(toPickupCode({ id: "1", code: " AB12 ", status: false, quantity: "1" })).toMatchObject({
      code: "AB12",
      active: false,
      quantity: 1,
      expiredAtMillis: null,
    });
  });

  it("SuccessResponse: 0 och 2xx lyckas, annat blir fel med Awish text", () => {
    expect(toWriteResult({ code: "0", message: "ok" })).toEqual({ code: 0, message: "ok" });
    expect(toWriteResult({ code: "200", message: "" }).code).toBe(200);
    expect(() => toWriteResult({ code: "500", message: "machine offline" })).toThrow(
      /Awish sa nej \(kod 500\): machine offline/,
    );
  });
});

describe("kampanjbilder", () => {
  it("skapar, listar och stänger av (utgångstid nu)", async () => {
    const api = client();
    try {
      await api.createBanner({
        machineId: "2",
        coverImage: "https://cdn.test/kampanj.png",
        title: "Nytt: Surging Sparks",
        expiredAt: 1_800_000_000,
      });
      const call = fake.state.calls.find((c) => c.method === "CreateBanner");
      expect(call?.request).toMatchObject({
        machine_id: "2",
        cover_image: "https://cdn.test/kampanj.png",
        title: "Nytt: Surging Sparks",
        expired_at: "1800000000",
        media_type: String(AWISH_MEDIA_IMAGE),
      });
      const [banner] = await api.banners("2");
      expect(banner).toMatchObject({ title: "Nytt: Surging Sparks", expiredAt: 1_800_000_000 });
      await api.updateBanner({
        id: banner!.id,
        machineId: "2",
        coverImage: banner!.coverImage!,
        title: banner!.title,
        expiredAt: 1_700_000_000,
      });
      expect((await api.banners("2"))[0]!.expiredAt).toBe(1_700_000_000);
    } finally {
      api.close();
    }
  });

  it("ett skrivande anrop provas aldrig igen när Awish inte svarar", async () => {
    const api = client();
    const before = fake.state.calls.filter((c) => c.method === "CreateBanner").length;
    fake.state.failNext = 2;
    try {
      await expect(
        api.createBanner({ machineId: "2", coverImage: "https://x", title: "x", expiredAt: 1 }),
      ).rejects.toMatchObject({ kind: "unavailable" });
      expect(fake.state.calls.filter((c) => c.method === "CreateBanner").length).toBe(before + 1);
    } finally {
      fake.state.failNext = 0;
      api.close();
    }
  });

  it("Awish nej (kod ≠ 0) blir AwishApiError och inget skapas", async () => {
    const api = client();
    fake.state.writeCode = 500;
    try {
      const n = (fake.state.banners["2"] ?? []).length;
      await expect(
        api.createBanner({ machineId: "2", coverImage: "https://x", title: "x", expiredAt: 1 }),
      ).rejects.toBeInstanceOf(AwishApiError);
      expect((fake.state.banners["2"] ?? []).length).toBe(n);
    } finally {
      api.close();
    }
  });
});

describe("hämtkoder", () => {
  it("skapar koder för ett fack och listar dem", async () => {
    const api = client();
    try {
      await api.createPickupCodes({
        machineId: "2",
        productId: "1",
        quantity: 3,
        expiredAt: 1_800_000_000,
      });
      const codes = await api.pickupCodes("2");
      expect(codes).toHaveLength(3);
      expect(new Set(codes.map((c) => c.code)).size).toBe(3);
      expect(codes.every((c) => c.productId === "1" && c.active)).toBe(true);
      expect(codes[0]!.expiredAtMillis).toBe(1_800_000_000_000);
    } finally {
      api.close();
    }
  });

  it("okänt fack ger fel", async () => {
    const api = client();
    try {
      await expect(
        api.createPickupCodes({ machineId: "2", productId: "99", quantity: 1, expiredAt: 1 }),
      ).rejects.toMatchObject({ kind: "not_found" });
    } finally {
      api.close();
    }
  });
});
