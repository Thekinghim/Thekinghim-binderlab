/**
 * Röd granskning fas 7: konfiguration och rena funktioner (ingen databas).
 *
 *   1. Säkerhetshuvuden: CSP med frame-ancestors, X-Frame-Options, nosniff,
 *      Referrer-Policy, HSTS och Permissions-Policy på alla sidor (next.config eller
 *      proxyn), och inget X-Powered-By.
 *   2. Öppen omdirigering: safeRedirectPath och loginRedirectPath med kända trick.
 *   3. Proxyn: vilka sökvägar som räknas som öppna.
 *   4. Dev-inloggningen kan inte slås på i preview eller production.
 *   5. Gränsen för inloggningsförsök (loginFlow) med fejkad provider.
 *   6. Cron-hemligheten jämförs exakt.
 *   7. Ingen sql.raw/unsafe med indata i appens kod.
 *
 * Konvention: `it.fails("HÅL …")` beskriver det säkra beteendet för ett hål som
 * granskningen hittade och som inte är åtgärdat. När hålet täpps börjar testet
 * fallera; byt då till `it`.
 */

import { execSync } from "node:child_process";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// Modulerna importerar "server-only" (kastar utanför Next) och databasklienten.
vi.mock("server-only", () => ({}));

import { parseServerEnv } from "@/lib/env";

import { cronAuthorized } from "./alerts/cron-auth";
import { assertDevAuthAllowed } from "./auth/dev-guard";
import { loginFlow } from "./auth/flows";
import { isPublicPath, loginRedirectPath, safeRedirectPath } from "./auth/paths";
import type { AuthProvider } from "./auth/types";
import { clientIp } from "./request-info";
import { createRateLimiter } from "./rate-limit";

// ---------------------------------------------------------------------------
// 1. Säkerhetshuvuden
// ---------------------------------------------------------------------------

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

