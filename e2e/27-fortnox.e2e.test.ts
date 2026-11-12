/**
 * Fortnox genom webbläsaren på en iPhone SE (375 px), mot en falsk Fortnox som testet
 * startar på 127.0.0.1:4610 (servern under test pekar dit med FORTNOX_*_BASE_URL, se
 * scripts/e2e/local-server.sh och .github/workflows/ci.yml). Aldrig riktiga Fortnox.
 *
 * 1. Läsaren (delägaren) ser ingen rad om Fortnox och når inte sidan.
 * 2. Ägaren kopplar Fortnox (godkännandet hos Fortnox och tillbaka), väljer startmånad och
 *    ser i torrkörningen exakt vad som skulle skickas. Inget har skickats.
 * 3. Ägaren slår på och trycker Kör nu: verifikaten finns i Fortnox, balanserade, en gång.
 *    Kör nu igen och nattens jobb (/api/cron/fortnox) skickar inget mer.
 * 4. Ekonomi → Bokföring visar "Fortnox: allt bokfört t.o.m. i går." och Fortnox nummer.
 *
 * På varje skärm: ingen sidledes rullning, inget som sticker ut, tryckytor minst 44 px.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeFortnox } from "@/server/fortnox/testing/fake-fortnox";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  until,
  type Browser,
  type BrowserContext,
  screenshot,
  type Page,
} from "./support/browser";
import { inspect } from "./support/layout";
import { e2e, login } from "./support/session";

const DEVICE = "iPhone SE (3rd gen)";
const PORT = Number(process.env.E2E_FAKE_FORTNOX_PORT ?? 4610);

let browser: Browser;
let fake: FakeFortnox;
let context: BrowserContext;
let page: Page;
let errors: Error[];

async function ready(p: Page): Promise<void> {
  await p.waitForLoadState("networkidle").catch(() => {});
  await p
    .waitForFunction(() => !document.querySelector("[aria-busy='true'], [data-loading]"))
    .catch(() => {});
}

async function layout(p: Page, where: string): Promise<void> {
  await ready(p);
  const problems = await p.evaluate(inspect);
  const report = problems.map((x) => `${where} · ${x.kind}: ${x.what}`);
  expect(report, `${DEVICE} ${where}:\n${report.join("\n")}`).toEqual([]);
}

/**
 * Raden om Fortnox på Bokföring. Sektionen strömmas in (Suspense), så för ett ögonblick kan
 * den finnas både i strömmens dolda behållare och på sin plats: vänta tills den finns en gång.
 */
async function fortnoxLine(p: Page): Promise<string> {
  const line = p.locator("[data-fortnox-line]");
  return until(
    async () => ((await line.count()) === 1 && (await line.isVisible()) ? line.innerText() : false),
    "raden om Fortnox visas en gång",
  );
}

const heading = (p: Page) => p.getByRole("heading", { level: 1 });

beforeAll(async () => {
  // Börja från "inte kopplat", även när testet körs igen mot samma databas. Utkorgens
  // rader går inte att radera (triggern), så testdatabasen städas med triggrarna avstängda.
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL saknas.");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const org = e2e().organizationId;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from public.fortnox_vouchers where organization_id = ${org}::uuid`;
      await tx`delete from public.fortnox_sync_state where organization_id = ${org}::uuid`;
      await tx`delete from public.fortnox_connections where organization_id = ${org}::uuid`;
      await tx`delete from vault.secrets where name = ${`${org}/fortnox`}`;
      await tx`delete from public.alerts where organization_id = ${org}::uuid and incident_key like 'fortnox:%'`;
    });
  } finally {
    await sql.end();
  }
  fake = new FakeFortnox();
  await fake.start(PORT);
  browser = await launchBrowser();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await fake?.stop();
});

