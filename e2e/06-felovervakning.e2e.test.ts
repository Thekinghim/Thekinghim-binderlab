/**
 * Felövervakning, från riktigt fel till larm:
 *
 * 1. Larmjobbet (GET /api/cron/larm med CRON_SECRET) misslyckas för organisationen: ett
 *    framkallat databasfel när jobbet sparar sin körning (en tillfällig trigger på
 *    public.alert_runs, bara i e2e-databasen). Larmet "Larmjobbet misslyckades" syns på
 *    Drift och i Att göra för ägaren, inte för påfyllaren.
 * 2. Jobbet körs igen utan felet: larmet stängs (inte längre öppet på Drift, borta ur Att
 *    göra).
 * 3. En import misslyckas genom gränssnittet (tillfällig trigger på public.orders för
 *    datakällan "E2E-felande import"): Datakällor visar felet och Drift larmet.
 *
 * Felen framkallas i databasen (systemroll) eftersom appen inte har några testkrokar; allt
 * annat går genom servern och webbläsaren. Sentry-händelserna (när SENTRY_DSN finns)
 * testas i test/db/monitoring.test.ts och src/server/monitoring/*.test.ts.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  until,
  type Browser,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

const JOB_TITLE = /^Larmjobbet misslyckades/;
const FAULT = "E2E: framkallat fel i larmjobbet";

let browser: Browser;
let sql: postgres.Sql;

/** Felet i larmjobbet: körningens rad i alert_runs (status ok) kan inte sparas. */
async function breakAlertJob(): Promise<void> {
  const org = e2e().organizationId;
  await sql.unsafe(`create schema if not exists e2e_fel`);
  await sql.unsafe(`
    create or replace function e2e_fel.alert_run() returns trigger language plpgsql as $$
    begin
      if new.status = 'ok' and new.organization_id = '${org}'::uuid then
        raise exception '${FAULT}';
      end if;
      return new;
    end $$`);
  await sql.unsafe(`drop trigger if exists e2e_fel_alert_run on public.alert_runs`);
  await sql.unsafe(`
    create trigger e2e_fel_alert_run before insert on public.alert_runs
    for each row execute function e2e_fel.alert_run()`);
}

/** Felet i importen: inga order kan sparas i den felande källan. */
async function breakImport(): Promise<void> {
  const source = e2e().failingSource.id;
  await sql.unsafe(`create schema if not exists e2e_fel`);
  await sql.unsafe(`
    create or replace function e2e_fel.order_insert() returns trigger language plpgsql as $$
    begin
      if new.data_source_id = '${source}'::uuid then
        raise exception 'E2E: framkallat fel när order sparas';
      end if;
      return new;
    end $$`);
  await sql.unsafe(`drop trigger if exists e2e_fel_order_insert on public.orders`);
  await sql.unsafe(`
    create trigger e2e_fel_order_insert before insert on public.orders
    for each row execute function e2e_fel.order_insert()`);
}

async function repairAll(): Promise<void> {
  await sql.unsafe(`drop trigger if exists e2e_fel_alert_run on public.alert_runs`);
  await sql.unsafe(`drop trigger if exists e2e_fel_order_insert on public.orders`);
  await sql.unsafe(`drop schema if exists e2e_fel cascade`);
}

interface JobResult {
  organizations: { organizationId: string; status: string; error?: string }[];
}

