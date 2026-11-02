/**
 * Röd granskning fas 7, rättningen: regressionstester för det som täpptes utöver
 * hålen i redteam-fas7.test.ts och redteam-fas7-db.test.ts.
 *
 *   1. PDF-rutterna får en egen CSP som fortfarande förbjuder inramning, och
 *      appens CSP tillåter inte eval utanför development.
 *   2. Server actions och proxyn tar emot avtalsfiler (20 MB) och utbetalningsfiler.
 *   3. /design och /datamodell kräver inloggning även i själva sidan.
 *   4. CSV: negativa belopp är tal, inte text, men formelskyddet gäller allt annat.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

class LoginRequired extends Error {}
const requireUser = vi.fn(async () => {
  throw new LoginRequired("NEXT_REDIRECT /logga-in");
});
vi.mock("@/server/session", () => ({ requireUser }));

import { csvField } from "@/lib/csv";
import {
  contentSecurityPolicy,
  FILE_CONTENT_SECURITY_POLICY,
  INLINE_FILE_ROUTES,
  securityHeaderRules,
} from "@/lib/security-headers";
import { MAX_CONTRACT_FILE_BYTES } from "@/server/accounting/contract-files";
import { MAX_PAYOUT_FILE_BYTES } from "@/server/accounting/payout-csv";

import { clientIp } from "./request-info";
import { isPublicPath } from "./auth/paths";

type Config = {
  poweredByHeader?: boolean;
  experimental?: {
    serverActions?: { bodySizeLimit?: string | number };
    proxyClientMaxBodySize?: string | number;
  };
  headers?: () => Promise<
    Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  >;
};

async function config(): Promise<Config> {
  return ((await import("../../next.config")) as { default: Config }).default;
}

function bytes(size: string | number | undefined): number {
  if (typeof size === "number") return size;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(size ?? "");
  if (!m) return 1024 * 1024; // Next:s standard
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2]!.toLowerCase() as "b"];
  return Number(m[1]) * unit;
}

describe("säkerhetshuvuden: PDF-rutter och produktion", () => {
  it("varje PDF-rutt har en senare regel som förbjuder inramning", async () => {
    const rules = (await (await config()).headers?.()) ?? [];
    for (const route of INLINE_FILE_ROUTES) {
      const index = rules.findIndex((r) => r.source === route);
      expect(index, route).toBeGreaterThan(rules.findIndex((r) => r.source === "/(.*)"));
      const csp = rules[index]!.headers.find((h) => h.key === "Content-Security-Policy")?.value;
      expect(csp).toBe(FILE_CONTENT_SECURITY_POLICY);
      expect(csp).toMatch(/frame-ancestors 'none'/);
    }
    // X-Frame-Options och nosniff gäller fortfarande PDF:erna (regeln "/(.*)").
    const all = rules.find((r) => r.source === "/(.*)")!.headers.map((h) => h.key);
    expect(all).toEqual(expect.arrayContaining(["X-Frame-Options", "X-Content-Type-Options"]));
  });

  it("CSP utan eval och utan websocket utanför development; Sentry bara via https", () => {
    const prod = contentSecurityPolicy({
      dev: false,
      sentryDsn: "https://k@o1.ingest.sentry.io/2",
    });
    expect(prod).not.toMatch(/unsafe-eval/);
    expect(prod).not.toMatch(/\bws:/);
    expect(prod).toMatch(/connect-src 'self' https:\/\/o1\.ingest\.sentry\.io(;|$)/);
    expect(contentSecurityPolicy({ dev: false, sentryDsn: "http://evil.example/1" })).toMatch(
      /connect-src 'self'(;|$)/,
    );
    expect(contentSecurityPolicy({ dev: false, sentryDsn: "inte en adress" })).toMatch(
      /connect-src 'self'(;|$)/,
    );
  });

  it("samma rubriker för alla miljöer utom eval/websocket i development", () => {
    const dev = securityHeaderRules({ dev: true })[0]!.headers.map((h) => h.key);
    const prod = securityHeaderRules({ dev: false })[0]!.headers.map((h) => h.key);
    expect(dev).toEqual(prod);
  });
});

describe("uppladdningar ryms i server actions och proxyn", () => {
  it("bodySizeLimit och proxyClientMaxBodySize rymmer en avtalsfil på 20 MB med formulärdata", async () => {
    const c = await config();
    const needed = Math.max(MAX_CONTRACT_FILE_BYTES, MAX_PAYOUT_FILE_BYTES) + 64 * 1024;
    expect(bytes(c.experimental?.serverActions?.bodySizeLimit)).toBeGreaterThanOrEqual(needed);
    expect(bytes(c.experimental?.proxyClientMaxBodySize)).toBeGreaterThanOrEqual(needed);
  });
});

describe("/design och /datamodell kräver inloggning", () => {
  it("proxyn släpper inte förbi dem, men rotens statiska filer går förbi", () => {
    for (const path of ["/design", "/design/epost", "/datamodell"]) {
      expect(isPublicPath(path), path).toBe(false);
    }
    for (const path of ["/sw.js", "/favicon.ico", "/icons/icon-192.png", "/manifest.webmanifest"]) {
      expect(isPublicPath(path), path).toBe(true);
    }
    expect(isPublicPath("/icons/x/y.png")).toBe(false);
    expect(isPublicPath("/rapport/x.json")).toBe(true); // /rapport/* skyddar sig själv
    expect(isPublicPath("/portal/x.json")).toBe(false);
  });

  it.each([
    ["/datamodell", () => import("../app/datamodell/page")],
    ["/design", () => import("../app/design/page")],
    ["/design/epost", () => import("../app/design/epost/page")],
  ])("%s anropar requireUser innan något renderas", async (_path, load) => {
    requireUser.mockClear();
    const Page = (await load()).default as (props: {
      searchParams: Promise<Record<string, string>>;
    }) => Promise<unknown>;
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(LoginRequired);
    expect(requireUser).toHaveBeenCalledTimes(1);
  });
});

describe("klientens IP", () => {
  it("Vercels rubrik vinner över en påhittad X-Forwarded-For", () => {
    expect(
      clientIp(
        new Headers({
          "x-forwarded-for": "6.6.6.6, 7.7.7.7",
          "x-vercel-forwarded-for": "203.0.113.4",
        }),
      ),
    ).toBe("203.0.113.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.4 " }))).toBe(
      "203.0.113.4",
    );
  });
});

describe("CSV: negativa belopp och formelskydd", () => {
  it.each(["-3,50", "-12", "-0,01", "-79987,00"])("%s skrivs som tal", (value) => {
    expect(csvField(value)).toBe(value);
  });

  it.each(["-3,50+1", "-1;cmd", "-2-3", "-HYPERLINK(1)", "-1,5,5", "- 3", "-3.50", "-3,50\n"])(
    "%j skyddas fortfarande som formel",
    (value) => {
      expect(csvField(value).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );
});