describe("Fortnox på iPhone SE", () => {
  it("läsaren ser ingen rad om Fortnox och når inte sidan", async () => {
    const reader = await openPage(browser, e2e().baseUrl, { device: DEVICE });
    try {
      await login(reader.page, e2e().users.partner);
      await reader.page.goto("/ekonomi?vy=bokforing");
      await ready(reader.page);
      await reader.page.getByRole("heading", { level: 1 }).first().waitFor();
      expect(await reader.page.locator("[data-fortnox-line]").count()).toBe(0);
      expect(await reader.page.getByText(/Fortnox:/).count()).toBe(0);
      await reader.page.goto("/datakallor/fortnox");
      await reader.page.waitForURL((u) => !u.pathname.startsWith("/datakallor"));
      expectNoPageErrors(reader.errors);
    } finally {
      await reader.context.close();
    }
  });

  it("ägaren ser att Fortnox inte är kopplat", async () => {
    ({ page, context, errors } = await openPage(browser, e2e().baseUrl, { device: DEVICE }));
    await login(page, e2e().users.owner);
    await page.goto("/ekonomi?vy=bokforing");
    expect(await fortnoxLine(page)).toBe("Fortnox är inte kopplat.");
    await layout(page, "/ekonomi?vy=bokforing (inte kopplat)");
    await page.getByRole("link", { name: /Koppla Fortnox/ }).click();
    await page.waitForURL(/\/datakallor\/fortnox$/);
    await heading(page).waitFor();
    expect(await heading(page).innerText()).toBe("Fortnox är inte kopplat.");
    await layout(page, "/datakallor/fortnox (inte kopplat)");
  });

  it("kopplar: godkänner hos Fortnox och kommer tillbaka i torrkörning", async () => {
    await page.getByRole("button", { name: "Koppla Fortnox", exact: true }).click();
    await page.waitForURL(/\/datakallor\/fortnox\?kopplad=ja$/);
    await page.locator("[data-fortnox-notice='good']").waitFor();
    expect(await page.locator("[data-fortnox-notice]").innerText()).toBe(
      "Fortnox är kopplat. Inget skickas förrän du slår på.",
    );
    expect(await heading(page).innerText()).toBe(
      "Fortnox är kopplat. Välj från vilken månad det ska bokföras.",
    );
    await page.getByText("Kopplat till Testbolaget AB.").waitFor();
    // Koden och token syns aldrig i adressen efteråt.
    expect(page.url()).not.toMatch(/code=|state=|token/);
    expect(fake.tokenRequests).toEqual([{ grant: "authorization_code", status: 200 }]);
    await layout(page, "/datakallor/fortnox (kopplat, ingen startmånad)");
  });

  it("torrkörningen visar vad som skulle skickas, och inget skickas", async () => {
    await page.getByLabel("Bokför från och med").fill("2026-10");
    await page.getByRole("button", { name: "Spara", exact: true }).click();
    await until(
      async () =>
        /torrkörning\. \d+ verifikat skulle skickas/.test(await heading(page).innerText()),
      "rubriken visar torrkörningen",
    );
    const list = page.getByRole("list", { name: "Verifikat som skickas härnäst" });
    const sales = list.getByText("Försäljning automater oktober 2026").first();
    await sales.waitFor();
    // Öppna verifikatet: raderna med konto, debet och kredit ryms på 375 px.
    await sales.click();
    await list.getByRole("columnheader", { name: "Debet" }).first().waitFor();
    await list.getByText("1580").first().waitFor();
    expect(fake.vouchers).toEqual([]);
    expect(fake.requests.filter((r) => r.method === "POST")).toEqual([]);
    await layout(page, "/datakallor/fortnox (torrkörning)");
    await screenshot(page, "27-fortnox-torrkorning");
    // Räkna om i torrkörning skickar inte heller något.
    await page.getByRole("button", { name: "Räkna om", exact: true }).click();
    await page.getByText(/Torrkörning: \d+ verifikat skulle skickas\. Inget skickades\./).waitFor();
    expect(fake.vouchers).toEqual([]);
  });

  it("slår på och kör: verifikaten finns i Fortnox, balanserade, en gång", async () => {
    await page.getByRole("button", { name: "Slå på Fortnox", exact: true }).click();
    await page.getByText(/skickas till Fortnox på riktigt/).waitFor();
    await layout(page, "/datakallor/fortnox (bekräfta)");
    await page.getByRole("button", { name: "Ja, slå på", exact: true }).click();
    await page.getByRole("heading", { name: /Fortnox är på\./ }).waitFor();
    expect(fake.vouchers).toEqual([]);
    await page.getByRole("button", { name: "Kör nu", exact: true }).click();
    await page.getByText(/^\d+ verifikat bokförda i Fortnox\.$/).waitFor();
    const count = fake.vouchers.length;
    expect(count).toBeGreaterThanOrEqual(1);
    const sales = fake.vouchers.filter((v) =>
      v.description.startsWith("Försäljning automater oktober 2026"),
    );
    expect(sales).toHaveLength(1);
    expect(sales[0]!.date).toBe("2026-10-31");
    for (const v of fake.vouchers) {
      const debit = v.rows.reduce((n, r) => n + r.debit, 0);
      const credit = v.rows.reduce((n, r) => n + r.credit, 0);
      expect(debit).toBe(credit);
      expect(debit).toBeGreaterThan(0);
      expect(v.description).toMatch(/\[BL-[0-9a-f]{16}\]$/);
    }
    // En gång till: inget nytt.
    await page.getByRole("button", { name: "Kör nu", exact: true }).click();
    await page.getByText("0 verifikat bokförda i Fortnox.").waitFor();
    expect(fake.vouchers).toHaveLength(count);
    await until(
      async () => (await heading(page).innerText()) === "Fortnox: allt bokfört t.o.m. i går.",
      "rubriken säger att allt är bokfört",
    );
    await page
      .getByRole("list", { name: "Verifikat i utkorgen" })
      .getByText(/^A \d+$/)
      .first()
      .waitFor();
    await layout(page, "/datakallor/fortnox (på)");
  });

  it("nattens jobb kräver hemligheten och skickar inget två gånger", async () => {
    const count = fake.vouchers.length;
    const url = new URL("/api/cron/fortnox", e2e().baseUrl);
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { authorization: "Bearer fel-hemlighet-0123456789" } })).status,
    ).toBe(401);
    const secret = e2e().cronSecret;
    if (!secret) throw new Error("E2E_CRON_SECRET saknas: nattens jobb kan inte köras.");
    const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      organizations: { organizationId: string; status: string; sent: number }[];
    };
    expect(body.ok).toBe(true);
    expect(body.organizations.find((o) => o.organizationId === e2e().organizationId)).toMatchObject(
      {
        status: "ran",
        sent: 0,
      },
    );
    expect(JSON.stringify(body)).not.toMatch(/at_|rt_|token/i);
    expect(fake.vouchers).toHaveLength(count);
  });

  it("Ekonomi → Bokföring visar raden och Fortnox nummer", async () => {
    await page.goto("/ekonomi?vy=bokforing");
    expect(await fortnoxLine(page)).toBe("Fortnox: allt bokfört t.o.m. i går.");
    await page.getByText(/^Skickat till Fortnox \(\d+\)$/).click();
    const list = page.getByRole("list", { name: "Verifikat i Fortnox" });
    await list.getByText("Försäljning automater oktober 2026").first().waitFor();
    await list
      .getByText(/^A \d+$/)
      .first()
      .waitFor();
    await layout(page, "/ekonomi?vy=bokforing (Fortnox på)");
    await screenshot(page, "27-fortnox-bokforing");
    expectNoPageErrors(errors);
  });
});
