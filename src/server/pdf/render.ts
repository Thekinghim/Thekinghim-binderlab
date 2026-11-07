/**
 * PDF på servern: en headless Chromium öppnar rapportens utskriftsroute (/rapport/[id])
 * med den inloggades cookies och skriver ut den som A4. Samma sida som användaren ser,
 * så PDF:en följer designsystemets utskriftsläge (src/components/report) exakt.
 *
 * Två sätt att starta Chromium, valda med `PDF_RENDERER`:
 * - `local` (standard utanför Vercel): puppeteer-core med en lokalt installerad Chromium
 *   (`PDF_CHROMIUM_PATH`, annars Playwrights i /opt/pw-browsers eller
 *   PLAYWRIGHT_BROWSERS_PATH).
 * - `sparticuz` (standard på Vercel): puppeteer-core med @sparticuz/chromium, som packar
 *   upp en Chromium byggd för serverlösa funktioner.
 * - `off`: PDF skapas inte; UI:t visar det och utskrift via webbläsaren fungerar ändå.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import type { Browser, Page } from "puppeteer-core";

export type PdfRendererKind = "local" | "sparticuz" | "off";

export interface PdfCookie {
  readonly name: string;
  readonly value: string;
}

export interface PdfRequest {
  /** Absolut adress till utskriftsrouten. */
  readonly url: string;
  /** Cookies som skickas med (den inloggades session, så att RLS gäller). */
  readonly cookies: readonly PdfCookie[];
  /** Standard 120 s (första kompileringen i utveckling är långsam). */
  readonly timeoutMs?: number;
}

export interface PdfRenderer {
  readonly kind: PdfRendererKind;
  /** Skriver ut sidan som A4-PDF. */
  render(request: PdfRequest): Promise<Uint8Array>;
  /**
   * Öppnar sidan och läser ett JSON-värde som sidan lägger i `window[globalName]`
   * (används för att rendera e-post med mallen i src/emails, som bara kan köras utanför
   * Server Components).
   */
  extract<T>(request: PdfRequest, globalName: string): Promise<T>;
  /** Skriver ut fristående HTML (utan nätverk, t.ex. bokföringens sammanfattning) som A4-PDF. */
  renderHtml(html: string): Promise<Uint8Array>;
}

export class PdfError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export interface PdfStatus {
  readonly kind: PdfRendererKind;
  readonly configured: boolean;
  readonly missing: readonly string[];
  /** Chromium som används (lokalt). */
  readonly executable: string | null;
}

/** Playwrights Chromium i /opt/pw-browsers (eller PLAYWRIGHT_BROWSERS_PATH), om den finns. */
export function findLocalChromium(env: Env = process.env): string | null {
  const explicit = env.PDF_CHROMIUM_PATH?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH?.trim(), "/opt/pw-browsers"].filter(
    (r): r is string => Boolean(r),
  );
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const candidates = [
      ...entries
        .filter((e) => /^chromium_headless_shell-\d+$/.test(e))
        .map((e) => path.join(root, e, "chrome-headless-shell-linux64", "chrome-headless-shell")),
      ...entries
        .filter((e) => /^chromium-\d+$/.test(e))
        .map((e) => path.join(root, e, "chrome-linux64", "chrome")),
    ].sort((a, b) => (a < b ? 1 : -1));
    const hit = candidates.find((c) => existsSync(c));
    if (hit) return hit;
  }
  return null;
}

function kindOf(env: Env): PdfRendererKind {
  const v = (env.PDF_RENDERER ?? "").trim().toLowerCase();
  if (v === "local" || v === "sparticuz" || v === "off") return v;
  if (v !== "") throw new PdfError(`PDF_RENDERER måste vara local, sparticuz eller off.`);
  return env.VERCEL ? "sparticuz" : "local";
}

/** Vilket sätt som gäller och om det går att använda. Kastar aldrig. */
export function pdfStatus(env: Env = process.env): PdfStatus {
  let kind: PdfRendererKind;
  try {
    kind = kindOf(env);
  } catch {
    return {
      kind: "off",
      configured: false,
      missing: ["PDF_RENDERER har ett okänt värde"],
      executable: null,
    };
  }
  if (kind === "off") {
    return { kind, configured: false, missing: ["PDF_RENDERER=off"], executable: null };
  }
  if (kind === "sparticuz") return { kind, configured: true, missing: [], executable: null };
  const executable = findLocalChromium(env);
  return executable
    ? { kind, configured: true, missing: [], executable }
    : {
        kind,
        configured: false,
        missing: ["Chromium hittades inte (sätt PDF_CHROMIUM_PATH)"],
        executable: null,
      };
}

type Launch = () => Promise<Browser>;

/**
 * Alla fel från Chromium (start, sida, utskrift) blir PdfError, så att anroparna kan falla
 * tillbaka på HTML i webbläsaren i stället för att svara 500. Orsaken följer med (cause).
 */
async function asPdfError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PdfError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfError(`PDF kunde inte skapas: ${reason.slice(0, 200)}`, { cause: error });
  }
}

