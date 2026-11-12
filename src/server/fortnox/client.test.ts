import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  authorizeUrl,
  classifyError,
  exchangeCode,
  FortnoxApiError,
  FortnoxAuthError,
  FortnoxClient,
  kronor,
  RateLimiter,
  refreshTokens,
  voucherBody,
  type FortnoxTokens,
} from "./client";
import { fortnoxConfig, fortnoxConfigProblem, type FortnoxConfig } from "./config";
import { FakeFortnox } from "./testing/fake-fortnox";

const REDIRECT = "http://127.0.0.1:3210/datakallor/fortnox/klar";

let fake: FakeFortnox;
let config: FortnoxConfig;

beforeEach(async () => {
  fake = new FakeFortnox();
  const url = await fake.start();
  config = {
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    redirectUri: REDIRECT,
    apiBaseUrl: url,
    authBaseUrl: url,
  };
});

afterEach(async () => {
  await fake.stop();
});

async function connect(): Promise<FortnoxTokens> {
  const verifier = "v".repeat(50);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return exchangeCode(config, fake.issueCode(REDIRECT, challenge), verifier);
}

/** En token-källa som förnyar mot den falska servern, som appens egen gör. */
function source(tokens: FortnoxTokens) {
  let current = tokens;
  let refreshes = 0;
  const get = async (force = false) => {
    if (force) {
      current = await refreshTokens(config, current.refreshToken);
      refreshes += 1;
    }
    return current.accessToken;
  };
  return { get, refreshes: () => refreshes, current: () => current };
}

const SALES = {
  series: "A",
  date: "2026-10-31",
  description: "Försäljning oktober 2026 [bl-test]",
  rows: [
    { account: "1580", amountOre: 7_624_500, text: "Försäljning" },
    { account: "3000", amountOre: -7_624_500, text: "Försäljning" },
  ],
};

describe("config", () => {
  it("kräver klient-id, hemlighet och en adress att komma tillbaka till", () => {
    expect(fortnoxConfig({ NODE_ENV: "test" })).toBeNull();
    expect(fortnoxConfigProblem({ NODE_ENV: "test" })).toMatch(/FORTNOX_CLIENT_ID/);
    expect(
      fortnoxConfigProblem({
        NODE_ENV: "test",
        FORTNOX_CLIENT_ID: "a",
        FORTNOX_CLIENT_SECRET: "b",
      }),
    ).toMatch(/APP_URL/);
    const ok = fortnoxConfig({
      NODE_ENV: "test",
      FORTNOX_CLIENT_ID: "a",
      FORTNOX_CLIENT_SECRET: "b",
      APP_URL: "https://app.example.se/",
    });
    expect(ok?.redirectUri).toBe("https://app.example.se/datakallor/fortnox/klar");
    expect(ok?.apiBaseUrl).toBe("https://api.fortnox.se");
    expect(ok?.authBaseUrl).toBe("https://apps.fortnox.se");
  });

  it("godtar en annan Fortnox-adress bara på den egna datorn", () => {
    const base = {
      NODE_ENV: "test" as const,
      FORTNOX_CLIENT_ID: "a",
      FORTNOX_CLIENT_SECRET: "b",
      APP_URL: "https://app.example.se",
    };
    expect(
      fortnoxConfig({ ...base, FORTNOX_API_BASE_URL: "http://127.0.0.1:4010" })?.apiBaseUrl,
    ).toBe("http://127.0.0.1:4010");
    for (const bad of ["https://evil.example", "http://evil.example", "http://127.0.0.1:1/x"]) {
      expect(fortnoxConfig({ ...base, FORTNOX_API_BASE_URL: bad })?.apiBaseUrl).toBe(
        "https://api.fortnox.se",
      );
      expect(fortnoxConfig({ ...base, FORTNOX_AUTH_BASE_URL: bad })?.authBaseUrl).toBe(
        "https://apps.fortnox.se",
      );
    }
    // Tillbaka-adressen måste vara https utanför den egna datorn.
    expect(fortnoxConfig({ ...base, APP_URL: "http://app.example.se" })).toBeNull();
  });
});

