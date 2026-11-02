/**
 * Felövervakning: ett misslyckat schemalagt jobb (månadsutkasten) ger ett larm som ägaren ser
 * på Drift och i Att göra, men inte påfyllaren. När jobbet lyckas stängs larmet.
 *
 * Felet skapas på serversidan med samma funktion som jobbet använder
 * (src/server/monitoring, recordDraftsOutcome) mot serverns databas; resten går genom
 * webbläsaren. Sentry-händelsen (när SENTRY_DSN finns) testas i test/db/monitoring.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import type * as Monitoring from "@/server/monitoring";

import { launchBrowser, openPage, screenshot, type Browser } from "./support/browser";
import { e2e, login } from "./support/session";

const TITLE = "Utkasten för oktober 2026 kunde inte skapas";

let browser: Browser;
let db: Db;
let closeDb: () => Promise<void>;
let monitoring: typeof Monitoring;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  const client = await import("@/db/client");
  db = client.getServiceDb();
  closeDb = client.closeServiceDb;
  monitoring = await import("@/server/monitoring");
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await closeDb?.();
});

describe("felövervakning", () => {
  it("misslyckade månadsutkast syns på Drift och i Att göra", async () => {
    const outcome = await monitoring.recordDraftsOutcome(
      { db },
      {
        organizationId: e2e().organizationId,
        month: "2026-10",
        created: 0,
        errors: ["butik: E2E-test av felövervakningen"],
      },
    );
    expect(outcome.alertId).toMatch(/^[0-9a-f-]{36}$/);

    const { page, context } = await openPage(browser, e2e().baseUrl);
    await login(page, e2e().users.owner);
    await page.goto("/drift");
    const alert = page.getByText(TITLE).first();
    await alert.waitFor();
    await page.getByText("Misslyckad rapport").first().waitFor();
    await alert.scrollIntoViewIfNeeded();
    await screenshot(page, "06-felovervakning-drift");

    await page.goto("/att-gora");
    await page.getByText(TITLE).first().waitFor();
    await screenshot(page, "06-felovervakning-att-gora");
    await context.close();
  });

  it("påfyllaren ser inte systemlarmet", async () => {
    const { page, context } = await openPage(browser, e2e().baseUrl, { viewport: "mobile" });
    await login(page, e2e().users.refiller);
    await page.goto("/drift");
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(await page.getByText(TITLE).count()).toBe(0);
    await context.close();
  });

  it("när jobbet lyckas stängs larmet", async () => {
    const outcome = await monitoring.recordDraftsOutcome(
      { db },
      { organizationId: e2e().organizationId, month: "2026-10", created: 3, errors: [] },
    );
    expect(outcome.resolved).toBe(1);
    const { page, context } = await openPage(browser, e2e().baseUrl);
    await login(page, e2e().users.owner);
    await page.goto("/att-gora");
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(await page.getByText(TITLE).count()).toBe(0);
    await context.close();
  });
});
