/**
 * Rapportutskick: ägaren lägger till butikens mottagare, skapar butiksrapporten för oktober,
 * godkänner den (PDF skapas) och skickar. Mejlet hamnar i serverns lokala utkorg
 * (MAIL_PROVIDER=outbox) med rätt mottagare, ämne, hälsning och PDF som bilaga. Till sist
 * pausas mottagaren, så att mottagarlistan inte växer för varje körning.
 *
 * Först utan företagsuppgifter: Rapporter säger vad som saknas och länkar till Inställningar,
 * där momsregistreringsnumret föreslås från organisationsnumret. Sedan står vårt bolag,
 * momsen och beloppet att fakturera i förhandsvisningen, PDF:en och mejlet.
 *
 * Revisorns frågor: Rapporter varnar när rapporten inte säger vilket avtal som gäller och
 * länkar till butiken, där ägaren väljer "Muntligt avtal". Under Inställningar slås "Vi
 * säljer med vinstmarginalbeskattning (VMB)" på. Sedan står det muntliga avtalet med
 * villkoren, VMB-texten, det juridiska namnet med namnet verksamheten kallas, vem som äger
 * automaten och totalraden i förhandsvisningen, PDF:en och mejlet, och ingenstans att ingen
 * moms tas ut.
 *
 * Rapporten är den korta (standard): uträkningen och summor på en A4-sida, utan titlar,
 * snittköp och service, i förhandsvisningen, PDF:en och mejlet. Med butikens val "Visa
 * detaljer i rapporten" visar förhandsvisningen titlarna och service igen, medan den
 * redan skickade rapporten står kvar som den skickades.
 *
 * Äldre rapport (från före den korta rapporten, utan sparat val, förberedd i databasen med
 * E2E_DATABASE_URL): en godkänd rapport med en sparad PDF i den gamla mallen visas kort på
 * skärmen, PDF-knappen ger en ny kort PDF i stället för den sparade, den kan inte skickas,
 * och "Skapa ny version" ger en kort rapport som godkänns och får sin egen korta PDF.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { vmbStatement } from "@/reports/store-basis";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  until,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

const STORE = "Gallerian Väst (exempel)";
/** Det som bara visas med "Visa detaljer i rapporten". */
const DETAILS_ONLY = ["Snittköp", "Flest köp", "Titlar", "Service", "Påfyllningsbesök"];
const MONTH = "oktober 2026";
/** Butiken med den äldre rapporten (en annan än den som får utskicket). */
const OLD_STORE = "Spelbutiken Centrum (exempel)";
/** Våra företagsuppgifter (Inställningar → Företaget), som står i rapporten. */
const COMPANY = {
  name: "Binderlab E2E AB",
  orgNumber: "559000-1234",
  address: "Storgatan 1, 111 22 Stockholm",
  vatNumber: "SE559000123401",
};

let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: Error[];
let sql: ReturnType<typeof postgres>;
const run = Date.now().toString(36);
const recipient = { name: `Butikschef ${run}`, email: `butik-${run}@example.se` };
const greeting = `Tack för oktober! (${run})`;

interface OutboxMeta {
  to: string;
  subject: string;
  tags: Record<string, string>;
  attachments: { filename: string; contentType: string; size: number }[];
}

/** Mejlet till adressen i serverns utkorg, när det finns. */
async function findMail(to: string): Promise<{ dir: string; meta: OutboxMeta } | undefined> {
  let entries: string[];
  try {
    entries = await readdir(e2e().outboxDir);
  } catch {
    return undefined;
  }
  for (const entry of entries.sort().reverse()) {
    const dir = path.join(e2e().outboxDir, entry);
    try {
      const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as OutboxMeta;
      if (meta.to === to) return { dir, meta };
    } catch {
      // Mappen skrivs just nu, eller är inget mejl.
    }
  }
  return undefined;
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  browser = await launchBrowser();
  ({ page, context, errors } = await openPage(browser, e2e().baseUrl));
  await login(page, e2e().users.owner);
});

afterEach(() => expectNoPageErrors(errors));

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await sql?.end();
});

/** Antal sidor i en PDF från Chromium (sidobjekten). */
function pdfPages(bytes: Buffer): number {
  return bytes.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
}

