/**
 * End-to-end: Chromium laddar tillägget (launchPersistentContext med --load-extension,
 * ny headless) mot en lokal låtsas-Awish (./mock-awish.ts, HTML-sidor och
 * cookie-inloggning) och Binderlab på dev-servern, och ordrarna hamnar i Binderlab.
 *
 *   node scripts/extension/build.mjs   # (testet bygger själv en testvariant)
 *   npx vitest run -c extensions/awish-sync/vitest.e2e.config.ts
 *
 * Miljö: BINDERLAB_URL (standard http://localhost:3200, dev-servern) och DATABASE_URL
 * (.env.local, samma databas som servern). Testet skapar en egen användare och
 * organisation och arkiverar organisationen efteråt. Flödet:
 *
 * 1. Logga in i Binderlab, skapa datakälla och token under Datakällor (token visas en gång).
 * 2. Logga in i låtsas-Awish i samma Chrome, klistra in adress och token i tillägget.
 * 3. Tillägget läser hela historiken (en sida i sekunden) och ordrarna finns i Binderlab.
 * 4. Utloggad från Awish: popupen säger det och Binderlab får rapporten.
 * 5. Nya ordrar efter ny inloggning: bara de nya skickas.
 */

import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { config } from "dotenv";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "../../../src/server/auth/password";
import { buildExtension } from "../../../scripts/extension/build.mjs";
import { makeOrders, startMockAwish, type MockAwishServer } from "./mock-awish";

config({ path: [".env.local", ".env"], quiet: true });

const BINDERLAB = (process.env.BINDERLAB_URL ?? "http://localhost:3200").replace(/\/+$/, "");
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PASSWORD = "Tillagg-e2e-lösen-2026";

