/**
 * Inloggning: fel lösenord ger ett svenskt fel och ingen session, rätt lösenord leder in,
 * kontomenyn visar rollen (ägare och läsare) och utloggning fungerar. Läsaren ser inte
 * Datakällor och skickas bort från sidan.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  type Browser,
} from "./support/browser";
import { e2e, login, submitLogin } from "./support/session";

let browser: Browser;

beforeAll(async () => {
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
});

describe("inloggning", () => {
  it("fel lösenord ger ett fel och stannar på inloggningen", async () => {
    const { page, context, errors } = await openPage(browser, e2e().baseUrl);
    await submitLogin(page, e2e().users.owner, "fel-losenord-123");
    const alert = page.getByRole("alert").filter({ hasText: /lösenord|e-post/i });
    await alert.waitFor();
    expect(await alert.innerText()).toMatch(/fel|stämmer inte/i);
    expect(new URL(page.url()).pathname).toBe("/logga-in");
    // Ingen session: en skyddad sida skickar tillbaka till inloggningen.
    await page.goto("/lonsamhet");
    await page.waitForURL((url) => url.pathname.startsWith("/logga-in"));
    await screenshot(page, "01-inloggning-fel-losenord");
    expectNoPageErrors(errors);
    await context.close();
  });

  it("ägaren loggar in, ser rollen i kontomenyn och kan logga ut", async () => {
    const { page, context, errors } = await openPage(browser, e2e().baseUrl);
    await login(page, e2e().users.owner);
    expect(new URL(page.url()).pathname).toBe("/");
    await page.getByRole("heading", { level: 1 }).waitFor();

    const menu = page.getByRole("button", { name: /kontomeny/ });
    expect(await menu.innerText()).toContain("Ägare");
    await menu.click();
    await page.getByText(e2e().users.owner).waitFor();
    const nav = page.getByRole("navigation", { name: "System" });
    await nav.getByRole("link", { name: "Datakällor" }).waitFor();
    await screenshot(page, "01-inloggning-agare-kontomeny");

    await page.getByRole("button", { name: "Logga ut", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/logga-in"));
    expectNoPageErrors(errors);
    await context.close();
  });

  it("läsaren (delägaren) har läsroll och når inte Datakällor", async () => {
    const { page, context, errors } = await openPage(browser, e2e().baseUrl, { theme: "dark" });
    await login(page, e2e().users.partner);
    const menu = page.getByRole("button", { name: /kontomeny/ });
    expect(await menu.innerText()).toMatch(/Läsare|Delägare/);
    expect(await page.getByRole("link", { name: "Datakällor" }).count()).toBe(0);
    await page.goto("/datakallor");
    await page.waitForURL((url) => !url.pathname.startsWith("/datakallor"));
    await screenshot(page, "01-inloggning-lasare-mork");
    expectNoPageErrors(errors);
    await context.close();
  });
});
