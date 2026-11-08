/**
 * Playwright-biblioteket (inte @playwright/test) för e2e-testerna.
 *
 * Paketet `playwright` är inte ett beroende i package.json: lokalt finns det globalt
 * (NODE_PATH), och i CI installeras det i e2e-jobbet. Därför laddas det med require vid
 * körning, och typerna nedan beskriver bara den del av API:t som testerna använder.
 *
 * Inga sleeps: allt väntar på ett villkor (Playwrights automatiska väntan, waitFor,
 * waitForURL eller `until`).
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type TextMatch = string | RegExp;
type RoleOptions = { name?: TextMatch; exact?: boolean; level?: number; checked?: boolean };
type WaitState = "attached" | "detached" | "visible" | "hidden";

export interface Locator {
  click(options?: { timeout?: number; force?: boolean }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  press(key: string): Promise<void>;
  check(): Promise<void>;
  uncheck(): Promise<void>;
  isChecked(): Promise<boolean>;
  selectOption(
    value: string | { label?: string; value?: string; index?: number },
  ): Promise<string[]>;
  setInputFiles(files: string | string[]): Promise<void>;
  waitFor(options?: { state?: WaitState; timeout?: number }): Promise<void>;
  textContent(options?: { timeout?: number }): Promise<string | null>;
  innerText(options?: { timeout?: number }): Promise<string>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  allInnerTexts(): Promise<string[]>;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  filter(options: { hasText?: TextMatch; hasNotText?: TextMatch; has?: Locator }): Locator;
  locator(selector: string): Locator;
  getByRole(role: string, options?: RoleOptions): Locator;
  getByLabel(text: TextMatch, options?: { exact?: boolean }): Locator;
  getByText(text: TextMatch, options?: { exact?: boolean }): Locator;
  scrollIntoViewIfNeeded(): Promise<void>;
  screenshot(options?: { path?: string }): Promise<Buffer>;
}

export interface Page {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  url(): string;
  reload(): Promise<unknown>;
  waitForURL(
    url: string | RegExp | ((url: URL) => boolean),
    options?: { timeout?: number },
  ): Promise<void>;
  waitForLoadState(state?: "load" | "domcontentloaded" | "networkidle"): Promise<void>;
  locator(selector: string): Locator;
  getByRole(role: string, options?: RoleOptions): Locator;
  getByLabel(text: TextMatch, options?: { exact?: boolean }): Locator;
  getByText(text: TextMatch, options?: { exact?: boolean }): Locator;
  screenshot(options?: {
    path?: string;
    fullPage?: boolean;
    caret?: "hide" | "initial";
  }): Promise<Buffer>;
  evaluate<R>(fn: () => R): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  waitForFunction(
    fn: () => boolean,
    arg?: undefined,
    options?: { timeout?: number },
  ): Promise<unknown>;
  emulateMedia(options: { media: "print" | "screen" | null }): Promise<void>;
  setDefaultTimeout(ms: number): void;
  close(): Promise<void>;
  on(event: "pageerror", fn: (error: Error) => void): void;
  on(event: "console", fn: (message: ConsoleMessage) => void): void;
}

export interface ConsoleMessage {
  type(): string;
  text(): string;
  location(): { url: string; lineNumber: number; columnNumber: number };
}

export interface BrowserContext {
  newPage(): Promise<Page>;
  addInitScript(script: string): Promise<void>;
  addCookies(cookies: { name: string; value: string; url: string }[]): Promise<void>;
  /** HTTP-anrop med sammanhangets cookies (inloggningen), utan att rendera sidan. */
  readonly request: {
    get(
      url: string,
      options?: { maxRedirects?: number },
    ): Promise<{ status(): number; text(): Promise<string>; body(): Promise<Buffer> }>;
  };
  close(): Promise<void>;
}

export interface Browser {
  newContext(options: {
    baseURL: string;
    viewport: { width: number; height: number };
    screen?: { width: number; height: number };
    userAgent?: string;
    colorScheme?: "light" | "dark";
    locale?: string;
    timezoneId?: string;
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  }): Promise<BrowserContext>;
  close(): Promise<void>;
}

