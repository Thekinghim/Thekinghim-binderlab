/**
 * Styrklienten mot låtsas-Awish (riktig gRPC på 127.0.0.1): varje skrivning signeras och
 * godtas av servern, Version läses ur Struct, läsningar provas igen och skrivningar inte.
 * Testet når aldrig riktiga Awish.
 */

import * as grpc from "@grpc/grpc-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createAwishControlClient, assertTestSafeAddress, structToPlain } = await import("./client");
const { startFakeAwish } = await import("../testing/fake-server");
const {
  AwishUnknownOutcomeError,
  CLOCK_MESSAGE,
  OFFLINE_MESSAGE,
  SIGN_FAILED_MESSAGE,
  UNSUPPORTED_MESSAGE,
  isSignError,
  mapControlError,
  controlErrorMessage,
} = await import("./errors");
const { controlEndpointConfig, chosenEndpoint, probeEndpoint } = await import("./endpoint");
const { AwishApiError } = await import("../grpc-client");

type Fake = Awaited<ReturnType<typeof startFakeAwish>>;
let fake: Fake;

const creds = () => ({
  appId: fake.state.appId,
  appSecret: fake.state.appSecret,
  appKey: fake.state.appKey,
});
const client = (over: Record<string, unknown> = {}) =>
  createAwishControlClient(creds(), {
    address: fake.address,
    tls: false,
    sleep: async () => {},
    ...over,
  });

beforeEach(async () => {
  fake = await startFakeAwish({
    machines: [
      { id: "7", name: "Sega gubben", machine_no: "M7" },
      { id: "8", name: "Bortre", machine_no: "M8", is_online: false },
    ],
    products: {
      "7": [
        {
          channel: "A1",
          good: "Surging Sparks",
          current: 2,
          capacity: 10,
          addr: "3",
          motor_id: "11",
        },
        { channel: "A2", good: null, current: 0, capacity: 8 },
      ],
    },
  });
});

afterEach(async () => {
  await fake.stop();
});

describe("läsningar", () => {
  it("Version ur data (Struct)", async () => {
    const api = client();
    expect(await api.version()).toBe("1.2.41");
    fake.state.version = "1.2.42";
    expect(await api.version()).toBe("1.2.42");
    api.close();
  });

  it("Merchant: tidszon och IP-lista, aldrig nycklar", async () => {
    fake.state.whitelistIp = "1.2.3.4";
    const api = client();
    const m = await api.merchantDetail();
    expect(m.timezone).toBe("Europe/Stockholm");
    expect(m.whitelistIp).toBe("1.2.3.4");
    expect(JSON.stringify(m)).not.toContain(fake.state.appId);
    api.close();
  });

  it("Machine, Products med kanal, Categories, Currencies, Members (maskade)", async () => {
    fake.state.members.push({
      id: "1",
      name: "Anna",
      tel: "0701234567",
      email: "anna@example.com",
      member_no: "M-1",
      status: 1,
      level_id: 0,
      principal_balance: "10.00",
      registered_at: "2026-01-01 10:00:00",
    });
    const api = client();
    const machine = await api.machineDetail("7");
    expect(machine.isOnline).toBe(true);
    expect(machine.config?.volume).toBe(60);
    expect((await api.machineDetail("8")).isOnline).toBe(false);
    const [a1] = await api.productDetails("7");
    expect(a1).toMatchObject({
      id: "1",
      currentInventory: 2,
      capacity: 10,
      goodName: "Surging Sparks",
    });
    expect(a1!.channel).toMatchObject({ name: "A1", addr: "3", motorId: "11", total: 10 });
    expect(await api.categories()).toEqual([{ id: "1", title: "Pokémon" }]);
    expect((await api.currencies()).find((c) => c.code === "SEK")?.id).toBe("1");
    const members = await api.members({ currentPage: 1, perPage: 20 });
    expect(members.items[0]!.telMasked).toBe("070****67");
    expect(members.items[0]!.emailMasked).toBe("a***@example.com");
    api.close();
  });

  it("provas igen vid UNAVAILABLE", async () => {
    fake.state.failNext = 2;
    const api = client();
    expect(await api.version()).toBe("1.2.41");
    expect(fake.state.calls.filter((c) => c.method === "Version")).toHaveLength(3);
    api.close();
  });
});