/** Hämtar rapportens PDF med den inloggades session. */
async function downloadPdf(reportId: string): Promise<Buffer> {
  const res = await context.request.get(`/rapport/${reportId}/fil/pdf`, { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const bytes = Buffer.from(await res.body());
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  return bytes;
}

/** Butikens sida, fliken Kontakt och rapport (där brytaren står). */
async function openStoreReportSettings(): Promise<void> {
  await page.goto("/butiker");
  await page.getByRole("link", { name: STORE }).first().click();
  await page.waitForURL(/\/butiker\/[0-9a-f-]{36}/);
  await page.goto(`${new URL(page.url()).pathname}?vy=kontakt`);
}

/**
 * Väljer butiksrapporten för månaden i formuläret "Ny rapport". Efter klicket på Butik
 * byts formuläret ut (nytt `key` i page.tsx) och under bytet kan det gamla och det nya
 * finnas samtidigt en kort stund: vänta tills det bara finns ett fält Månad.
 */
async function chooseStoreReport(store = STORE): Promise<Locator> {
  const builder = page.locator('section[aria-labelledby="ny-rapport"]');
  await builder.getByRole("radio", { name: "Butik" }).check();
  await until(
    async () => (await builder.getByLabel("Månad").count()) === 1,
    "ett formulär för butiksrapporten",
  );
  await builder.getByLabel("Månad").selectOption({ label: MONTH });
  await until(
    async () => (await builder.getByLabel("Butik").count()) === 1,
    "ett fält för butiken",
  );
  await builder.getByLabel("Butik").selectOption({ label: store });
  // Sidan har räknat om för butiken (rubriken över formuläret).
  await page.getByText(`Butiksrapport, ${store}.`).first().waitFor();
  return builder;
}

describe("rapportutskick", () => {
  it("lägger till butikens mottagare", async () => {
    await page.goto("/rapporter?vy=mottagare");
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Lägg till", exact: true }) });
    await form.getByLabel("Typ").selectOption({ label: "Butik" });
    await form.getByLabel("Butik").selectOption({ label: STORE });
    await form.getByLabel("Namn").fill(recipient.name);
    await form.getByLabel("E-post").fill(recipient.email);
    await form.getByRole("button", { name: "Lägg till", exact: true }).click();
    await page.getByText(recipient.email).first().waitFor();
  });

  it("utan företagsuppgifter varnar Rapporter, och Inställningar föreslår momsregistreringsnumret", async () => {
    // Börja utan företagsuppgifter (också när testet körts förut mot samma databas).
    const org = e2e().organizationId;
    await sql`update public.organization_settings
              set company_name = null, org_number = null, company_address = null,
                  vat_number = null, report_vat_mode = 'added', report_vmb = false
              where organization_id = ${org}`;
    // Butikerna börjar utan vald avtalsform och med den korta rapporten (också efter en
    // körning som avbröts mitt i).
    await sql`update public.stores set agreement_form = null, report_details = false
              where organization_id = ${org}`;
    await sql`update public.bookkeeping_settings set org_number = null
              where organization_id = ${org}`;

    await page.goto("/rapporter");
    const builder = await chooseStoreReport();
    await builder.getByRole("button", { name: /^Skapa (utkast|ny version)$/ }).click();
    const warning = page.getByText("Rapporten saknar företagsnamn och organisationsnummer.");
    await warning.waitFor();
    await warning.scrollIntoViewIfNeeded();
    await screenshot(page, "05-rapport-saknar-foretagsuppgifter");
    // Godkännandet är inte låst, men varningen länkar till Inställningar.
    await page.getByRole("button", { name: "Godkänn för utskick" }).waitFor();
    await page.getByRole("link", { name: "Öppna Inställningar →" }).click();
    await page.waitForURL(/\/installningar#foretaget$/);

    const form = page.getByRole("form", { name: "Företaget" });
    await form.getByLabel("Företagsnamn").fill(COMPANY.name);
    await form.getByLabel("Adress").fill(COMPANY.address);
    // Förslaget kommer först när organisationsnumret är ifyllt, och fylls bara i på klick.
    expect(await form.getByRole("button", { name: /^Använd SE/ }).count()).toBe(0);
    await form.getByLabel("Organisationsnummer").fill(COMPANY.orgNumber);
    expect(await form.getByLabel("Momsregistreringsnummer").inputValue()).toBe("");
    await form.getByRole("button", { name: `Använd ${COMPANY.vatNumber}` }).click();
    expect(await form.getByLabel("Momsregistreringsnummer").inputValue()).toBe(COMPANY.vatNumber);
    expect(await form.getByLabel("Moms i butiksrapporten").inputValue()).toBe("added");
    await screenshot(page, "05-installningar-foretaget");
    await form.getByRole("button", { name: "Spara" }).click();
    await page.getByText("Företagsuppgifterna sparade").first().waitFor();

    // Utkastet från nyss stämmer inte längre: en ny version skapas (nästa test).
    await page.goto("/rapporter");
    await chooseStoreReport();
    await page.getByText("Rapporten har ändrats sedan utkastet skapades.").waitFor();
  });

  it("revisorns frågor: Rapporter varnar utan avtalsform, ägaren väljer Muntligt avtal och slår på VMB", async () => {
    await page.goto("/rapporter");
    const builder = await chooseStoreReport();
    await builder.getByRole("button", { name: /^Skapa (utkast|ny version)$/ }).click();
    // Den nya versionen visas (det förra utkastet saknade företagsuppgifterna).
    await until(
      async () => (await page.getByText(/^Rapporten saknar /).count()) === 0,
      "den nya versionen, med företagsuppgifterna",
    );
    // Företagsuppgifterna finns nu, men butiken har varken vald avtalsform eller kontrakt.
    const warning = page.getByText("Rapporten säger inte vilket avtal som gäller.");
    await warning.waitFor();
    await warning.scrollIntoViewIfNeeded();
    await screenshot(page, "05-rapport-saknar-avtalsform");
    // Godkännandet är inte låst, men varningen länkar till butiken.
    await page.getByRole("button", { name: "Godkänn för utskick" }).waitFor();
    await page.getByRole("link", { name: "Välj avtalsform →" }).click();
    await page.waitForURL(/\/butiker\/[0-9a-f-]{36}\?vy=kontakt#avtalsform$/);
    const form = page.getByLabel("Avtalsform i rapporten");
    await form.waitFor();
    expect(await form.inputValue()).toBe("");
    await page.getByText("Rapporten säger inte vilket avtal som gäller. Välj ett.").waitFor();
    await form.selectOption({ label: "Muntligt avtal" });
    await page.getByText("Klart! Muntligt avtal.").waitFor();
    await page
      .getByText("Rapporten säger att avtalet är muntligt och skriver villkoren.")
      .waitFor();
    await screenshot(page, "05-butik-avtalsform");
    // Valet står kvar när sidan laddas om.
    await page.reload();
    expect(await page.getByLabel("Avtalsform i rapporten").inputValue()).toBe("oral");

    // Inställningar → Företaget: bolaget säljer med vinstmarginalbeskattning.
    await page.goto("/installningar#foretaget");
    const company = page.getByRole("form", { name: "Företaget" });
    const vmb = company.getByRole("switch", {
      name: "Vi säljer med vinstmarginalbeskattning (VMB)",
    });
    expect(await vmb.getAttribute("aria-checked")).toBe("false");
    await company
      .getByText("Av: butiksrapporten säger bara att vi är säljare av varorna.")
      .waitFor();
    await vmb.click();
    expect(await vmb.getAttribute("aria-checked")).toBe("true");
    await screenshot(page, "05-installningar-vmb");
    await company.getByRole("button", { name: "Spara" }).click();
    await page.getByText("Företagsuppgifterna sparade").first().waitFor();
    await page.reload();
    expect(
      await page
        .getByRole("form", { name: "Företaget" })
        .getByRole("switch", { name: "Vi säljer med vinstmarginalbeskattning (VMB)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("skapar, godkänner och skickar butiksrapporten", async () => {
    await page.goto("/rapporter");
    const builder = await chooseStoreReport();
    await builder.getByLabel("Personlig hälsning").fill(greeting);
    // "Skapa ny version" när testet körts förut mot samma databas.
    await builder.getByRole("button", { name: /^Skapa (utkast|ny version)$/ }).click();

    // Godkännandet skapar PDF:en (headless Chromium på servern) och kan ta en stund.
    const approve = page.getByRole("button", { name: "Godkänn för utskick" });
    await approve.waitFor();
    // Förhandsvisningen är den korta rapporten: beloppet i rubriken och inga detaljer.
    const preview = page.locator('section[aria-labelledby="forhandsvisning"]');
    await preview.getByText("Underlag per titel finns på begäran.").waitFor();
    await preview
      .getByText(/^Er ersättning för oktober: /)
      .first()
      .waitFor();
    await preview.getByText("Så räknas ersättningen.").waitFor();
    for (const word of DETAILS_ONLY) expect(await preview.getByText(word).count(), word).toBe(0);
    // Underlaget för butikens bokföring: vilket bolag som betalar, och momsen.
    await preview.getByText("Ersättningen betalas av").waitFor();
    await preview.getByText(COMPANY.name).first().waitFor();
    await preview.getByText(`Org.nr ${COMPANY.orgNumber}`).waitFor();
    await preview.getByText(`Momsreg.nr ${COMPANY.vatNumber}`).waitFor();
    await preview.getByText("Att fakturera").waitFor();
    await preview.getByText("Moms 25 %").waitFor();
    expect(await page.getByText(/^Rapporten saknar /).count()).toBe(0);
    // Revisorns frågor: det juridiska namnet och namnet verksamheten kallas, vem som äger
    // automaten, det muntliga avtalet med villkoren, VMB och totalraden.
    await preview.getByText("(verksamheten kallas Binderlab)").waitFor();
    await preview.getByText(/Äger och driver automate(n|rna)\./).waitFor();
    await preview
      .getByText(
        /Muntligt avtal mellan Binderlab E2E AB och Gallerian Väst \(exempel\): hyra 1\s500\skr per månad\./,
      )
      .waitFor();
    await preview
      .getByText(
        /enligt reglerna om vinstmarginalbeskattning \(VMB\)\. Den momsen berör inte butiken\./,
      )
      .waitFor();
    await preview.getByText("Er ersättning totalt, exklusive moms").waitFor();
    expect(await preview.getByText(/ingen moms tas ut/i).count()).toBe(0);
    expect(await page.getByText("Rapporten säger inte vilket avtal som gäller.").count()).toBe(0);
    await screenshot(page, "05-rapport-utkast");
    await approve.click();
    await page.getByText("Rapporten är godkänd").first().waitFor({ timeout: 120_000 });

    // Bara den här körningens mottagare (tidigare körningar kan ha lagt till fler).
    const group = page.getByRole("group", { name: "Skicka till" });
    await group.getByRole("checkbox", { name: new RegExp(recipient.email) }).waitFor();
    const boxes = group.getByRole("checkbox");
    for (let i = 0; i < (await boxes.count()); i += 1) {
      const box = boxes.nth(i);
      const label = await page.locator(`label[for="${await box.getAttribute("id")}"]`).innerText();
      if (label.includes(recipient.email)) await box.check();
      else await box.uncheck();
    }
    const send = page.getByRole("button", { name: "Skicka till 1 mottagare" });
    await send.click();
    await page.getByText("Rapport skickad").first().waitFor({ timeout: 120_000 });
    await page.getByText("Har fått den").first().waitFor();
    await screenshot(page, "05-rapport-skickad");
  });

  it("mejlet ligger i utkorgen med PDF och hälsningen", async () => {
    const mail = await until(() => findMail(recipient.email), `mejl till ${recipient.email}`);
    expect(mail.meta.subject).toBe(`Butiksrapport ${MONTH} · ${STORE}`);
    expect(mail.meta.tags.report_id).toMatch(/^[0-9a-f-]{36}$/);
    const pdf = mail.meta.attachments.find((a) => a.contentType === "application/pdf");
    expect(pdf?.size).toBeGreaterThan(1_000);
    const pdfBytes = await readFile(path.join(mail.dir, pdf!.filename));
    expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
    // Den korta rapporten får plats på en A4-sida.
    expect(pdfBytes.toString("latin1").match(/\/Type\s*\/Page\b(?!s)/g)).toHaveLength(1);
    const html = await readFile(path.join(mail.dir, "message.html"), "utf8");
    expect(html).toContain(greeting);
    // Mejlet: beloppet i rubriken, ingen service och inga titlar.
    const text = await readFile(path.join(mail.dir, "message.txt"), "utf8");
    expect(text).toMatch(/Er ersättning för oktober: /);
    // Mejlet har samma underlag för bokföringen som PDF:en.
    for (const body of [html, text]) {
      const b = body.replace(/\u00a0|&nbsp;/g, " ");
      expect(b).toMatch(/underlag för bokföringen/i);
      for (const word of [
        COMPANY.name,
        `Org.nr ${COMPANY.orgNumber}`,
        COMPANY.address,
        `Momsreg.nr ${COMPANY.vatNumber}`,
        "Ersättning exkl. moms",
        "Moms 25 %",
        "Att fakturera",
        "Binderlab E2E AB (verksamheten kallas Binderlab)",
        "Äger och driver automate",
        "Muntligt avtal mellan Binderlab E2E AB och Gallerian Väst (exempel): hyra 1 500 kr per månad.",
        vmbStatement(COMPANY.name),
      ])
        expect(b, word).toContain(word);
      // Inget påstående om att ingen moms tas ut, och skatteregelns namn står bara i den fasta
      // texten: utan den finns varken "vinst" eller "marginal" i mejlet (butiken har hyra).
      expect(b).not.toMatch(/ingen moms/i);
      expect(b.split(vmbStatement(COMPANY.name)).join(" ")).not.toMatch(/vinst|marginal/i);
    }
    for (const word of ["Flest köp", "Påfyllningar", "Snittköp", "Drift och service"]) {
      expect(html, word).not.toContain(word);
      expect(text, word).not.toContain(word);
    }
    const eml = await readFile(path.join(mail.dir, "message.eml"), "utf8");
    expect(eml).toMatch(new RegExp(`^To: .*${recipient.email.replace(/\./g, "\\.")}`, "m"));
  });

  it("med Visa detaljer i rapporten visar förhandsvisningen titlar och service igen", async () => {
    // Brytaren står på butikens sida, under Kontakt och rapport.
    await openStoreReportSettings();
    const toggle = page.getByRole("switch", { name: `Visa detaljer i rapporten, ${STORE}` });
    await page.getByText("Titlar och service. Av: butiken får bara uträkningen.").waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    await toggle.click();
    await page.getByText("Klart! Rapporten visar detaljer.").waitFor();
    await screenshot(page, "05-butik-visa-detaljer");

    await page.goto("/rapporter");
    await chooseStoreReport();
    const preview = page.locator('section[aria-labelledby="forhandsvisning"]');
    await preview.getByText("Påfyllningsbesök").first().waitFor();
    await preview.getByText("Snittköp").first().waitFor();
    await preview.getByText("Flest köp").first().waitFor();
    expect(await preview.getByText("Underlag per titel finns på begäran.").count()).toBe(0);
    // Den skickade rapporten ändras inte: den står kvar som skickad, utan ny version.
    await page.getByText("Rapporten är skickad.").first().waitFor();
    await screenshot(page, "05-rapport-med-detaljer");

    // Tillbaka till standard, så att nästa körning börjar likadant.
    await openStoreReportSettings();
    await toggle.click();
    await page.getByText("Klart! Rapporten visar bara uträkningen.").waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("mottagaren pausas efteråt", async () => {
    await page.goto("/rapporter?vy=mottagare");
    const row = page.getByRole("listitem").filter({ hasText: recipient.email });
    await row.getByRole("button", { name: "Pausa", exact: true }).click();
    await row.getByText("Pausad", { exact: true }).waitFor();
  });
});

describe("äldre butiksrapport (gamla mallen)", () => {
  let storeId: string;
  let oldId: string;

  const latestReport = async (): Promise<{ id: string; details: boolean | null } | undefined> => {
    const [row] = await sql<{ id: string; details: boolean | null }[]>`
      select id, (data_snapshot -> 'report' ->> 'details')::boolean as details
      from public.reports
      where store_id = ${storeId} and period_start = '2026-10-01' and period_end = '2026-10-31'
      order by generated_at desc, id desc limit 1`;
    return row;
  };

  it("förbereder en godkänd rapport från förr, med en sparad PDF i den gamla mallen", async () => {
    const [store] = await sql<{ id: string }[]>`
      select id from public.stores
      where organization_id = ${e2e().organizationId} and name = ${OLD_STORE}`;
    storeId = store!.id;
    // Rapporten som den såg ut förut: med titlar och service.
    await sql`update public.stores set report_details = true where id = ${storeId}`;
    const before = (await latestReport())?.id;
    await page.goto("/rapporter");
    const builder = await chooseStoreReport(OLD_STORE);
    await builder.getByRole("button", { name: /^Skapa (utkast|ny version)$/ }).click();
    const created = await until(async () => {
      const row = await latestReport();
      return row && row.id !== before ? row : undefined;
    }, "den nya rapporten i databasen");
    expect(created.details).toBe(true);
    oldId = created.id;
    // PDF:en sparas vid första hämtningen: gamla mallen, mer än en sida.
    const oldPdf = await downloadPdf(oldId);
    expect(pdfPages(oldPdf)).toBeGreaterThan(1);
    // Från före valet fanns: inget sparat val, godkänd, inte skickad. Brytaren av (standard).
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.reports set data_snapshot = data_snapshot #- '{report,details}'
               where id = ${oldId}`;
    });
    await sql`insert into public.report_approvals (organization_id, report_id)
              values (${e2e().organizationId}, ${oldId})`;
    await sql`update public.stores set report_details = false where id = ${storeId}`;
    const [files] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.report_files where report_id = ${oldId}`;
    expect(files!.n).toBe(1);
    expect((await latestReport())?.details).toBeNull();
  });

  it("visas kort på skärmen, och PDF-knappen ger en ny kort PDF, inte den sparade", async () => {
    await page.goto(`/rapport/${oldId}`);
    const report = page.locator("main");
    await report.getByText("Underlag per titel finns på begäran.").waitFor();
    await report
      .getByText(/^Er ersättning för oktober: /)
      .first()
      .waitFor();
    for (const word of DETAILS_ONLY) expect(await report.getByText(word).count(), word).toBe(0);
    await page.getByText("Godkänd", { exact: true }).first().waitFor();
    await screenshot(page, "05-aldre-rapport-kort");
    expect(pdfPages(await downloadPdf(oldId))).toBe(1);
    // Ingenting har skrivits över: en hämtning till ger samma korta rapport.
    expect(pdfPages(await downloadPdf(oldId))).toBe(1);
  });

  it("kan inte skickas: Rapporter ber om en ny version, som blir kort", async () => {
    await page.goto("/rapporter");
    const builder = await chooseStoreReport(OLD_STORE);
    await page.getByText("Rapporten har den gamla mallen.").first().waitFor();
    await page.getByText("Skapa ny version ovan. Den blir kort.").first().waitFor();
    expect(await page.getByRole("group", { name: "Skicka till" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Godkänn för utskick" }).count()).toBe(0);
    await screenshot(page, "05-aldre-rapport-ny-version");

    await builder.getByRole("button", { name: "Skapa ny version", exact: true }).click();
    const approve = page.getByRole("button", { name: "Godkänn för utskick" });
    await approve.waitFor();
    const next = await until(async () => {
      const row = await latestReport();
      return row && row.id !== oldId ? row : undefined;
    }, "den nya versionen i databasen");
    expect(next.details).toBe(false);
    await approve.click();
    await page.getByText("Rapporten är godkänd").first().waitFor({ timeout: 120_000 });
    await page.getByText("Godkänd, redo att skicka.").first().waitFor();
    // Godkännandet sparade den nya rapportens PDF: en sida, och den äldre är orörd.
    const [files] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.report_files where report_id = ${next.id}`;
    expect(files!.n).toBe(1);
    expect(pdfPages(await downloadPdf(next.id))).toBe(1);
    await page.goto(`/rapport/${next.id}`);
    await page.locator("main").getByText("Underlag per titel finns på begäran.").waitFor();
    for (const word of DETAILS_ONLY) {
      expect(await page.locator("main").getByText(word).count(), word).toBe(0);
    }
    const [sent] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.report_deliveries where report_id = ${oldId}`;
    expect(sent!.n).toBe(0);
  });
});
