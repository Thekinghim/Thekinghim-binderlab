/**
 * Styr automaten via Awishs gRPC-API (v1.2.41) mot en låtsas-Awish, aldrig riktiga Awish.
 * Körs bara med E2E_FAKE_GRPC_PORT: servern under test startas med
 * AWISH_GRPC_ADDRESS=127.0.0.1:<port> och AWISH_CONTROL_ENDPOINT=plain, och testet startar
 * låtsas-Awish (gRPC) på den porten.
 *
 * 1. Ägaren (1440 px) öppnar Styr automaten för en ny automat. Starta om: arket läser
 *    förhandsvisningen från servern, Starta om skickar, och en andra omstart inom tio
 *    minuter stoppas med en svensk text i arket.
 * 2. Strömschema: tiderna är förifyllda från butiken (10:00–20:00). Ett schema som stänger av
 *    automaten nu (bara en annan veckodag vald) kräver att koden skrivs; knappen är spärrad
 *    tills dess. Låtsas-Awish får HH:MM:00 och veckodagarna.
 * 3. Telefon (390 px): ingen sidledes scroll, veckodagarna och Starta om är minst 44 px.
 * 4. Skärmbilder (1440 och 390) av Styr automaten, Kategorier, Medlemmar och Awish-kontot
 *    till E2E_SCREENSHOT_DIR (styr-*.png).
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFakeAwish } from "@/server/awish/testing/fake-server";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  until,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

const PORT = Number(process.env.E2E_FAKE_GRPC_PORT ?? "");
const enabled = Number.isInteger(PORT) && PORT > 0;
const AWISH_MACHINE = "2001";

let browser: Browser;
let sql: postgres.Sql;
let fake: Awaited<ReturnType<typeof startFakeAwish>> | null = null;
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];
let machine: { id: string; code: string };
let sourceId: string;
let storeId: string;

async function page(viewport: { width: number; height: number }, mobile = false): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, {
    theme: "light",
    viewport: mobile ? "mobile" : "desktop",
  });
  await (
    opened.page as unknown as {
      setViewportSize(v: { width: number; height: number }): Promise<void>;
    }
  ).setViewportSize(viewport);
  contexts.push(opened.context);
  errors.push(opened.errors);
  return opened.page;
}

async function shot(p: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOT_DIR ?? ".data/e2e";
  await (
    p as unknown as {
      screenshot(o: { path: string; fullPage: boolean; caret: string }): Promise<unknown>;
    }
  ).screenshot({ path: `${dir}/${name}.png`, fullPage: true, caret: "initial" });
}

async function asOwner<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const [owner] = await sql<{ id: string }[]>`
    select id from auth.users where email = ${e2e().users.owner}`;
  return (await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: owner!.id,
      email: e2e().users.owner,
      role: "authenticated",
    })}, true), set_config('role', 'authenticated', true)`;
    return fn(tx);
  })) as T;
}

async function noSideScroll(p: Page): Promise<void> {
  const over = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(1);
}

/** Den lägsta höjden bland elementen (px). */
async function height(p: Page, selector: string): Promise<number> {
  return p.evaluate(
    (sel: string) =>
      Math.min(
        ...Array.from(document.querySelectorAll(sel)).map((e) => e.getBoundingClientRect().height),
      ),
    selector,
  );
}

/** Veckodagen i dag i Stockholm, 0 = måndag. */
function todayIndex(): number {
  const name = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    weekday: "short",
  }).format(new Date());
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name);
}

const DAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];

