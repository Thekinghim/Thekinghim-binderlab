/**
 * De gamla skrivningarna (CreateBanner, UpdateBanner, CreatePickupCode) kräver timestamp och
 * sign sedan v1.2.40. Mot låtsas-Awish (aldrig riktiga Awish): varje skrivning bär en
 * signatur som går att kontrollera med appid, och signaturfel blir svenska utan att peka på
 * AppSecret/AppKey.
 */

import * as grpc from "@grpc/grpc-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createAwishClient, mapGrpcError } = await import("./grpc-client");
const { verifyAwishSignature } = await import("./sign");
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
    products: { "2": [{ channel: "A1", good: "Surging Sparks", current: 3, capacity: 8 }] },
    banners: {
      "2": [
        {
          id: "1",
          title: "Gammal",
          cover_image: "https://x/g.png",
          expired_at: null,
          is_visible: true,
          views_count: 0,
          hit_count: 0,
        },
      ],
    },
  });
  // P1:s låtsas-Awish kontrollerar signaturen själv när det här är på.
  (fake.state as unknown as Record<string, unknown>).requireSignOnLegacyWrites = true;
});
afterAll(async () => {
  await fake.stop();
});

const MESSAGE: Record<string, string> = {
  CreateBanner: "CreateBannerRequest",
  UpdateBanner: "UpdateBannerRequest",
  CreatePickupCode: "CreatePickupCodesRequest",
};

describe("signerade gamla skrivningar", () => {
  it("CreateBanner, UpdateBanner och CreatePickupCode bär timestamp och en giltig sign", async () => {
    const c = client();
    try {
      const before = fake.state.calls.length;
      const now = Math.floor(Date.now() / 1000);
      await c.createBanner({
        machineId: "2",
        coverImage: "https://x/ny.png",
        title: "Åäö 宝",
        expiredAt: now + 3600,
      });
      await c.updateBanner({
        id: "1",
        machineId: "2",
        coverImage: "https://x/ny.png",
        title: "Slut",
        expiredAt: now,
      });
      await c.createPickupCodes({
        machineId: "2",
        productId: "1",
        quantity: 2,
        expiredAt: now + 86_400,
      });
      const writes = fake.state.calls.slice(before).filter((x) => x.method in MESSAGE);
      expect(writes.map((w) => w.method)).toEqual([
        "CreateBanner",
        "UpdateBanner",
        "CreatePickupCode",
      ]);
      for (const w of writes) {
        expect(String(w.request.sign)).toMatch(/^[0-9a-f]{64}$/);
        expect(Math.abs(Number(w.request.timestamp) - now)).toBeLessThanOrEqual(5);
        expect(
          verifyAwishSignature({
            appId: fake.state.appId,
            messageType: MESSAGE[w.method]!,
            request: w.request,
            mode: "present_sorted",
            nowSeconds: Math.floor(Date.now() / 1000),
          }),
        ).toBe("ok");
        // Fel nyckel (t.ex. AppKey i stället för appid) godkänns inte.
        expect(
          verifyAwishSignature({
            appId: fake.state.appKey,
            messageType: MESSAGE[w.method]!,
            request: w.request,
            mode: "present_sorted",
            nowSeconds: Math.floor(Date.now() / 1000),
          }),
        ).toBe("bad_sign");
      }
    } finally {
      c.close();
    }
  });
});

describe("signaturfel blir svenska", () => {
  const err = (details: string) =>
    mapGrpcError({ code: grpc.status.UNAUTHENTICATED, details }, "x:1");

  it("signaturfel klassas som ändrat, inte som fel AppSecret/AppKey", () => {
    // "invalid signature" ensamt är Awishs inloggningsfel (fel AppSecret/AppKey), se nedan.
    expect(err("invalid signature").kind).toBe("auth");
    for (const d of [
      "signature verify failed",
      "invalid sign",
      "invalid signature format: expected hexadecimal",
      "hmac mismatch",
    ]) {
      const e = err(d);
      expect(e.kind).toBe("changed");
      expect(e.message).toBe("Awish godkände inte signaturen. Testa under Datakällor → Awish API.");
      expect(e.message).not.toMatch(/AppSecret|AppKey/);
    }
  });

  it("tidsfönstret ger ett klockfel", () => {
    const e = err("signature verify failed, timestamp is out of time window");
    expect(e.message).toBe("Awish tyckte att klockan var fel. Försök igen om en minut.");
  });

  it("fel token är fortfarande ett inloggningsfel", () => {
    expect(err("invalid token").kind).toBe("auth");
  });
});