describe("skrivningar signeras och godtas", () => {
  it("alla nya skrivningar skickar timestamp och sign och går igenom", async () => {
    const api = client();
    const results = [
      await api.updateMerchantTimezone("Europe/Stockholm"),
      await api.createCategory({ title: "Åäö 宝", isVisible: true }),
      await api.updateCategory({ id: "1", title: "Pokémon TCG" }),
      await api.createGood({
        name: "Pack",
        description: "Ett pack",
        prices: [{ price: "79.00", currencyId: "1" }],
        categoryId: "1",
      }),
      await api.updateProduct({ id: "1", status: true, currentInventory: 5 }),
      await api.batchUpdateProducts({ machineId: "7", ids: ["1", "2"], categoryId: "1" }),
      await api.replenishProductInventory({ machineId: "7", ids: ["1"] }),
      await api.controlPower({ machineId: "7", method: "REBOOT" }),
      await api.setPowerSchedule({
        machineId: "7",
        weekdays: [1, 1, 1, 1, 1, 0, 0],
        powerOn: "10:00:00",
        powerOff: "21:00:00",
      }),
      await api.clearPowerSchedule("7"),
      await api.executeShipment({ machineId: "7", addr: "3", motorIds: ["11"], floorType: 0 }),
      await api.updateMachineConfig({
        machineId: "7",
        carouselAdsEnabled: true,
        carouselAdsSwitchInterval: 20,
      }),
      await api.batchCreateMembers([{ name: "Bo", tel: "0709999999" }]),
    ];
    for (const r of results) expect(r.code).toBe(200);
    const writes = fake.state.calls.filter((c) => c.method !== "Version");
    for (const w of writes) {
      expect(String(w.request.timestamp)).toMatch(/^\d{10}$/);
      expect(w.request.sign).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(fake.state.products["7"]![0]!.current).toBe(10);
    expect(fake.state.powerCommands).toEqual([{ machine_id: "7", method: "REBOOT" }]);
    expect(fake.state.shipments).toHaveLength(1);
    expect(fake.state.categories.map((c) => c.title)).toContain("Åäö 宝");
    const member = fake.state.members[0]!;
    expect(await api.updateMember(member.id, { name: "Bo B" })).toMatchObject({ code: 200 });
    expect(await api.deleteMember(member.id)).toMatchObject({ code: 200 });
    const good = fake.state.goods[0]!;
    expect(await api.updateGood(good.id, { name: "Pack 2" })).toMatchObject({ code: 200 });
    expect(await api.deleteGood(good.id)).toMatchObject({ code: 200 });
    expect(await api.deleteCategory("1")).toMatchObject({ code: 200 });
    api.close();
  });

  it("UpdateMerchant skickar bara timezone, aldrig config", async () => {
    const api = client();
    await api.updateMerchantTimezone("Europe/Stockholm");
    const req = fake.state.merchantUpdates[0]!;
    expect(req.timezone).toBe("Europe/Stockholm");
    expect(req.config ?? null).toBeNull();
    expect(req.title ?? null).toBeNull();
    api.close();
  });

  it("servern i full_sorted godtar inte present_sorted, men full_sorted", async () => {
    fake.state.signMode = "full_sorted";
    const bad = client();
    const error = await bad.updateProduct({ id: "1", status: true }).catch((e: unknown) => e);
    expect(isSignError(error)).toBe(true);
    expect((error as Error).message).toBe(SIGN_FAILED_MESSAGE);
    bad.close();
    const good = client({ signMode: "full_sorted" });
    await expect(good.updateProduct({ id: "1", status: true })).resolves.toMatchObject({
      code: 200,
    });
    good.close();
  });

  it("en klocka utanför ±300 s ger klockmeddelandet", async () => {
    const api = client({ clock: () => Date.now() - 301_000 });
    await expect(api.clearPowerSchedule("7")).rejects.toThrow(CLOCK_MESSAGE);
    api.close();
  });

  it("offline och inte stött ger svenska meddelanden", async () => {
    const api = client();
    await expect(api.controlPower({ machineId: "8", method: "REBOOT" })).rejects.toThrow(
      OFFLINE_MESSAGE,
    );
    fake.state.unsupportedPower.add("7");
    await expect(
      api.setPowerSchedule({
        machineId: "7",
        weekdays: [1, 1, 1, 1, 1, 1, 1],
        powerOn: "10:00:00",
        powerOff: "21:00:00",
      }),
    ).rejects.toThrow(UNSUPPORTED_MESSAGE);
    api.close();
  });

  it("skrivningar provas aldrig igen; UNAVAILABLE efter sändning är okänt utfall", async () => {
    fake.state.failNext = 1;
    const api = client();
    const error = await api
      .controlPower({ machineId: "7", method: "REBOOT" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwishUnknownOutcomeError);
    expect(fake.state.calls.filter((c) => c.method === "ControlPower")).toHaveLength(1);
    expect(fake.state.powerCommands).toHaveLength(0);
    api.close();
  });

  it("tidsgräns för en skrivning är okänt utfall", async () => {
    fake.state.delayMs = 300;
    const api = client({ writeDeadlineMs: 50 });
    await expect(api.clearPowerSchedule("7")).rejects.toBeInstanceOf(AwishUnknownOutcomeError);
    api.close();
  });

  it("felaktig indata skickas inte", async () => {
    const api = client();
    await expect(api.controlPower({ machineId: "abc", method: "REBOOT" })).rejects.toThrow(
      /Ogiltigt id/,
    );
    await expect(
      api.setPowerSchedule({
        machineId: "7",
        weekdays: [0, 0, 0, 0, 0, 0, 0],
        powerOn: "10:00:00",
        powerOff: "21:00:00",
      }),
    ).rejects.toThrow(/veckodag/);
    await expect(api.updateMerchantTimezone("Europe/Stockholm; drop")).rejects.toThrow(/tidszon/);
    expect(fake.state.calls).toHaveLength(0);
    api.close();
  });

  it("Awish sa nej (kod 500) blir AwishApiError", async () => {
    fake.state.writeCode = 500;
    const api = client();
    await expect(api.clearPowerSchedule("7")).rejects.toThrow(/Awish sa nej \(kod 500\)/);
    api.close();
  });

  it("de gamla skrivningarna signeras och godtas när servern kräver det", async () => {
    fake.state.requireSignOnLegacyWrites = true;
    const { createAwishClient } = await import("../grpc-client");
    const legacy = createAwishClient(creds(), { address: fake.address, tls: false });
    await expect(
      legacy.createBanner({
        machineId: "7",
        coverImage: "https://x/y.png",
        title: "T",
        expiredAt: 2_000_000_000,
      }),
    ).resolves.toMatchObject({ code: expect.any(Number) });
    // Fel nyckel ger fortfarande nej.
    fake.state.signKeyOverride = "fel-nyckel";
    await expect(
      legacy.createBanner({
        machineId: "7",
        coverImage: "https://x/y.png",
        title: "T",
        expiredAt: 2_000_000_000,
      }),
    ).rejects.toBeTruthy();
    fake.state.signKeyOverride = null;
    legacy.close();
  });
});

describe("felöversättning", () => {
  it("signatur före inloggning, tidsfönster före signatur", () => {
    expect(
      mapControlError({ code: grpc.status.UNAUTHENTICATED, details: "invalid signature" }, "x")
        .message,
    ).toBe(SIGN_FAILED_MESSAGE);
    expect(
      mapControlError(
        { code: 16, details: "signature verify failed, timestamp is out of time window" },
        "x",
      ).message,
    ).toBe(CLOCK_MESSAGE);
    expect(
      mapControlError({ code: 3, details: "invalid signature format: expected hexadecimal" }, "x")
        .kind,
    ).toBe("changed");
    expect(mapControlError({ code: 9, details: "Machine is offline" }, "x").message).toBe(
      OFFLINE_MESSAGE,
    );
    expect(mapControlError({ code: 9, details: "not supported" }, "x").message).toBe(
      UNSUPPORTED_MESSAGE,
    );
    expect(
      mapControlError({ code: grpc.status.DEADLINE_EXCEEDED, details: "" }, "x", { write: true }),
    ).toBeInstanceOf(AwishUnknownOutcomeError);
    expect(
      mapControlError(
        { code: grpc.status.UNAVAILABLE, details: "No connection established" },
        "x",
        { write: true },
      ).kind,
    ).toBe("unavailable");
    expect(
      mapControlError({ code: grpc.status.PERMISSION_DENIED, details: "permission denied" }, "x")
        .kind,
    ).toBe("auth");
  });

  it("controlErrorMessage ger aldrig rå feltext", () => {
    expect(controlErrorMessage(new Error("postgres://user:hemligt@db"))).toBe(
      "Något gick fel mot Awish. Försök igen.",
    );
    expect(controlErrorMessage(new AwishApiError("server", "Svenska"))).toBe("Svenska");
  });
});

describe("adress och TLS", () => {
  it("läser miljön", () => {
    expect(controlEndpointConfig({})).toEqual({
      mode: "auto",
      tlsAddress: "grpc.awish.vip:443",
      plainAddress: "49.51.72.74:50051",
    });
    expect(controlEndpointConfig({ AWISH_CONTROL_ENDPOINT: "PLAIN" }).mode).toBe("plain");
    expect(controlEndpointConfig({ AWISH_CONTROL_ENDPOINT: "konstigt" }).mode).toBe("auto");
    expect(chosenEndpoint(controlEndpointConfig({}), null)).toBeNull();
    expect(chosenEndpoint(controlEndpointConfig({}), "plain")).toBe("plain");
    expect(chosenEndpoint(controlEndpointConfig({ AWISH_CONTROL_ENDPOINT: "tls" }), "plain")).toBe(
      "tls",
    );
  });

  it("auto: TLS svarar inte, den okrypterade fungerar", async () => {
    const cfg = { mode: "auto" as const, tlsAddress: "127.0.0.1:1", plainAddress: fake.address };
    const probe = await probeEndpoint(
      creds(),
      cfg,
      (c, o) =>
        createAwishControlClient(c, { ...o, tls: false, deadlineMs: 2000, sleep: async () => {} }),
      "present_sorted",
    );
    expect(probe.endpoint).toBe("plain");
    expect(probe.version).toBe("1.2.41");
    expect(probe.error).toMatch(/^TLS:/);
  });

  it("vägrar riktiga adresser under testerna", () => {
    expect(() => assertTestSafeAddress("grpc.awish.vip:443", { VITEST: "true" })).toThrow(
      /Tester får inte/,
    );
    expect(() => assertTestSafeAddress("49.51.72.74:50051", { NODE_ENV: "test" })).toThrow();
    expect(() => assertTestSafeAddress("127.0.0.1:5000", { VITEST: "true" })).not.toThrow();
    expect(() =>
      createAwishControlClient(creds(), { address: "grpc.awish.vip:443", tls: true }),
    ).toThrow();
  });

  it("structToPlain", () => {
    expect(
      structToPlain({
        fields: {
          a: { stringValue: "x", kind: "stringValue" },
          b: { numberValue: 2, kind: "numberValue" },
          c: { listValue: { values: [{ boolValue: true, kind: "boolValue" }] }, kind: "listValue" },
        },
      }),
    ).toEqual({ a: "x", b: 2, c: [true] });
  });
});
