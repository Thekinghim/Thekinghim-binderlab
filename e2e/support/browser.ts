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
  screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  evaluate<R>(fn: () => R): Promise<R>;
  setDefaultTimeout(ms: number): void;
  close(): Promise<void>;
  on(event: "pageerror", fn: (error: Error) => void): void;
}

export interface BrowserContext {
  newPage(): Promise<Page>;
  addInitScript(script: string): Promise<void>;
  close(): Promise<void>;
}

export interface Browser {
  newContext(options: {
    baseURL: string;
    viewport: { width: number; height: number };
    colorScheme?: "light" | "dark";
    locale?: string;
    timezoneId?: string;
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  }): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface Playwright {
  chromium: { launch(options: { args?: string[]; headless?: boolean }): Promise<Browser> };
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
}

/** Ny sida i ett eget sammanhang (egna cookies), svensk tid och språk. */
export async function openPage(
  browser: Browser,
  baseURL: string,
  options: PageOptions = {},
): Promise<{ page: Page; context: BrowserContext; errors: Error[] }> {
  const mobile = options.viewport === "mobile";
  const context = await browser.newContext({
    baseURL,
    viewport: VIEWPORTS[options.viewport ?? "desktop"],
    colorScheme: options.theme ?? "dark",
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  // Samma nyckel som src/lib/theme.ts (THEME_STORAGE_KEY).
  await context.addInitScript(
    `try { localStorage.setItem("binderlab-theme", ${JSON.stringify(options.theme ?? "dark")}); } catch {}`,
  );
  const page = await context.newPage();
  // Dev-servern kompilerar sidor vid första besöket; det kan ta tid.
  page.setDefaultTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 60_000));
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  return { page, context, errors };
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
  await page.screenshot({ path: file, fullPage: false });
  return file;
}