async function withPage<T>(
  launch: Launch,
  request: PdfRequest,
  fn: (page: Page, timeout: number) => Promise<T>,
  media?: "print",
): Promise<T> {
  const url = new URL(request.url);
  const timeout = request.timeoutMs ?? 120_000;
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    // Utskriftsläget från början, så att sidindelningen mäts som den skrivs ut.
    if (media) await page.emulateMediaType(media);
    if (request.cookies.length > 0) {
      await browser.setCookie(
        ...request.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: url.hostname,
          path: "/",
          httpOnly: true,
          secure: url.protocol === "https:",
          sameSite: "Lax" as const,
        })),
      );
    }
    const response = await page.goto(url.toString(), { waitUntil: "networkidle0", timeout });
    if (!response || !response.ok()) {
      throw new PdfError(
        `Rapportsidan svarade ${response ? response.status() : "inte"} (${url.pathname}).`,
      );
    }
    if (new URL(page.url()).pathname !== url.pathname) {
      throw new PdfError("Rapportsidan skickade vidare (inloggningen följde inte med).");
    }
    return await fn(page, timeout);
  } finally {
    await browser.close();
  }
}

async function printPdf(launch: Launch, request: PdfRequest): Promise<Uint8Array> {
  return withPage(
    launch,
    request,
    async (page, timeout) => {
      await page.waitForSelector(".bl-report", { timeout });
      await page.evaluate(() => document.fonts.ready);
      // Rapporten delar själv innehåll som inte får plats på ett ark på nya ark
      // (src/components/report/report-document.tsx) och sätter data-paginated när den är klar.
      // Blir den aldrig klar (skriptet körs inte) skrivs serverns HTML ut ändå, ett ark per
      // sida som förut, hellre än ingen PDF alls.
      await page
        .waitForFunction(
          () =>
            Array.from(document.querySelectorAll(".bl-report")).every((r) =>
              r.hasAttribute("data-paginated"),
            ),
          { timeout },
        )
        .catch(() => undefined);
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      });
      return new Uint8Array(pdf);
    },
    "print",
  );
}

async function extractJson<T>(launch: Launch, request: PdfRequest, globalName: string): Promise<T> {
  if (!/^[A-Za-z_$][\w$]*$/.test(globalName)) throw new PdfError("Ogiltigt namn.");
  return withPage(launch, request, async (page, timeout) => {
    await page.waitForFunction(
      (name: string) => (window as unknown as Record<string, unknown>)[name] !== undefined,
      { timeout },
      globalName,
    );
    const json = await page.evaluate(
      (name: string) => JSON.stringify((window as unknown as Record<string, unknown>)[name]),
      globalName,
    );
    return JSON.parse(json) as T;
  });
}

async function printHtml(launch: Launch, html: string): Promise<Uint8Array> {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    // Sammanfattningen behöver inget skript; organisationens och butikernas namn är data.
    await page.setJavaScriptEnabled(false);
    // Ingen extern resurs: allt finns i dokumentet.
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().startsWith("data:") ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMediaType("print");
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}

/** Lokal Chromium (utveckling och tester). */
export class LocalPdfRenderer implements PdfRenderer {
  readonly kind = "local" as const;
  constructor(private readonly executablePath: string) {}

  private readonly launch: Launch = async () => {
    const puppeteer = (await import("puppeteer-core")).default;
    return puppeteer.launch({
      executablePath: this.executablePath,
      headless: true,
      args: [
        "--no-proxy-server",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--font-render-hinting=none",
      ],
    });
  };

  render(request: PdfRequest): Promise<Uint8Array> {
    return asPdfError(() => printPdf(this.launch, request));
  }

  extract<T>(request: PdfRequest, globalName: string): Promise<T> {
    return asPdfError(() => extractJson<T>(this.launch, request, globalName));
  }

  renderHtml(html: string): Promise<Uint8Array> {
    return asPdfError(() => printHtml(this.launch, html));
  }
}

/** @sparticuz/chromium (Vercel och andra serverlösa miljöer). */
export class SparticuzPdfRenderer implements PdfRenderer {
  readonly kind = "sparticuz" as const;

  private readonly launch: Launch = async () => {
    const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
      import("puppeteer-core"),
      import("@sparticuz/chromium"),
    ]);
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  };

  render(request: PdfRequest): Promise<Uint8Array> {
    return asPdfError(() => printPdf(this.launch, request));
  }

  extract<T>(request: PdfRequest, globalName: string): Promise<T> {
    return asPdfError(() => extractJson<T>(this.launch, request, globalName));
  }

  renderHtml(html: string): Promise<Uint8Array> {
    return asPdfError(() => printHtml(this.launch, html));
  }
}

/** PDF-adaptern enligt miljön. Kastar `PdfError` när PDF inte går att skapa här. */
export function getPdfRenderer(env: Env = process.env): PdfRenderer {
  const status = pdfStatus(env);
  if (!status.configured) {
    throw new PdfError(`PDF kan inte skapas: ${status.missing.join(", ")}.`);
  }
  return status.kind === "sparticuz"
    ? new SparticuzPdfRenderer()
    : new LocalPdfRenderer(status.executable!);
}