// Minsta delen av Playwrights API som testet använder (paketet finns globalt, NODE_PATH).
interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  textContent(): Promise<string | null>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
  first(): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
}
interface Page {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  locator(selector: string): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  waitForURL(url: (u: URL) => boolean, options?: { timeout?: number }): Promise<void>;
  reload(): Promise<unknown>;
  close(): Promise<void>;
}
interface Worker {
  url(): string;
}
interface Context {
  newPage(): Promise<Page>;
  serviceWorkers(): Worker[];
  waitForEvent(event: "serviceworker", options?: { timeout?: number }): Promise<Worker>;
  request: {
    get(
      url: string,
    ): Promise<{ status(): number; headers(): Record<string, string>; body(): Promise<Buffer> }>;
  };
  close(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as {
  chromium: {
    launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<Context>;
  };
};

let sql: postgres.Sql;
let awish: MockAwishServer;
let context: Context;
let extensionId = "";
let orgId = "";
let email = "";
let sourceId = "";

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Tidsgräns: ${what}${last ? ` (${String(last)})` : ""}`);
}

async function ordersInBinderlab(): Promise<string[]> {
  const rows = await sql<{ external_id: string }[]>`
    select external_id from public.orders
    where organization_id = ${orgId}::uuid and data_source_id = ${sourceId}::uuid
    order by external_id`;
  return rows.map((r) => r.external_id);
}

async function loginAwish(page: Page): Promise<void> {
  await page.goto(`${awish.url}/dashboard/index/login`);
  await page.locator('input[name="username"]').fill("operator");
  await page.locator('input[name="password"]').fill("hemligt");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname === "/dashboard/orders/index");
}

beforeAll(async () => {
  const db = new URL(DATABASE_URL);
  if (!["127.0.0.1", "localhost"].includes(db.hostname)) {
    throw new Error("DATABASE_URL måste vara en lokal databas (samma som dev-servern).");
  }
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  const res = await fetch(`${BINDERLAB}/logga-in`, { redirect: "manual" });
  if (res.status !== 200) throw new Error(`Binderlab (${BINDERLAB}) svarar inte (${res.status}).`);

  // Egen användare och organisation (ägare) i dev-serverns databas.
  const suffix = Math.random().toString(36).slice(2, 8);
  email = `tillagg-e2e-${suffix}@test.binderlab.se`;
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${email}, ${await hashPassword(PASSWORD)}, '{}'::jsonb) returning id`;
  const claims = JSON.stringify({
    sub: user!.id,
    email,
    role: "authenticated",
    aud: "authenticated",
  });
  const [org] = await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`set local role authenticated`;
    return tx<
      { id: string }[]
    >`select public.create_organization(${`Tillägg e2e ${suffix}`}, ${`tillagg-e2e-${suffix}`}) as id`;
  });
  orgId = org!.id;

  // Låtsas-Awish med 65 ordrar (4 sidor) och en testvariant av tillägget som läser den.
  awish = await startMockAwish({ orders: makeOrders(65, 51_000) });
  const dir = mkdtempSync(path.join(tmpdir(), "binderlab-ext-e2e-"));
  const ext = path.join(dir, "ext");
  await buildExtension({ out: ext, zip: null, awishOrigin: awish.url });
  context = await chromium.launchPersistentContext(path.join(dir, "profil"), {
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
    headless: true,
    locale: "sv-SE",
    args: ["--no-proxy-server", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  extensionId = new URL(worker.url()).host;
}, 120_000);

afterAll(async () => {
  await context?.close().catch(() => undefined);
  await awish?.close().catch(() => undefined);
  if (orgId) {
    await sql`update public.organizations set archived_at = now() where id = ${orgId}::uuid`.catch(
      () => undefined,
    );
  }
  await sql?.end();
});

describe("Chrome-tillägget end-to-end", () => {
  let token = "";
  let popup: Page;
  let awishPage: Page;

  it("1. Datakällor: skapa datakälla och token (visas en gång), zip-filen går att ladda ner", async () => {
    const page = await context.newPage();
    await page.goto(`${BINDERLAB}/logga-in`);
    await page.getByLabel("E-postadress").fill(email);
    await page.getByLabel("Lösenord").fill(PASSWORD);
    await page.getByRole("button", { name: "Logga in", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/logga-in"), { timeout: 60_000 });
    await page.goto(`${BINDERLAB}/datakallor`, { timeout: 120_000 });

    await page.getByRole("button", { name: "Skapa datakälla för tillägget" }).click();
    await page.getByRole("button", { name: "Skapa", exact: true }).click();
    await page.getByRole("button", { name: "Skapa token" }).first().waitFor({ timeout: 30_000 });
    const [source] = await sql<{ id: string }[]>`
      select id from public.data_sources where organization_id = ${orgId}::uuid and provider = 'awish_extension'`;
    sourceId = source!.id;

    await page.getByRole("button", { name: "Skapa token" }).first().click();
    await page.locator("dialog[open]").getByRole("button", { name: "Skapa token" }).click();
    token = ((await page.locator('[data-testid="sync-token"]').textContent()) ?? "").trim();
    expect(token).toMatch(/^blsync_[A-Za-z0-9_-]{43}$/);
    const [stored] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.sync_tokens
      where organization_id = ${orgId}::uuid and token_hash = encode(sha256(convert_to(${token}, 'UTF8')), 'hex')`;
    expect(stored!.n).toBe(1);
    await page.getByRole("button", { name: "Klar" }).click();

    const zip = await context.request.get(`${BINDERLAB}/downloads/binderlab-awish-sync.zip`);
    expect(zip.status()).toBe(200);
    expect((await zip.body()).subarray(0, 2).toString()).toBe("PK");
    await page.close();
  }, 240_000);

  it("2–3. Inloggad i Awish + adress och token i tillägget: hela historiken hamnar i Binderlab", async () => {
    awishPage = await context.newPage();
    await loginAwish(awishPage);

    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator("#binderlab-url").fill(BINDERLAB);
    await popup.locator("#token").fill(token);
    await popup.getByRole("button", { name: "Spara" }).click();

    const paid = awish.orders
      .filter((o) => o.paid)
      .map((o) => o.orderNo)
      .sort();
    const got = await until("ordrarna i Binderlab", async () => {
      const ids = await ordersInBinderlab();
      return ids.length >= paid.length ? ids : null;
    }).catch(async (error: unknown) => {
      // Vad tillägget själv säger, för felsökning.
      const text = async (sel: string) => ((await popup.locator(sel).textContent()) ?? "").trim();
      console.error("[e2e] popup", {
        headline: await text("#headline"),
        banner: await text("#banner"),
        error: await text("#error"),
        lastRun: await text("#last-run"),
        awishHits: awish.hits.slice(-10),
      });
      throw error;
    });
    expect(got).toEqual(paid);

    // En lugn takt: sidorna 1–4 med minst ~1 s emellan, alltid med inloggningens cookie.
    const pages = awish.hits.filter(
      (h) => /page=\d/.test(h.path) || h.path === "/dashboard/orders/index",
    );
    expect(pages.every((h) => h.cookie)).toBe(true);
    const htmlPages = awish.hits.filter(
      (h) => !h.xhr && h.path.startsWith("/dashboard/orders/index"),
    );
    for (let i = 1; i < htmlPages.length; i += 1) {
      expect(htmlPages[i]!.at - htmlPages[i - 1]!.at).toBeGreaterThanOrEqual(900);
    }

    const imports = await sql<{ trigger: string; status: string }[]>`
      select trigger::text, status::text from public.imports
      where organization_id = ${orgId}::uuid and data_source_id = ${sourceId}::uuid`;
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((i) => i.trigger === "extension" && i.status === "succeeded")).toBe(true);
    const [tok] = await until("rapporten ok", async () => {
      const r = await sql<{ last_status: string | null; client_version: string | null }[]>`
        select last_status, client_version from public.sync_tokens
        where organization_id = ${orgId}::uuid and data_source_id = ${sourceId}::uuid`;
      return r[0]?.last_status === "ok" ? r : null;
    });
    expect(tok!.client_version).toBe("1.0.0");
    // Okända automater ligger i kön.
    const queue = await sql<{ n: number }[]>`
      select count(*)::int as n from public.source_machines
      where organization_id = ${orgId}::uuid and data_source_id = ${sourceId}::uuid and machine_id is null`;
    expect(queue[0]!.n).toBe(3);

    await until("popupen visar att synken är igång", async () =>
      ((await popup.locator("#headline").textContent()) ?? "").includes("Synken är igång"),
    );
  }, 240_000);

  it("4. Utloggad från Awish: popupen ber om inloggning och Binderlab får rapporten", async () => {
    awish.expireSessions();
    await popup.getByRole("button", { name: "Synka nu" }).click();
    await until("utloggad i popupen", async () =>
      ((await popup.locator("#banner").textContent()) ?? "").includes(
        "i Chrome så fortsätter synken",
      ),
    );
    await until("rapporten logged_out", async () => {
      const r = await sql<{ last_status: string | null }[]>`
        select last_status from public.sync_tokens
        where organization_id = ${orgId}::uuid and data_source_id = ${sourceId}::uuid`;
      return r[0]?.last_status === "logged_out";
    });
  }, 120_000);

  it("5. Nya ordrar efter ny inloggning: bara de nya skickas", async () => {
    const before = (await ordersInBinderlab()).length;
    const newer = makeOrders(7, 51_065, Date.UTC(2026, 10, 2, 9, 0, 0));
    awish.orders = [...newer, ...awish.orders];
    await loginAwish(awishPage);
    const importsBefore = await sql<{ n: number }[]>`
      select count(*)::int as n from public.imports where organization_id = ${orgId}::uuid`;
    await popup.reload();
    await popup.getByRole("button", { name: "Synka nu" }).click();
    const expected = before + newer.filter((o) => o.paid).length;
    await until("de nya ordrarna", async () => (await ordersInBinderlab()).length >= expected);
    expect((await ordersInBinderlab()).length).toBe(expected);
    const latest = await sql<{ rows_total: number; rows_duplicate: number }[]>`
      select rows_total, rows_duplicate from public.imports
      where organization_id = ${orgId}::uuid and created_at > now() - interval '5 minutes'
      order by created_at desc limit ${(await sql<{ n: number }[]>`select count(*)::int as n from public.imports where organization_id = ${orgId}::uuid`)[0]!.n - importsBefore[0]!.n}`;
    expect(latest.reduce((n, i) => n + i.rows_total, 0)).toBe(newer.length);
    expect(latest.every((i) => i.rows_duplicate === 0)).toBe(true);
    await until("utloggningen är borta", async () => {
      const r = await sql<{ last_status: string | null }[]>`
        select last_status from public.sync_tokens where organization_id = ${orgId}::uuid`;
      return r[0]?.last_status === "ok";
    });
  }, 120_000);
});