/** Huvudena som next.config.ts sätter på en vanlig sida (/hem), med små bokstäver. */
async function configHeaders(): Promise<Map<string, string>> {
  const mod = (await import("../../next.config")) as {
    default: { headers?: () => Promise<HeaderRule[]>; poweredByHeader?: boolean };
  };
  const out = new Map<string, string>();
  const rules = (await mod.default.headers?.()) ?? [];
  for (const rule of rules) {
    // Regler som gäller alla sidor ("/(.*)", "/:path*").
    if (!/^\/(\(\.\*\)|:path\*)$/.test(rule.source)) continue;
    for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

/** Huvudena som proxyn sätter på en sida (inloggningssidan, som är öppen). */
async function proxyHeaders(): Promise<Map<string, string>> {
  const { proxy } = await import("../proxy");
  const res = await proxy(new NextRequest("http://localhost:3200/logga-in"));
  return new Map([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
}

async function securityHeaders(): Promise<Map<string, string>> {
  return new Map([...(await proxyHeaders()), ...(await configHeaders())]);
}

describe("säkerhetshuvuden", () => {
  /**
   * TÄPPT (var medel; åtgärdat i src/lib/security-headers.ts via next.config.ts):
   * tidigare inga säkerhetshuvuden alls (kontrollerat mot dev-servern: bara
   * Cache-Control, Vary och X-Powered-By). Utan frame-ancestors/X-Frame-Options kan
   * vilken sida som helst ramas in (clickjacking mot Inställningar → Användare,
   * Godkänn rapport, Skicka). Åtgärd: headers() i next.config.ts för "/(.*)".
   */
  it("TÄPPT: alla sidor förbjuder inramning (CSP frame-ancestors 'none' eller X-Frame-Options DENY)", async () => {
    const h = await securityHeaders();
    const csp = h.get("content-security-policy") ?? "";
    const framed =
      /frame-ancestors\s+('none'|'self')/.test(csp) ||
      /^(DENY|SAMEORIGIN)$/i.test(h.get("x-frame-options") ?? "");
    expect(framed).toBe(true);
  });

  it("TÄPPT: X-Content-Type-Options: nosniff på alla svar", async () => {
    expect((await securityHeaders()).get("x-content-type-options")).toBe("nosniff");
  });

  it("TÄPPT: Referrer-Policy läcker inte sökvägar (inbjudningstoken, rapport-id) till andra webbplatser", async () => {
    const policy = (await securityHeaders()).get("referrer-policy") ?? "";
    expect([
      "no-referrer",
      "same-origin",
      "strict-origin",
      "strict-origin-when-cross-origin",
    ]).toContain(policy);
  });

  it("TÄPPT: en Content-Security-Policy med default-src och object-src 'none'", async () => {
    const csp = (await securityHeaders()).get("content-security-policy") ?? "";
    expect(csp).toMatch(/default-src/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri ('none'|'self')/);
  });

  it("TÄPPT: Strict-Transport-Security (HSTS) utanför development", async () => {
    expect((await securityHeaders()).get("strict-transport-security") ?? "").toMatch(
      /max-age=\d{7,}/,
    );
  });

  it("TÄPPT: X-Powered-By är avstängt (poweredByHeader: false)", async () => {
    const mod = (await import("../../next.config")) as { default: { poweredByHeader?: boolean } };
    expect(mod.default.poweredByHeader).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Öppen omdirigering
// ---------------------------------------------------------------------------

const EVIL = [
  "//evil.example",
  "///evil.example",
  "/\\evil.example",
  "\\/evil.example",
  "/\\/evil.example",
  "https://evil.example",
  "HTTPS://evil.example",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "/%2F/evil.example",
  "/%2f%2fevil.example",
  "/%5Cevil.example",
  "/%2e%2e//evil.example",
  "/./%2e//evil.example",
  "/.//evil.example",
  "/a/..//evil.example",
  "/\tevil.example",
  "/\t/evil.example",
  "/\n/evil.example",
  " //evil.example",
  "。//evil.example",
  "/∕∕evil.example",
  "//evil.example@binderlab.se",
  "/@evil.example",
];

describe("öppen omdirigering", () => {
  it.each(EVIL)("safeRedirectPath(%j) stannar på appens värd", (next) => {
    const out = safeRedirectPath(next);
    expect(out.startsWith("/")).toBe(true);
    expect(out.startsWith("//")).toBe(false);
    expect(out.startsWith("/\\")).toBe(false);
    // Som webbläsaren tolkar Location-huvudet.
    expect(new URL(out, "https://app.binderlab.se/logga-in").host).toBe("app.binderlab.se");
  });

  it.each(EVIL)("loginRedirectPath med %j ger en lokal next", (path) => {
    const out = loginRedirectPath(path.startsWith("/") ? path : `/${path}`);
    const next = new URL(out, "https://app.binderlab.se").searchParams.get("next");
    if (next !== null) {
      expect(new URL(safeRedirectPath(next), "https://app.binderlab.se").host).toBe(
        "app.binderlab.se",
      );
    }
  });

  it("vanliga sökvägar med query och hash behålls", () => {
    expect(safeRedirectPath("/lonsamhet?period=30d#tabell")).toBe("/lonsamhet?period=30d#tabell");
    expect(safeRedirectPath("/logga-in?next=/x")).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// 3. Proxyn: öppna sökvägar
// ---------------------------------------------------------------------------

describe("proxyn", () => {
  it.each([
    "/",
    "/lonsamhet",
    "/rapporter",
    "/rapport",
    "/designsystem-hemligt",
    "/datamodell-x",
    "/inbjudan",
    "/api/cron",
    "/api/other",
    "/order/export",
    "/installningar/export",
    "/ekonomi/bokforing/paket",
    "/portal",
    "/assistent/fraga",
  ])("%s kräver inloggning i proxyn", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });

  /**
   * Låg: allt som slutar på .json/.txt/.xml/.js/.map/.svg … räknas som statisk fil och
   * släpps förbi proxyn, även under appens sökvägar (t.ex. /inkorg/x.json). Skyddet
   * sitter i serverkoden (requireUser/requireRole och RLS), så det läcker inget i dag,
   * men en framtida route.ts med ett dynamiskt segment förlorar proxyns omdirigering.
   * Åtgärd: matcha statiska filer bara under /_next, /public-filerna och rotens ikoner.
   * TÄPPT: src/server/auth/paths.ts (STATIC_FILE gäller bara roten och /icons).
   */
  it("TÄPPT (låg): en sökväg under appen räknas inte som öppen bara för att den slutar på .json", () => {
    expect(isPublicPath("/inkorg/x.json")).toBe(false);
    expect(isPublicPath("/order/export.txt")).toBe(false);
  });

  /**
   * Låg: /datamodell (hela schemat med tabeller, roller och RLS-regler) och /design är
   * öppna utan inloggning även i production. Det ger en angripare en karta över
   * behörighetsmodellen. Åtgärd: notFound() när APP_ENV är production, eller kräv inloggning.
   * TÄPPT: båda kräver inloggning i proxyn och i sidorna (requireUser).
   */
  it("TÄPPT (låg): /datamodell kräver inloggning", () => {
    expect(isPublicPath("/datamodell")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Dev-inloggningen kan inte slås på i preview eller production
// ---------------------------------------------------------------------------

const LOCAL_DB = "postgres://postgres@127.0.0.1:54322/binderlab_dev";
const SECRET = "x".repeat(48);

describe("dev-inloggningen", () => {
  it.each([
    { APP_ENV: "preview", DATABASE_URL: LOCAL_DB },
    { APP_ENV: "production", DATABASE_URL: LOCAL_DB },
    { APP_ENV: undefined, DATABASE_URL: LOCAL_DB },
    { APP_ENV: "development", DATABASE_URL: LOCAL_DB, NODE_ENV: "production" },
    { APP_ENV: "development", DATABASE_URL: LOCAL_DB, VERCEL: "1" },
    { APP_ENV: "development", DATABASE_URL: LOCAL_DB, VERCEL_ENV: "preview" },
    { APP_ENV: "development", DATABASE_URL: "postgres://u:p@db.example.supabase.co:5432/postgres" },
    { APP_ENV: "development", DATABASE_URL: "postgres://u@127.0.0.1.evil.example/x" },
    { APP_ENV: "development", DATABASE_URL: "postgres://u@localhost/x?host=db.example.com" },
    { APP_ENV: "development", DATABASE_URL: "postgres://u@127.0.0.1,db.example.com/x" },
  ])("spärras: %j", (env) => {
    expect(() =>
      assertDevAuthAllowed({
        NODE_ENV: "development",
        VERCEL: undefined,
        VERCEL_ENV: undefined,
        NEXT_PHASE: undefined,
        ...env,
      }),
    ).toThrow();
  });

  it.each(["preview", "production"])(
    "miljövalideringen godtar inte AUTH_PROVIDER=dev när APP_ENV=%s",
    (appEnv) => {
      expect(() =>
        parseServerEnv({
          APP_ENV: appEnv,
          AUTH_PROVIDER: "dev",
          DATABASE_URL: LOCAL_DB,
          DEV_AUTH_SECRET: SECRET,
          APP_URL: "https://app.binderlab.se",
          SUPABASE_URL: "https://x.supabase.co",
          SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
          SUPABASE_SECRET_KEY: "sb_secret_x",
          NODE_ENV: "production",
        }),
      ).toThrow(/AUTH_PROVIDER/);
    },
  );

  it("utan APP_ENV i ett produktionsbygge väljs aldrig dev-inloggningen", () => {
    expect(() =>
      parseServerEnv({
        DATABASE_URL: LOCAL_DB,
        DEV_AUTH_SECRET: SECRET,
        NODE_ENV: "production",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Gränsen för inloggningsförsök
// ---------------------------------------------------------------------------

function fakeProvider(password: string): AuthProvider & { attempts: number } {
  const p = {
    kind: "dev" as const,
    attempts: 0,
    async signInWithPassword(_email: string, given: string) {
      p.attempts += 1;
      return given === password
        ? { ok: true as const, session: { userId: "u", email: "a@b.se" } }
        : { ok: false as const, reason: "invalid_credentials" as const };
    },
  };
  return p as unknown as AuthProvider & { attempts: number };
}

describe("inloggningens gräns", () => {
  it("parallella försök räknas innan lösenordet prövas (inget race förbi gränsen)", async () => {
    const provider = fakeProvider("rätt-lösenord-123");
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        loginFlow(
          { provider, limiter, ip: "203.0.113.5" },
          { email: "a@b.se", password: `fel-${i}` },
        ),
      ),
    );
    expect(provider.attempts).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.ok)).toEqual([]);
  });

  it("lösenordsspray mot många konton från en IP stoppas inte av gränsen per konto, men gränsen per IP och e-post gäller varje konto", async () => {
    const provider = fakeProvider("x");
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    for (let i = 0; i < 6; i += 1) {
      await loginFlow(
        { provider, limiter, ip: "203.0.113.9" },
        { email: "c@d.se", password: `fel-${i}` },
      );
    }
    expect(provider.attempts).toBe(5);
  });

  /**
   * Låg: klientens IP är första värdet i X-Forwarded-For. Vercel skriver över rubriken,
   * men bakom en annan proxy (eller lokalt) kan klienten själv välja IP och därmed få nya
   * räknare per IP. Gränsen per konto (20) gäller fortfarande, men en spray mot många
   * konton (5 försök per konto och påhittad IP) begränsas inte. Åtgärd: läs
   * x-vercel-forwarded-for / x-real-ip som Vercel sätter, eller sista betrodda hoppet.
   * TÄPPT: clientIp läser Vercels rubriker och annars sista värdet i X-Forwarded-For.
   */
  it("TÄPPT (låg): en påhittad X-Forwarded-For styr inte vilken IP som räknas", () => {
    const spoofed = new Headers({
      "x-forwarded-for": "1.2.3.4, 198.51.100.7",
      "x-real-ip": "198.51.100.7",
    });
    expect(clientIp(spoofed)).toBe("198.51.100.7");
  });
});

// ---------------------------------------------------------------------------
// 6. Cron-hemligheten
// ---------------------------------------------------------------------------

describe("cron-hemligheten", () => {
  const secret = "s3cr3t-som-ar-lang-nog-1234";
  it.each([
    [null, false],
    ["", false],
    [`Bearer ${secret}`, true],
    [`bearer ${secret}`, false],
    [`Bearer ${secret}x`, false],
    [`Bearer ${secret.slice(1)}`, false],
    [`Bearer  ${secret}`, false],
    [secret, false],
  ] as const)("%j → %s", (header, ok) => {
    expect(cronAuthorized(header, secret)).toBe(ok);
  });

  it("en för kort hemlighet godtas aldrig, inte ens med rätt rubrik", () => {
    expect(cronAuthorized("Bearer kort", "kort")).toBe(false);
    expect(cronAuthorized("Bearer ", "")).toBe(false);
    expect(cronAuthorized("Bearer undefined", undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. SQL-injektion: inga råa SQL-fragment med indata
// ---------------------------------------------------------------------------

describe("råa SQL-fragment", () => {
  it("sql.raw och .unsafe används bara på kända ställen utan användarindata", () => {
    const hits = execSync(
      `grep -rnE "sql\\.raw\\(|\\.unsafe\\(" src --include=*.ts --include=*.tsx || true`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((l) => l && !l.includes(".test.") && !l.startsWith("src/db/migrator.ts"))
      .map((l) => l.replace(/:\d+:/, ": "));
    // Orderexportens satsstorlek: ett heltal som räknas fram i koden (Math.trunc).
    expect(hits).toEqual([
      "src/app/(app)/order/_lib/queries.ts:   const size = sql.raw(String(Math.max(1, Math.trunc(batch))));",
    ]);
  });
});