describe("belopp och verifikatets form", () => {
  it("räknar öre till kronor utan avrundningsfel", () => {
    expect(kronor(7_624_500)).toBe(76245);
    expect(kronor(304_980)).toBe(3049.8);
    expect(kronor(82_472)).toBe(824.72);
    expect(kronor(1)).toBe(0.01);
    expect(kronor(7_233_048)).toBe(72330.48);
  });

  it("vägrar ett verifikat som inte balanserar", () => {
    expect(() =>
      voucherBody({ ...SALES, rows: [SALES.rows[0]!, { ...SALES.rows[1]!, amountOre: -1 }] }),
    ).toThrow(/balanserar inte/);
    expect(() => voucherBody({ ...SALES, rows: [SALES.rows[0]!] })).toThrow();
    expect(voucherBody(SALES)).toEqual({
      Voucher: {
        Description: SALES.description,
        TransactionDate: "2026-10-31",
        VoucherSeries: "A",
        VoucherRows: [
          { Account: 1580, Debit: 76245, Credit: 0, TransactionInformation: "Försäljning" },
          { Account: 3000, Debit: 0, Credit: 76245, TransactionInformation: "Försäljning" },
        ],
      },
    });
  });

  it("sorterar Fortnox fel", () => {
    expect(classifyError(429, { code: null, message: "" })).toBe("rate_limited");
    expect(classifyError(401, { code: null, message: "unauthorized" })).toBe("unauthorized");
    expect(classifyError(403, { code: 2000310, message: "Ogiltig inloggning" })).toBe(
      "unauthorized",
    );
    expect(classifyError(403, { code: 2001103, message: "Api-licens saknas." })).toBe("forbidden");
    expect(classifyError(400, { code: 2000401, message: "Perioden är låst" })).toBe(
      "locked_period",
    );
    expect(
      classifyError(400, { code: null, message: "The period is locked up to 2026-10-31" }),
    ).toBe("locked_period");
    expect(classifyError(400, { code: 2000423, message: "Kan inte hitta kontot." })).toBe(
      "unknown_account",
    );
    expect(
      classifyError(400, { code: null, message: "Datumet ligger inte i något räkenskapsår." }),
    ).toBe("no_financial_year");
    expect(classifyError(400, { code: null, message: "Verifikationsserien finns inte." })).toBe(
      "unknown_series",
    );
    expect(classifyError(500, { code: null, message: "" })).toBe("server");
    expect(classifyError(400, { code: 2000588, message: "Ogiltig parameter i anropet." })).toBe(
      "invalid",
    );
  });
});