beforeAll(async () => {
  if (!enabled) return;
  browser = await launchBrowser();
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1 });
  const org = e2e().organizationId;
  const suffix = String(Date.now()).slice(-5);
  fake = await startFakeAwish(
    {
      appId: "app",
      appSecret: "secret",
      appKey: "key",
      machines: [{ id: AWISH_MACHINE, name: "Styr e2e", machine_no: "M2001" }],
      products: {
        [AWISH_MACHINE]: [
          {
            id: "71",
            channel: "A1",
            good: "Surging Sparks",
            current: 3,
            capacity: 10,
            addr: "1",
            motor_id: "11",
          },
          {
            id: "72",
            channel: "A2",
            good: null,
            current: 0,
            capacity: 8,
            addr: "1",
            motor_id: "12",
          },
        ],
      },
      categories: [
        { id: "1", title: "Pokémon", priority: 1, is_visible: true },
        { id: "2", title: "Mystery", priority: 2, is_visible: true },
      ],
      members: [
        {
          id: "501",
          name: "Anna Andersson",
          tel: "0701234567",
          email: "anna.andersson@exempel.se",
          member_no: "M-1001",
          status: 1,
          level_id: 1,
          principal_balance: "0.00",
          registered_at: "2026-11-01 10:00:00",
        },
        {
          id: "502",
          name: "Bertil Berg",
          tel: "0739876543",
          email: "bertil@exempel.se",
          member_no: "M-1002",
          status: 1,
          level_id: 1,
          principal_balance: "25.00",
          registered_at: "2026-11-12 18:30:00",
        },
      ],
      // Awish skickar hela numret: Binderlab ska ändå visa det maskerat.
      unmaskedMembers: true,
    },
    { port: PORT },
  );

  const [m] = await sql<{ id: string; code: string }[]>`
    insert into public.machines (organization_id, code, name, active_from)
    values (${org}::uuid, ${`ST-${suffix}`}, 'Styr e2e', '2026-10-01')
    returning id, code`;
  machine = m!;
  const [st] = await sql<{ id: string }[]>`
    insert into public.stores (organization_id, name, power_on_time, power_off_time)
    values (${org}::uuid, ${`Styrbutiken ${suffix}`}, '10:00', '20:00')
    returning id`;
  storeId = st!.id;
  await sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
    values (${org}::uuid, ${machine.id}::uuid, ${storeId}::uuid, '2026-10-01')`;
  sourceId = await asOwner(async (tx) => {
    const [found] = await tx<{ id: string }[]>`
      select id from public.data_sources
      where organization_id = ${org}::uuid and provider = 'awish_grpc' and archived_at is null
      limit 1`;
    const id =
      found?.id ??
      (
        await tx<{ id: string }[]>`
          insert into public.data_sources (organization_id, provider, name, source_timezone)
          values (${org}::uuid, 'awish_grpc', 'Awish API (styr e2e)', 'Europe/Stockholm')
          returning id`
      )[0]!.id;
    await tx`select public.awish_save_credentials(${org}::uuid, ${id}::uuid, 'app', 'secret', 'key')`;
    return id;
  });
  await sql`
    insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
    values (${org}::uuid, ${sourceId}::uuid, ${AWISH_MACHINE}, 'Styr e2e', ${machine.id}::uuid)
    on conflict (organization_id, data_source_id, external_id)
    do update set machine_id = ${machine.id}::uuid`;
});

afterAll(async () => {
  if (!enabled) return;
  for (const c of contexts) await c.close();
  await browser?.close();
  await fake?.stop();
  // Lämna aldrig en Awish-koppling kvar i e2e-databasen (källan först: andra testfiler
  // läser Awish bara när en aktiv källa finns).
  await sql`update public.data_sources set archived_at = now() where id = ${sourceId}::uuid`;
  await sql`update public.machines set archived_at = now() where id = ${machine.id}::uuid`;
  await sql?.end();
});

describe.skipIf(!enabled)("Styr automaten mot låtsas-Awish", () => {
  it("Starta om: förhandsvisning från servern, skickas en gång, andra stoppas", async () => {
    const p = await page({ width: 1440, height: 900 });
    await login(p, e2e().users.owner);
    await p.goto(`/automater/${machine.code.toLowerCase()}/styr`);
    await p.getByRole("button", { name: "Starta om automaten" }).waitFor();
    await shot(p, "styr-1-sidan-1440");

    await p.getByRole("button", { name: "Starta om automaten" }).click();
    await p.getByText(`${machine.code} startar om.`).waitFor();
    await shot(p, "styr-2-starta-om-ark-1440");
    await p.getByRole("button", { name: "Starta om", exact: true }).click();
    await p.getByText(`Skickat. ${machine.code} startar om inom ett par minuter.`).waitFor();
    expect(fake!.state.powerCommands).toEqual([{ machine_id: AWISH_MACHINE, method: "REBOOT" }]);

    // Andra omstarten inom tio minuter: spärren svarar på svenska och inget skickas.
    await p.getByRole("button", { name: "Starta om automaten" }).click();
    await p.getByText(`${machine.code} startar om.`).waitFor();
    await p.getByRole("button", { name: "Starta om", exact: true }).click();
    await p.getByText("Automaten startades om nyss. Vänta tio minuter.").waitFor();
    expect(fake!.state.powerCommands).toHaveLength(1);
    await p.getByRole("button", { name: "Avbryt" }).click();

    // Signaturen gick fram (båda fältnumren) och loggen har raden.
    const write = fake!.state.calls.find((c) => c.method === "ControlPower");
    expect(String(write?.request.sign)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(write?.request.doc_sign)).toBe(String(write?.request.sign));
    const [row] = await sql<{ status: string }[]>`
      select status from public.awish_actions
      where machine_id = ${machine.id}::uuid and kind = 'reboot' and status <> 'blocked'`;
    expect(row?.status).toBe("ok");
    expectNoPageErrors(errors.at(-1)!);
  });

  it("strömschema: förifyllt från butiken; stänger det av nu krävs koden", async () => {
    const p = await page({ width: 1440, height: 900 });
    await login(p, e2e().users.owner);
    await p.goto(`/automater/${machine.code.toLowerCase()}/styr`);
    const on = p.getByLabel("På", { exact: true });
    await on.waitFor();
    expect(await on.inputValue()).toBe("10:00");
    expect(await p.getByLabel("Av", { exact: true }).inputValue()).toBe("20:00");

    // Bara en annan dag än i dag: automaten är av enligt schemat nu.
    const today = todayIndex();
    const other = (today + 3) % 7;
    for (let i = 0; i < 7; i += 1) {
      if (i !== other) await p.getByRole("button", { name: DAYS[i]!, exact: true }).click();
    }
    await p.getByRole("button", { name: "Skicka schema" }).click();
    await p.getByText(/stängs automaten av nu eller inom 15 minuter/).waitFor();
    const confirm = p.getByRole("button", { name: "Skicka schema" }).last();
    expect(await confirm.getAttribute("disabled")).not.toBeNull();
    await p.getByLabel(`Skriv ${machine.code} för att skicka schemat.`).fill(machine.code);
    await shot(p, "styr-3-schema-kod-1440");
    await confirm.click();
    await p.getByText(/^Skickat\. Awish slår på 10:00 och av 20:00/).waitFor();
    const weekdays = [0, 0, 0, 0, 0, 0, 0];
    weekdays[other] = 1;
    expect(fake!.state.powerSchedules[AWISH_MACHINE]).toEqual({
      power_on: "10:00:00",
      power_off: "20:00:00",
      weekdays,
    });
    expectNoPageErrors(errors.at(-1)!);
  });

  it("telefon: ingen sidledes scroll, tryckytor minst 44 px", async () => {
    const p = await page({ width: 390, height: 844 }, true);
    await login(p, e2e().users.owner);
    await p.goto(`/automater/${machine.code.toLowerCase()}/styr`);
    await p.getByRole("button", { name: "Starta om automaten" }).waitFor();
    await noSideScroll(p);
    expect(await height(p, ".styr-days button")).toBeGreaterThanOrEqual(44);
    expect(await height(p, "#starta-om button")).toBeGreaterThanOrEqual(44);
    await shot(p, "styr-4-sidan-390");
    await p.getByRole("button", { name: "Mer" }).click();
    await p.getByRole("button", { name: "Stäng av…" }).click();
    await p.getByText(`Skriv ${machine.code} för att stänga av.`).waitFor();
    await shot(p, "styr-5-stang-av-ark-390");
    await p.getByRole("button", { name: "Avbryt" }).click();
    expect(fake!.state.powerCommands.filter((c) => c.method === "SHUTDOWN")).toEqual([]);
  });

  it("skärmbilder: kategorier, medlemmar och Awish-kontot (1440 och 390)", async () => {
    for (const [w, h, mobile] of [
      [1440, 900, false],
      [390, 844, true],
    ] as const) {
      const p = await page({ width: w, height: h }, mobile);
      await login(p, e2e().users.owner);
      await p.goto("/inkopspriser/kategorier");
      await p
        .getByRole("button", { name: /Ny kategori/ })
        .first()
        .waitFor();
      await until(
        async () => (await p.evaluate(() => document.body.innerText)).includes("Mystery"),
        "kategorierna från Awish syns",
      );
      await noSideScroll(p);
      await shot(p, `styr-6-kategorier-${w}`);
      await p.goto("/installningar/medlemmar");
      await until(
        async () => (await p.evaluate(() => document.body.innerText)).includes("Anna Andersson"),
        "medlemmarna syns",
      );
      const body = await p.evaluate(() => document.body.innerText);
      expect(body).not.toContain("0701234567");
      expect(body).not.toContain("anna.andersson@exempel.se");
      await noSideScroll(p);
      await shot(p, `styr-7-medlemmar-${w}`);
      await p.goto("/installningar/awish");
      await until(
        async () => (await p.evaluate(() => document.body.innerText)).includes("Europe/Stockholm"),
        "Awish-kontot syns",
      );
      await noSideScroll(p);
      await shot(p, `styr-8-awish-kontot-${w}`);
      await p.goto("/inkopspriser/ny-produkt");
      await p.waitForLoadState("networkidle");
      await shot(p, `styr-9-varor-${w}`);
    }
  });
});
