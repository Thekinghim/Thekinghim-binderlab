import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { AwishApiError } = await import("./grpc-client");
const { startFakeAwishWeb } = await import("./testing/fake-web-server");
type FakeWeb = Awaited<ReturnType<typeof startFakeAwishWeb>>;
const { createAwishWebClient } = await import("./web-client");

let fake: FakeWeb;

beforeEach(async () => {
  fake = await startFakeAwishWeb({
    // Samma klocka som klienten: signaturens tidsfönster räknas mot den.
    now: () => 1_762_250_000_000,
    products: {
      "1001": [
        {
          id: 11,
          goodId: 5,
          goodName: "30th Celebration",
          status: true,
          currentInventory: 2,
          capacity: 10,
          channelName: "A1",
        },
        {
          id: 12,
          goodId: 6,
          goodName: "Mystery Pack",
          status: true,
          currentInventory: 0,
          capacity: 8,
          channelName: "A2",
        },
      ],
    },
  });
});

afterEach(async () => {
  await fake.stop();
});

function client() {
  return createAwishWebClient({ baseUrl: fake.baseUrl, now: () => 1_762_250_000_000 });
}

describe("createAwishWebClient", () => {
  it("loggar in med rätt e-post och lösenord", async () => {
    const c = client();
    const tokens = await c.login({ email: fake.state.email, password: fake.state.password });
    expect(tokens.accessToken).toBe(fake.state.accessToken);
    expect(tokens.expiresIn).toBe(7200);
    // Signin skickas utan Authorization-header.
    expect(fake.state.calls[0]?.operationName).toBe("Signin");
    expect(fake.state.calls[0]?.token).toBeNull();
  });

  it("ger ett auth-fel vid fel lösenord", async () => {
    const c = client();
    await expect(c.login({ email: fake.state.email, password: "fel" })).rejects.toMatchObject({
      name: "AwishApiError",
      kind: "auth",
    });
  });

  it("listar automater och fack efter inloggning", async () => {
    const c = client();
    await c.login({ email: fake.state.email, password: fake.state.password });
    const machines = await c.machines();
    expect(machines).toEqual([{ id: 1001, machineNo: "BL-001", name: "Sega gubbens automat" }]);
    const products = await c.products(1001);
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({
      id: 11,
      goodName: "30th Celebration",
      currentInventory: 2,
      capacity: 10,
    });
  });

  it("sätter ett facks antal (absolut) via UpdateProduct", async () => {
    const c = client();
    await c.login({ email: fake.state.email, password: fake.state.password });
    await c.setProductInventory(12, { goodId: 6, status: true, currentInventory: 7 });
    expect(fake.state.products["1001"]?.find((p) => p.id === 12)?.currentInventory).toBe(7);
    const update = fake.state.calls.find((x) => x.operationName === "UpdateProduct");
    expect(update?.variables.id).toBe(12);
    expect((update?.variables.input as { current_inventory: number }).current_inventory).toBe(7);
  });

  it("översätter HTTP 503 till ett tillfälligt fel som går att försöka igen", async () => {
    fake.state.failNext = 3;
    const c = createAwishWebClient({
      baseUrl: fake.baseUrl,
      now: () => 1_762_250_000_000,
      sleep: async () => {},
    });
    await expect(
      c.login({ email: fake.state.email, password: fake.state.password }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AwishApiError && e.kind === "unavailable" && e.retryable,
    );
  });

  it("läsningar provas igen två gånger vid 503 och tidsgräns; 429 och skrivningar inte", async () => {
    const waits: number[] = [];
    const c = createAwishWebClient({
      baseUrl: fake.baseUrl,
      now: () => 1_762_250_000_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await c.login({ email: fake.state.email, password: fake.state.password });
    fake.state.failTimes.Products = 2;
    expect(await c.slots(1001)).toHaveLength(2);
    expect(waits).toEqual([500, 1500]);

    // 429: inget nytt försök (fler anrop gör det värre), egen feltyp för brytaren.
    fake.state.rateLimit = 1;
    const productsBefore = fake.state.calls.filter((x) => x.operationName === "Products").length;
    await expect(c.products(1001)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(fake.state.calls.filter((x) => x.operationName === "Products")).toHaveLength(
      productsBefore + 1,
    );
    expect(await c.products(1001)).toHaveLength(2);

    fake.state.rateLimit = 1;
    await expect(
      c.setProductInventory(12, { goodId: 6, status: true, currentInventory: 1 }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(fake.state.calls.filter((x) => x.operationName === "UpdateProduct")).toHaveLength(1);
  });

  it("HTTP 401 vid inloggningen blir auth och provas inte igen", async () => {
    fake.state.authFail = true;
    const c = createAwishWebClient({
      baseUrl: fake.baseUrl,
      now: () => 1_762_250_000_000,
      sleep: async () => {},
    });
    await expect(
      c.login({ email: fake.state.email, password: fake.state.password }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(fake.state.calls.filter((x) => x.operationName === "Signin")).toHaveLength(1);
  });

  it("tidsgränsen delas: anropet kortas till det som återstår och ger budget", async () => {
    fake.state.delayMs = 3_000;
    const c = createAwishWebClient({
      baseUrl: fake.baseUrl,
      deadlineAt: Date.now() + 1_500,
      sleep: async () => {},
    });
    const started = Date.now();
    await expect(
      c.login({ email: fake.state.email, password: fake.state.password }),
    ).rejects.toMatchObject({ kind: "budget" });
    expect(Date.now() - started).toBeLessThan(2_500);
    // Ingen tid kvar: inget anrop alls.
    const late = createAwishWebClient({ baseUrl: fake.baseUrl, deadlineAt: Date.now() + 500 });
    const before = fake.state.calls.length;
    await expect(late.machines()).rejects.toMatchObject({ kind: "budget" });
    expect(fake.state.calls.length).toBe(before);
  });

  it("profile ger kontots slutdag", async () => {
    const c = client();
    await c.login({ email: fake.state.email, password: fake.state.password });
    expect((await c.profile()).expiredAt).toBe("2027-04-18 23:48:54");
    fake.state.merchantExpiredAt = null;
    expect((await c.profile()).expiredAt).toBeNull();
  });

  it("nekar anrop utan giltig token", async () => {
    const c = client();
    // Ingen inloggning: products ska nekas.
    await expect(c.products(1001)).rejects.toMatchObject({ kind: "auth" });
  });
});