describe("token", () => {
  it("adressen för godkännandet bär PKCE, state och servicekonto", () => {
    const url = new URL(
      authorizeUrl(config, ["bookkeeping", "settings"], "state-1", "challenge-1"),
    );
    expect(url.pathname).toBe("/oauth-v1/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: fake.clientId,
      redirect_uri: REDIRECT,
      scope: "bookkeeping settings",
      state: "state-1",
      access_type: "offline",
      response_type: "code",
      account_type: "service",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
    expect(url.toString()).not.toContain(fake.clientSecret);
  });

  it("koden gäller en gång och PKCE kontrolleras", async () => {
    const verifier = "x".repeat(60);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = fake.issueCode(REDIRECT, challenge);
    await expect(exchangeCode(config, code, "fel-verifier")).rejects.toMatchObject({
      kind: "invalid_grant",
    });
    const code2 = fake.issueCode(REDIRECT, challenge);
    const tokens = await exchangeCode(config, code2, verifier);
    expect(tokens.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    await expect(exchangeCode(config, code2, verifier)).rejects.toBeInstanceOf(FortnoxAuthError);
  });

  it("refresh-token byts varje gång och den gamla gäller inte efteråt", async () => {
    const first = await connect();
    const second = await refreshTokens(config, first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    await expect(refreshTokens(config, first.refreshToken)).rejects.toMatchObject({
      kind: "invalid_grant",
    });
    // Den nya fungerar.
    await expect(refreshTokens(config, second.refreshToken)).resolves.toBeTruthy();
  });

  it("skiljer ett tillfälligt fel från en koppling som inte gäller", async () => {
    const tokens = await connect();
    fake.tokenOutages = 1;
    await expect(refreshTokens(config, tokens.refreshToken)).rejects.toMatchObject({
      kind: "temporary",
    });
    // Refresh-token förbrukades inte av det misslyckade försöket.
    await expect(refreshTokens(config, tokens.refreshToken)).resolves.toBeTruthy();
    await expect(
      refreshTokens({ ...config, clientSecret: "fel" }, tokens.refreshToken),
    ).rejects.toMatchObject({ kind: "invalid_client" });
    await expect(
      refreshTokens({ ...config, authBaseUrl: "http://127.0.0.1:1" }, tokens.refreshToken),
    ).rejects.toMatchObject({ kind: "temporary" });
  });

  it("fel från token-tjänsten innehåller aldrig token eller hemlighet", async () => {
    const tokens = await connect();
    await refreshTokens(config, tokens.refreshToken);
    const error = await refreshTokens(config, tokens.refreshToken).catch((e: unknown) => e);
    const text = `${String(error)} ${JSON.stringify(error)}`;
    expect(text).not.toContain(tokens.refreshToken);
    expect(text).not.toContain(fake.clientSecret);
  });
});

describe("API", () => {
  it("skapar ett verifikat och får numret", async () => {
    const s = source(await connect());
    const client = new FortnoxClient(config, s.get);
    const year = await client.financialYearFor("2026-10-31");
    expect(year).toEqual({ id: 2, from: "2026-01-01", to: "2026-12-31" });
    expect(await client.createVoucher(SALES, year!.id)).toEqual({
      series: "A",
      number: 1,
      year: 2,
    });
    expect(await client.createVoucher(SALES, year!.id)).toEqual({
      series: "A",
      number: 2,
      year: 2,
    });
    // Fortnox stoppar inte dubbletter: två likadana verifikat finns nu.
    expect(fake.vouchers).toHaveLength(2);
    expect(await client.listVouchers("A", 2, "2026-10-01", "2026-10-31")).toEqual([
      { series: "A", number: 1, year: 2, date: "2026-10-31", description: SALES.description },
      { series: "A", number: 2, year: 2, date: "2026-10-31", description: SALES.description },
    ]);
    expect(await client.company()).toEqual({ name: "Testbolaget AB", tenant: "123456" });
  });

  it("en utgången åtkomsttoken förnyas en gång och anropet går igenom utan dubblett", async () => {
    const s = source(await connect());
    const client = new FortnoxClient(config, s.get);
    fake.expireAccessTokens();
    expect(await client.createVoucher(SALES, 2)).toEqual({ series: "A", number: 1, year: 2 });
    expect(s.refreshes()).toBe(1);
    expect(fake.vouchers).toHaveLength(1);
    expect(fake.requests.map((r) => r.status)).toEqual([401, 201]);
  });

  it("en återkallad koppling ger invalid_grant, inte en evig slinga", async () => {
    const s = source(await connect());
    const client = new FortnoxClient(config, s.get);
    fake.revokeAll();
    await expect(client.lockedUntil()).rejects.toMatchObject({ kind: "invalid_grant" });
  });

  it("låst period, okänt konto, okänd serie och fel år nekas säkert", async () => {
    const s = source(await connect());
    const client = new FortnoxClient(config, s.get);
    fake.lockedUntil = "2026-10-31";
    expect(await client.lockedUntil()).toBe("2026-10-31");
    await expect(client.createVoucher(SALES, 2)).rejects.toMatchObject({
      kind: "locked_period",
      definite: true,
    });
    fake.lockedUntil = null;
    expect(await client.lockedUntil()).toBeNull();

    fake.accounts.delete(3000);
    expect(await client.accountState("3000", 2)).toBe("missing");
    await expect(client.createVoucher(SALES, 2)).rejects.toMatchObject({
      kind: "unknown_account",
      definite: true,
    });
    fake.accounts.set(3000, false);
    expect(await client.accountState("3000", 2)).toBe("inactive");
    fake.accounts.set(3000, true);
    expect(await client.accountState("3000", 2)).toBe("ok");

    await expect(client.createVoucher({ ...SALES, series: "ZZ" }, 2)).rejects.toMatchObject({
      kind: "unknown_series",
    });
    expect(await client.voucherSeries(2)).toEqual(["A", "B", "C"]);
    expect(await client.financialYearFor("2031-01-01")).toBeNull();
    await expect(client.createVoucher({ ...SALES, date: "2031-01-01" }, 2)).rejects.toMatchObject({
      kind: "no_financial_year",
    });
    expect(fake.vouchers).toHaveLength(0);
  });

  it("ett tappat svar är ovisst: verifikatet finns i Fortnox men felet säger inte 'säkert'", async () => {
    const s = source(await connect());
    const client = new FortnoxClient(config, s.get);
    fake.dropNextVoucherReply = true;
    const error = await client.createVoucher(SALES, 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FortnoxApiError);
    expect(error).toMatchObject({ kind: "network", definite: false });
    expect(fake.vouchers).toHaveLength(1);
  });

  it("5xx är ovisst, 4xx är säkert", async () => {
    const s = source(await connect());
    const client = new FortnoxClient(config, s.get);
    fake.failNext.push({ status: 502 });
    await expect(client.createVoucher(SALES, 2)).rejects.toMatchObject({
      kind: "server",
      definite: false,
    });
    fake.failNext.push({
      status: 403,
      body: { ErrorInformation: { Error: 1, Message: "Api-licens saknas.", Code: 2001103 } },
    });
    await expect(client.createVoucher(SALES, 2)).rejects.toMatchObject({
      kind: "forbidden",
      definite: true,
      code: 2001103,
    });
  });

  it("408 och 425 är ovissa: en mellanserver kan ha gett upp medan anropet gick fram", async () => {
    const s = source(await connect());
    const client = new FortnoxClient(config, s.get);
    for (const status of [408, 425]) {
      fake.failNext.push({ status });
      await expect(client.createVoucher(SALES, 2)).rejects.toMatchObject({ definite: false });
    }
  });

  it("väntar ut 429 och skickar inget två gånger", async () => {
    const s = source(await connect());
    const waits: number[] = [];
    const client = new FortnoxClient(
      config,
      s.get,
      { sleep: async (ms) => void waits.push(ms) },
      "t",
      // Ingen egen gräns här: testet gäller Fortnox 429.
      new RateLimiter(Date.now, async () => undefined, 1000),
    );
    fake.failNext.push({ status: 429 }, { status: 429 });
    expect(await client.createVoucher(SALES, 2)).toEqual({ series: "A", number: 1, year: 2 });
    expect(waits).toEqual([5000, 5000]);
    expect(fake.vouchers).toHaveLength(1);
    // Ger upp efter fyra väntor, och säger att inget gjordes.
    fake.failNext.push(...Array.from({ length: 5 }, () => ({ status: 429 })));
    await expect(client.createVoucher(SALES, 2)).rejects.toMatchObject({
      kind: "rate_limited",
      definite: true,
    });
    expect(fake.vouchers).toHaveLength(1);
  });

  it("den egna gränsen håller sig under Fortnox 25 anrop per 5 sekunder", async () => {
    fake.rateLimit = true;
    const s = source(await connect());
    // Falsk klocka: den egna gränsen "sover" genom att flytta klockan, även Fortnox klocka.
    let t = 0;
    const fakeClock = () => t;
    const limiter = new RateLimiter(fakeClock, async (ms) => {
      t += ms;
      fake.advance(ms);
    });
    const client = new FortnoxClient(config, s.get, {}, "t", limiter);
    for (let i = 0; i < 60; i += 1) await client.lockedUntil();
    expect(fake.requests.filter((r) => r.status === 429)).toHaveLength(0);
    expect(fake.requests).toHaveLength(60);
    // Utan egen gräns slår Fortnox i taket.
    const unlimited = new FortnoxClient(
      config,
      s.get,
      { sleep: async () => undefined },
      "u",
      new RateLimiter(Date.now, async () => undefined, 10_000),
    );
    await expect(
      (async () => {
        for (let i = 0; i < 40; i += 1) await unlimited.lockedUntil();
      })(),
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });
});
