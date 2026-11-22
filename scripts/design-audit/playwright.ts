/**
 * Playwright-biblioteket, som i e2e/support/browser.ts: paketet är inget beroende i
 * package.json (lokalt globalt via NODE_PATH), så det laddas med require vid körning och
 * typerna här beskriver bara det som granskningen använder.
 */

import { createRequire } from "node:module";
import path from "node:path";

export interface Response {
  status(): number;
  url(): string;
  request(): { resourceType(): string; method(): string };
}

export interface ConsoleMessage {
  type(): string;
  text(): string;
  location(): { url: string };
}

export interface Locator {
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  first(): Locator;
  count(): Promise<number>;
}

export interface Page {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<Response | null>;
  url(): string;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
  waitForURL(url: (url: URL) => boolean, options?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): Locator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  evaluate<R>(script: string): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  setContent(html: string): Promise<void>;
  screenshot(options?: {
    type?: "png" | "jpeg";
    quality?: number;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
    animations?: "disabled" | "allow";
    caret?: "hide" | "initial";
    timeout?: number;
  }): Promise<Buffer>;
  setDefaultTimeout(ms: number): void;
  close(): Promise<void>;
  on(event: "console", fn: (m: ConsoleMessage) => void): void;
  on(event: "pageerror", fn: (e: Error) => void): void;
  on(event: "response", fn: (r: Response) => void): void;
}

export interface StorageState {
  cookies: unknown[];
  origins: unknown[];
}

export interface BrowserContext {
  newPage(): Promise<Page>;
  storageState(): Promise<StorageState>;
  request: {
    get(
      url: string,
      options?: { headers?: Record<string, string>; timeout?: number },
    ): Promise<{ status(): number; text(): Promise<string> }>;
  };
  close(): Promise<void>;
}

export interface ContextOptions {
  baseURL: string;
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  locale?: string;
  timezoneId?: string;
  storageState?: StorageState;
  reducedMotion?: "reduce" | "no-preference";
}

export interface Browser {
  newContext(options: ContextOptions): Promise<BrowserContext>;
  isConnected(): boolean;
  close(): Promise<void>;
}

interface Playwright {
  chromium: { launch(options?: { args?: string[] }): Promise<Browser> };
}

export function launchBrowser(): Promise<Browser> {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  let pw: Playwright;
  try {
    pw = require("playwright") as Playwright;
  } catch {
    throw new Error(
      "Paketet playwright saknas. Lokalt: installera det globalt (NODE_PATH), som för e2e.",
    );
  }
  // Ingen proxy för den lokala servern (samma som e2e).
  return pw.chromium.launch({ args: ["--no-proxy-server"] });
}