/** En enhet ur Playwrights lista (t.ex. devices["iPhone 15"]). */
export interface DeviceDescriptor {
  readonly userAgent: string;
  readonly viewport: { width: number; height: number };
  readonly screen?: { width: number; height: number };
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

interface Playwright {
  chromium: { launch(options: { args?: string[]; headless?: boolean }): Promise<Browser> };
  devices: Record<string, DeviceDescriptor>;
}

let cached: Playwright | null = null;

/** Laddar playwright (globalt installerat eller i node_modules). */
export function playwright(): Playwright {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  try {
    cached = require("playwright") as Playwright;
  } catch {
    throw new Error(
      "Paketet playwright saknas. Lokalt: installera det globalt (NODE_PATH). I CI installeras det i e2e-jobbet.",
    );
  }
  return cached;
}

export async function launchBrowser(): Promise<Browser> {
  return playwright().chromium.launch({ args: ["--no-proxy-server"] });
}

export const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

export interface PageOptions {
  readonly viewport?: keyof typeof VIEWPORTS;
  /** Appens tema (mörkt är standard i appen); sätts som det sparade valet i webbläsaren. */
  readonly theme?: "light" | "dark";
  /** En enhet ur Playwrights lista (t.ex. "iPhone 15"): skärm, pixeltäthet, touch, user agent. */
  readonly device?: string;
  /** Webbläsarens språk (Accept-Language). Standard sv-SE. */
  readonly locale?: string;
}

/** Ny sida i ett eget sammanhang (egna cookies), svensk tid och språk. */
export async function openPage(
  browser: Browser,
  baseURL: string,
  options: PageOptions = {},
): Promise<{ page: Page; context: BrowserContext; errors: Error[] }> {
  const mobile = options.viewport === "mobile";
  const device = options.device ? playwright().devices[options.device] : undefined;
  if (options.device && !device) throw new Error(`Okänd enhet: ${options.device}`);
  const context = await browser.newContext({
    baseURL,
    viewport: device?.viewport ?? VIEWPORTS[options.viewport ?? "desktop"],
    colorScheme: options.theme ?? "dark",
    locale: options.locale ?? "sv-SE",
    timezoneId: "Europe/Stockholm",
    ...(device
      ? {
          userAgent: device.userAgent,
          screen: device.screen,
          deviceScaleFactor: device.deviceScaleFactor,
          isMobile: device.isMobile,
          hasTouch: device.hasTouch,
        }
      : mobile
        ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
        : {}),
  });
  // Temat renderas på servern ur cookien (src/lib/theme.ts, THEME_COOKIE), och samma
  // nyckel i localStorage (THEME_STORAGE_KEY).
  await context.addCookies([
    { name: "binderlab-theme", value: options.theme ?? "dark", url: baseURL },
  ]);
  await context.addInitScript(
    `try { localStorage.setItem("binderlab-theme", ${JSON.stringify(options.theme ?? "dark")}); } catch {}`,
  );
  const page = await context.newPage();
  // Dev-servern kompilerar sidor vid första besöket; det kan ta tid.
  page.setDefaultTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 60_000));
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  // Konsolfel räknas som fel (t.ex. Reacts "Hydration failed"), utom de som är kända och
  // ofarliga (ALLOWED_CONSOLE_ERRORS).
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ALLOWED_CONSOLE_ERRORS.some((re) => re.test(text))) return;
    errors.push(new Error(`console.error på ${safePath(page.url())}: ${summarize(text)}`));
  });
  return { page, context, errors };
}

/**
 * Konsolfel som inte är fel i appen. Håll listan kort och förklara varje rad.
 */
export const ALLOWED_CONSOLE_ERRORS: readonly RegExp[] = [
  // Webbläsaren loggar svar med felstatus som testet själv framkallar: fel lösenord (401/400
  // från inloggningen) och sidor som rollen inte får se (403/404 före omdirigeringen).
  /^Failed to load resource: the server responded with a status of (400|401|403|404)\b/,
];

/** Första raden och, för Reacts hydreringsfel, skillnaden (raderna med + och -). */
function summarize(text: string): string {
  const lines = text.split("\n");
  const diff = lines.filter(
    (l) => /^\s*[+-]\s+\S/.test(l) && !/^\s*-\s+(A server|Variable|Date|External|Invalid)/.test(l),
  );
  return [lines[0]?.slice(0, 300) ?? "", ...diff.slice(0, 24).map((l) => l.trimEnd())].join("\n");
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Kastar om sidan har haft sidfel eller konsolfel; tömmer listan. */
export function expectNoPageErrors(errors: Error[]): void {
  const found = errors.splice(0, errors.length);
  if (found.length > 0) {
    throw new Error(
      `Sidfel eller konsolfel (${found.length}):\n${found.map((e) => `- ${e.message}`).join("\n")}`,
    );
  }
}

/** Väntar tills `check` ger ett värde (inte undefined/false), annars kastar med `message`. */
export async function until<T>(
  check: () => Promise<T | undefined | false>,
  message: string,
  timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 60_000),
): Promise<T> {
  const started = Date.now();
  let delay = 100;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Tidsgräns: ${message}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 1_000);
  }
}

/** Skärmbild till E2E_SCREENSHOT_DIR (standard .data/e2e). */
export async function screenshot(page: Page, name: string): Promise<string> {
  const dir = path.resolve(process.env.E2E_SCREENSHOT_DIR ?? path.join(".data", "e2e"));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  // caret: "initial": Playwright döljer annars markören med en inline-stil på fälten, och
  // om sidan inte hunnit hydreras än ger det ett (falskt) hydreringsfel i konsolen.
  await page.screenshot({ path: file, fullPage: false, caret: "initial" });
  return file;
}
