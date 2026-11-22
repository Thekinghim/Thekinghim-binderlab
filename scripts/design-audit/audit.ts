/**
 * Granskningen: loggar in som varje roll, öppnar varje sida på dator (1440 × 900) och
 * telefon (390 × 844), skrollar till botten så att allt laddas, mäter i sidan (probe.ts)
 * och tar en tumnagel med de felande elementen inramade i rött.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, StorageState } from "./playwright";
import { probeScript, type ProbeResult, type RawFinding } from "./probe";
import { fillPattern, patternFor, type RoutePattern } from "./routes";
import { DEFAULT_PASSWORD, type Role } from "./setup";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, isMobile: false, scale: 0.5 },
  phone: { width: 390, height: 844, isMobile: true, scale: 0.6 },
} as const;
export type ViewportKey = keyof typeof VIEWPORTS;

export interface PageAudit {
  pattern: string;
  file: string;
  url: string | null;
  role: string;
  viewport: ViewportKey;
  status: "audited" | "redirected" | "unresolved" | "failed";
  note?: string;
  httpStatus?: number;
  findings: RawFinding[];
  textElements?: number;
  isV2Shell?: boolean;
  shot?: string;
  ms?: number;
}

const SCROLL = `(async () => {
  let y = 0;
  for (let i = 0; i < 40; i += 1) {
    y += window.innerHeight;
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 150));
    if (y >= document.documentElement.scrollHeight) break;
  }
  window.scrollTo(0, 0);
})()`;

const OUTLINE = `[data-design-audit] { outline: 2px solid #ff0000 !important; outline-offset: -1px !important; }`;

export async function login(
  browser: Browser,
  baseUrl: string,
  role: Role,
  log: (m: string) => void,
): Promise<StorageState | null> {
  if (!role.email) return { cookies: [], origins: [] };
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1440, height: 900 },
    locale: "sv-SE",
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto("/logga-in", { waitUntil: "load" });
    await page.getByLabel(/^E-post(adress)?$/).fill(role.email);
    await page.getByLabel("Lösenord").fill(DEFAULT_PASSWORD);
    await page.getByRole("button", { name: "Logga in", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/logga-in"), { timeout: 120_000 });
    log(`Inloggad som ${role.label} (${role.email}) → ${new URL(page.url()).pathname}`);
    return await context.storageState();
  } catch (error) {
    log(`Kunde inte logga in som ${role.label}: ${error instanceof Error ? error.message : error}`);
    return null;
  } finally {
    await context.close();
  }
}

/** En länk i sidan som passar mönstret (för dynamiska delar som inte finns i databasen). */
export async function discoverByLink(
  browser: Browser,
  baseUrl: string,
  state: StorageState,
  route: RoutePattern,
  allPatterns: readonly string[],
): Promise<string | null> {
  const parent = route.pattern.split("/[")[0] || "/";
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1440, height: 900 },
    storageState: state,
    locale: "sv-SE",
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(parent, { waitUntil: "load" });
    const hrefs = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll("a[href]"), (a) => new URL(a.href).pathname)`,
    );
    return hrefs.find((h) => patternFor(h, allPatterns) === route.pattern) ?? null;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

/** Skärmbilden förminskad till en tumnagel (canvas i en tom sida, ingen CSP). */
async function thumbnail(scaler: BrowserContext, jpeg: Buffer, scale: number): Promise<Buffer> {
  const page = await scaler.newPage();
  try {
    const data = await page.evaluate<string, { src: string; scale: number }>(
      async ({ src, scale }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.6);
      },
      { src: `data:image/jpeg;base64,${jpeg.toString("base64")}`, scale },
    );
    return Buffer.from(data.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  } finally {
    await page.close();
  }
}

export function shotName(pattern: string, viewport: ViewportKey): string {
  const slug =
    pattern
      .replace(/^\//, "")
      .replace(/\[([^\]]+)\]/g, "$1")
      .replace(/[^a-zA-Z0-9-]+/g, "_") || "hem";
  return `${slug}__${viewport}.jpg`;
}

export interface AuditJob {
  route: RoutePattern;
  role: Role;
  state: StorageState;
  url: string | null;
}

export interface AuditDeps {
  browser: Browser;
  scaler: BrowserContext;
  baseUrl: string;
  allPatterns: readonly string[];
  outDir: string;
  /** Sidor (mönster + skärm) som redan har en tumnagel. */
  shots: Set<string>;
  maxPerKey: number;
  log: (m: string) => void;
}

/** En roll × sida på båda skärmarna (telefonen hoppas över om datorn skickades vidare). */
export async function auditJob(job: AuditJob, deps: AuditDeps): Promise<PageAudit[]> {
  const out: PageAudit[] = [];
  const base = { pattern: job.route.pattern, file: job.route.file, role: job.role.key };
  if (!job.url) {
    return [{ ...base, url: null, viewport: "desktop", status: "unresolved", findings: [] }];
  }
  for (const vp of Object.keys(VIEWPORTS) as ViewportKey[]) {
    let audit = await auditPage(job, vp, deps);
    // En navigering mitt i mätningen (klientens omdirigering) eller en krascherad flik: en
    // gång till.
    if (audit.status === "failed") audit = await auditPage(job, vp, deps);
    out.push({ ...base, ...audit });
    if (audit.status !== "audited") break;
  }
  return out;
}

async function auditPage(
  job: AuditJob,
  vp: ViewportKey,
  deps: AuditDeps,
): Promise<Omit<PageAudit, "pattern" | "file" | "role">> {
  const v = VIEWPORTS[vp];
  const started = Date.now();
  const context = await deps.browser.newContext({
    baseURL: deps.baseUrl,
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: 1,
    isMobile: v.isMobile,
    hasTouch: v.isMobile,
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    storageState: job.state,
    reducedMotion: "reduce",
  });
  const errors: RawFinding[] = [];
  const seen = new Set<string>();
  const push = (type: "console-error" | "http-error", detail: string, text: string) => {
    const key = `${type}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push({ type, detail, text, selector: "", className: "", key });
  };
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    page.on("console", (m) => {
      if (m.type() === "error") push("console-error", m.text().slice(0, 300), m.location().url);
    });
    page.on("pageerror", (e) => push("console-error", `pageerror: ${e.message.slice(0, 300)}`, ""));
    page.on("response", (r) => {
      if (r.status() >= 400) {
        const u = new URL(r.url());
        push("http-error", `HTTP ${r.status()} ${r.request().method()} ${u.pathname}`, r.url());
      }
    });
    const res = await page.goto(job.url!, { waitUntil: "load", timeout: 240_000 });
    const httpStatus = res?.status();
    // Klientens omdirigeringar (router.replace) hinner ske innan adressen läses.
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    const finalPath = new URL(page.url()).pathname;
    const landed = patternFor(finalPath, deps.allPatterns);
    if (landed !== job.route.pattern) {
      return {
        url: job.url,
        viewport: vp,
        status: "redirected",
        note: `→ ${finalPath}`,
        httpStatus,
        findings: [],
        ms: Date.now() - started,
      };
    }
    await page.evaluate(SCROLL);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
    const result = await page.evaluate<ProbeResult>(
      probeScript({ phone: v.isMobile, maxPerKey: deps.maxPerKey }),
    );
    let shot: string | undefined;
    const shotKey = `${job.route.pattern}|${vp}`;
    if (!deps.shots.has(shotKey)) {
      deps.shots.add(shotKey);
      try {
        await page.addStyleTag({ content: OUTLINE });
        const height = Math.min(result.documentHeight, vp === "phone" ? 5000 : 4000);
        const raw = await page.screenshot({
          type: "jpeg",
          quality: 70,
          fullPage: true,
          clip: { x: 0, y: 0, width: v.width, height },
          animations: "disabled",
          caret: "hide",
          timeout: 60_000,
        });
        const small = await thumbnail(deps.scaler, raw, v.scale);
        const name = shotName(job.route.pattern, vp);
        mkdirSync(path.join(deps.outDir, "shots"), { recursive: true });
        writeFileSync(path.join(deps.outDir, "shots", name), small);
        shot = `shots/${name}`;
      } catch (error) {
        deps.log(`  tumnagel misslyckades för ${job.route.pattern} (${vp}): ${String(error)}`);
      }
    }
    if (httpStatus && httpStatus >= 400) {
      push("http-error", `HTTP ${httpStatus} GET ${finalPath} (sidan)`, job.url!);
    }
    return {
      url: job.url,
      viewport: vp,
      status: "audited",
      httpStatus,
      findings: [...result.findings, ...errors],
      textElements: result.textElements,
      isV2Shell: result.isV2Shell,
      shot,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      url: job.url,
      viewport: vp,
      status: "failed",
      note: error instanceof Error ? error.message.split("\n")[0] : String(error),
      findings: errors,
      ms: Date.now() - started,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export function jobUrl(
  route: RoutePattern,
  params: Record<string, Record<string, string>>,
): string | null {
  if (route.params.length === 0) return route.pattern;
  const values = params[route.pattern];
  return values ? fillPattern(route.pattern, values) : null;
}
