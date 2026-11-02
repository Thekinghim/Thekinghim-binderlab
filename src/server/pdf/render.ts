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
  /** Standard 45 s. */
  readonly timeoutMs?: number;
}

export interface PdfRenderer {
  readonly kind: PdfRendererKind;
  render(request: PdfRequest): Promise<Uint8Array>;
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

async function renderWith(
  launch: () => Promise<import("puppeteer-core").Browser>,
  request: PdfRequest,
): Promise<Uint8Array> {
  const url = new URL(request.url);
  const timeout = request.timeoutMs ?? 45_000;
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
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
    await page.waitForSelector(".bl-report", { timeout });
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}

/** Lokal Chromium (utveckling och tester). */
export class LocalPdfRenderer implements PdfRenderer {
  readonly kind = "local" as const;
  constructor(private readonly executablePath: string) {}

  render(request: PdfRequest): Promise<Uint8Array> {
    return renderWith(async () => {
      const puppeteer = (await import("puppeteer-core")).default;
      return puppeteer.launch({
        executablePath: this.executablePath,
        headless: true,
        args: ["--no-proxy-server", "--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
      });
    }, request);
  }
}

/** @sparticuz/chromium (Vercel och andra serverlösa miljöer). */
export class SparticuzPdfRenderer implements PdfRenderer {
  readonly kind = "sparticuz" as const;

  render(request: PdfRequest): Promise<Uint8Array> {
    return renderWith(async () => {
      const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
        import("puppeteer-core"),
        import("@sparticuz/chromium"),
      ]);
      return puppeteer.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: true,
      });
    }, request);
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