/** Kör larmjobbet som Vercel Cron gör. Ger organisationens utfall. */
async function runAlertJob(): Promise<{ status: string; error?: string }> {
  const secret = e2e().cronSecret;
  if (!secret) {
    throw new Error(
      "CRON_SECRET för servern under test saknas: sätt E2E_CRON_SECRET (lokalt: CRON_SECRET i kopians .env.local).",
    );
  }
  const res = await fetch(new URL("/api/cron/larm", e2e().baseUrl), {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (res.status === 401 || res.status === 503) {
    throw new Error(`Larmjobbet svarade ${res.status}: E2E_CRON_SECRET stämmer inte med servern.`);
  }
  const body = (await res.json()) as JobResult;
  const mine = body.organizations.find((o) => o.organizationId === e2e().organizationId);
  if (!mine) throw new Error("Larmjobbet körde inte seedens organisation.");
  return mine;
}

/** Larmets rad på Drift (öppen: "Sedan …", stängd: "Löst"). */
function alertRows(page: Page, title: RegExp) {
  return page.getByRole("listitem").filter({ has: page.getByText(title) });
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  await repairAll();
  browser = await launchBrowser();
});

afterAll(async () => {
  await repairAll().catch(() => {});
  await sql?.end();
  await browser?.close();
});

describe("felövervakning", () => {
  it("ett misslyckat larmjobb ger ett larm på Drift och i Att göra", async () => {
    await breakAlertJob();
    const outcome = await runAlertJob();
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("alert_runs");

    const { page, context, errors } = await openPage(browser, e2e().baseUrl);
    await login(page, e2e().users.owner);
    await page.goto("/drift");
    const open = alertRows(page, JOB_TITLE).filter({ hasText: /Sedan / });
    await open.first().waitFor();
    expect(await open.first().innerText()).toContain(FAULT);
    await open.first().getByText("Misslyckat schemalagt jobb").waitFor();
    await page.getByText("Senaste körningen av larmjobbet misslyckades.").waitFor();
    await open.first().scrollIntoViewIfNeeded();
    await screenshot(page, "06-felovervakning-drift");

    await page.goto("/att-gora");
    await page.getByText(JOB_TITLE).first().waitFor();
    await screenshot(page, "06-felovervakning-att-gora");
    expectNoPageErrors(errors);
    await context.close();
  });

  it("påfyllaren ser inte systemlarmet (375 px, mörkt)", async () => {
    const { page, context, errors } = await openPage(browser, e2e().baseUrl, {
      viewport: "mobile",
      theme: "dark",
    });
    await login(page, e2e().users.refiller);
    await page.goto("/drift");
    await page.getByRole("heading", { level: 1 }).waitFor();
    // Påfyllaren är kvar på Drift (inte omdirigerad) och ser driftens innehåll …
    expect(new URL(page.url()).pathname).toBe("/drift");
    await page
      .getByRole("link", { name: /Påfyllning/ })
      .first()
      .waitFor();
    // … men inte systemlarmet.
    expect(await page.getByText(JOB_TITLE).count()).toBe(0);
    await screenshot(page, "06-felovervakning-pafyllare-mork-375");
    await page.goto("/att-gora");
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(await page.getByText(JOB_TITLE).count()).toBe(0);
    expectNoPageErrors(errors);
    await context.close();
  });

  it("när jobbet lyckas igen stängs larmet", async () => {
    await repairAll();
    expect((await runAlertJob()).status).toBe("ok");

    const { page, context, errors } = await openPage(browser, e2e().baseUrl);
    await login(page, e2e().users.owner);
    await page.goto("/drift");
    await page.getByRole("heading", { level: 1 }).waitFor();
    // Inget öppet jobblarm, och Drift säger inte längre att senaste körningen misslyckades.
    expect(
      await alertRows(page, JOB_TITLE)
        .filter({ hasText: /Sedan / })
        .count(),
    ).toBe(0);
    expect(await page.getByText("Senaste körningen av larmjobbet misslyckades.").count()).toBe(0);
    await page.goto("/att-gora");
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(await page.getByText(JOB_TITLE).count()).toBe(0);
    expectNoPageErrors(errors);
    await context.close();
  });

  it("en import som misslyckas ger ett fel i Datakällor och ett larm på Drift", async () => {
    await breakImport();
    const { page, context, errors } = await openPage(browser, e2e().baseUrl, { theme: "light" });
    await login(page, e2e().users.owner);
    await page.goto("/datakallor#ladda-upp");
    await page.getByLabel("Datakälla").selectOption({ label: e2e().failingSource.name });
    await page.locator('input[type="file"]').setInputFiles(e2e().failingCsv.file);
    const confirm = page.getByRole("button", {
      name: `Importera ${e2e().failingCsv.rows} order`,
      exact: true,
    });
    await confirm.click();
    // Felet visas för ägaren, och importen loggas som misslyckad.
    await page.getByRole("alert").filter({ hasText: "Något gick fel" }).first().waitFor();
    await screenshot(page, "06-felovervakning-import-fel");

    await page.goto("/datakallor");
    await page.locator('text="Misslyckades" >> visible=true').first().waitFor();

    await until(async () => {
      await page.goto("/drift");
      return (
        (await alertRows(page, /^Import från E2E-felande import misslyckades/)
          .filter({ hasText: /Sedan / })
          .count()) > 0
      );
    }, "importlarmet på Drift");
    const row = alertRows(page, /^Import från E2E-felande import misslyckades/)
      .filter({ hasText: /Sedan / })
      .first();
    await row.scrollIntoViewIfNeeded();
    await screenshot(page, "06-felovervakning-import-drift");
    // Larmets länk leder till den misslyckade importen.
    await row.getByText("Underlag", { exact: true }).click();
    await row.getByRole("link", { name: /Öppna underlaget/ }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/datakallor/importer/"));
    await page.locator('text="Misslyckades" >> visible=true').first().waitFor();
    await repairAll();
    expectNoPageErrors(errors);
    await context.close();
  });
});
