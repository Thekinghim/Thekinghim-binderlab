import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildOptions, parseArgs, UsageError } from "../../scripts/deploy/lib/config";
import { ApiError, createApiClient, DryRunViolation } from "../../scripts/deploy/lib/http";
import { createLogger } from "../../scripts/deploy/lib/log";
import {
  fingerprint,
  generateCronSecret,
  generatePassword,
} from "../../scripts/deploy/lib/secrets";
import {
  authConfigDiff,
  databaseUrl,
  desiredAuthConfig,
  dollarTag,
  migrationQuery,
  resendSmtp,
} from "../../scripts/deploy/lib/supabase";

function capture() {
  const lines: string[] = [];
  const log = createLogger((_l, line) => lines.push(line));
  return { lines, log };
}

describe("loggern", () => {
  it("maskerar registrerade hemligheter, även URL-kodade", () => {
    const { lines, log } = capture();
    log.secret("abc+def/ghi=jkl123");
    log.info("värde abc+def/ghi=jkl123 och abc%2Bdef%2Fghi%3Djkl123");
    expect(lines[0]).toBe("  · värde [hemlig] och [hemlig]");
  });

  it("maskerar kända mönster utan registrering", () => {
    const { lines, log } = capture();
    log.error(
      "sb_secret_abcDEF123_xyz postgresql://postgres.ref:hemligt@host:6543/postgres Bearer abcdefghijkl sbp_0123456789abcdefghij0123",
    );
    expect(lines[0]).toBe(
      "  ✗ FEL: [hemlig] postgresql://postgres.ref:[hemlig]@host:6543/postgres Bearer [hemlig] [hemlig]",
    );
  });

  it("maskerar inte korta vardagsvärden", () => {
    const { lines, log } = capture();
    log.secret("3");
    log.info("DATABASE_POOL_MAX=3");
    expect(lines[0]).toContain("=3");
  });

  it("samlar manuella steg och varningar", () => {
    const { log } = capture();
    log.manual("gör X");
    log.warn("akta Y");
    expect(log.manualSteps).toEqual(["gör X"]);
    expect(log.warnings).toEqual(["akta Y"]);
  });
});

describe("HTTP-klienten", () => {
  function client(responses: (() => Response | Promise<Response>)[], dryRun = false) {
    const { log, lines } = capture();
    const sleeps: number[] = [];
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = createApiClient({
      service: "Test",
      baseUrl: "https://api.example.com/",
      token: "tok_abcdefghijklmnop",
      fetch: async (url, init) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (!next) throw new Error("inga fler svar");
        return next();
      },
      log,
      dryRun,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { api, sleeps, calls, lines };
  }

  it("försöker igen vid 429 med Retry-After och vid nätverksfel", async () => {
    const { api, sleeps, calls } = client([
      () => new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    ]);
    const res = await api.get("/x", { query: { a: 1 } });
    expect(res.data).toEqual({ ok: 1 });
    expect(sleeps[0]).toBe(3000);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://api.example.com/x?a=1");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe(
      "Bearer tok_abcdefghijklmnop",
    );
  });

  it("ger ApiError med API:ts meddelande och utan token", async () => {
    const { api } = client([
      () =>
        new Response(JSON.stringify({ error: { message: "nope tok_abcdefghijklmnop" } }), {
          status: 401,
        }),
    ]);
    const error = await api.get("/y").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as Error).message).toBe(
      "Test: GET /y svarade 401: nope [hemlig] (är token giltig och rätt?).",
    );
  });

  it("släpper igenom tillåtna statuskoder", async () => {
    const { api } = client([() => new Response("", { status: 404 })]);
    expect((await api.get("/z", { allow: [404] })).status).toBe(404);
  });

  it("nätverksfel efter alla försök säger vilken värd som måste vara öppen", async () => {
    const { api } = client(
      Array.from({ length: 5 }, () => () => Promise.reject(new TypeError("getaddrinfo ENOTFOUND"))),
    );
    await expect(api.get("/q")).rejects.toThrow(/nådde inte fram.*api\.example\.com är öppet/);
  });

  it("gör aldrig om ett POST vid 5xx eller nätverksfel (kan ha gått igenom), men vid 429", async () => {
    const r504 = client([() => new Response("Gateway Timeout", { status: 504 })]);
    await expect(r504.api.request("POST", "/skapa", { body: {} })).rejects.toThrow(/svarade 504/);
    expect(r504.calls).toHaveLength(1);

    const net = client([() => Promise.reject(new TypeError("socket hang up"))]);
    await expect(net.api.request("POST", "/skapa", { body: {} })).rejects.toThrow(
      /kan ha gått igenom och gjordes inte om/,
    );
    expect(net.calls).toHaveLength(1);

    const limited = client([
      () => new Response("{}", { status: 429 }),
      () => new Response(JSON.stringify({ id: 1 }), { status: 201 }),
    ]);
    expect((await limited.api.request("POST", "/skapa", { body: {} })).data).toEqual({ id: 1 });
    expect(limited.calls).toHaveLength(2);
  });

  it("gör om idempotenta anrop (PATCH, idempotent: true) vid 503", async () => {
    const patch = client([
      () => new Response("", { status: 503 }),
      () => new Response("{}", { status: 200 }),
    ]);
    await patch.api.request("PATCH", "/x", { body: {} });
    expect(patch.calls).toHaveLength(2);
    const query = client([
      () => new Response("", { status: 502 }),
      () => new Response("[]", { status: 201 }),
    ]);
    await query.api.request("POST", "/database/query", { body: {}, idempotent: true });
    expect(query.calls).toHaveLength(2);
  });

  it("har en tidsgräns per anrop", async () => {
    const { log } = capture();
    const api = createApiClient({
      service: "Test",
      baseUrl: "https://api.example.com",
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
      log,
      dryRun: false,
      sleep: async () => {},
      retries: 0,
      timeoutMs: 20,
    });
    await expect(api.request("POST", "/hang", { body: {} })).rejects.toThrow(
      /inget svar inom 20 ms/,
    );
  });

  it("vägrar ändrande anrop i dry-run", async () => {
    const { api, calls } = client([], true);
    await expect(api.request("POST", "/w", { body: {} })).rejects.toBeInstanceOf(DryRunViolation);
    await expect(api.request("PATCH", "/w")).rejects.toBeInstanceOf(DryRunViolation);
    expect(calls).toHaveLength(0);
  });
});

describe("argument", () => {
  const env = { SUPABASE_ACCESS_TOKEN: "sbp_x", VERCEL_TOKEN: "v" };

  it("tolkar flaggor och e-post", () => {
    const o = buildOptions(
      parseArgs([
        "--dry-run",
        "--agare=Agare@Exempel.se",
        "--app-url",
        "https://app.binderlab.se/",
        "--vercel-team",
        "thekinghim",
      ]),
      env,
      ["supabase", "vercel", "invite"],
    );
    expect(o).toMatchObject({
      dryRun: true,
      ownerEmail: "agare@exempel.se",
      appUrl: "https://app.binderlab.se",
      vercelTeam: "thekinghim",
      inviteTarget: "production",
    });
  });

  it("tar e-post som första argument (invite-owner.ts)", () => {
    expect(
      buildOptions(parseArgs(["a@b.se", "--miljo", "preview"]), env, ["invite"]),
    ).toMatchObject({
      ownerEmail: "a@b.se",
      inviteTarget: "preview",
    });
  });

  it("för vidare valfria värden från miljön", () => {
    const o = buildOptions(
      parseArgs([]),
      { ...env, RESEND_API_KEY: "re_x", MAIL_FROM: "a@b.se", OTHER: "x" },
      ["vercel"],
    );
    expect(o.passthrough).toEqual({ RESEND_API_KEY: "re_x", MAIL_FROM: "a@b.se" });
  });

  it("nekar felaktiga värden med svenska meddelanden", () => {
    expect(() => parseArgs(["--okand"])).toThrow(UsageError);
    expect(() => parseArgs(["--agare"])).toThrow(/--agare saknar värde/);
    expect(() => buildOptions(parseArgs(["--agare", "inte-epost"]), env, ["invite"])).toThrow(
      /Ogiltig e-post/,
    );
    expect(() => buildOptions(parseArgs(["--app-url", "http://x.se"]), env, ["vercel"])).toThrow(
      /https/,
    );
    expect(() =>
      buildOptions(parseArgs(["--force-deploy", "--skip-deploy"]), env, ["vercel"]),
    ).toThrow(/kombinera/);
    expect(() => buildOptions(parseArgs(["--miljo", "test"]), env, ["invite"])).toThrow(
      /production eller preview/,
    );
  });
});

describe("Supabase-hjälpare", () => {
  it("bygger DATABASE_URL mot poolerns port 6543", () => {
    expect(
      databaseUrl(
        {
          host: "aws-1-eu-north-1.pooler.supabase.com",
          user: "postgres.abc",
          database: "postgres",
        },
        "p@ss/ord",
      ),
    ).toBe(
      "postgresql://postgres.abc:p%40ss%2Ford@aws-1-eu-north-1.pooler.supabase.com:6543/postgres",
    );
  });

  it("migreringsfrågan låser, kontrollerar, kör och bokför", () => {
    const q = migrationQuery({
      version: "20261102100000",
      name: "a",
      file: "20261102100000_a.sql",
      sql: "select 1;",
    });
    expect(q.split("\n")[0]).toBe("select pg_advisory_xact_lock(7342001::bigint);");
    expect(q).toContain("where version = '20261102100000'");
    expect(
      q.trim().endsWith("values ('20261102100000', 'a', array[$bl_mig$select 1;$bl_mig$]);"),
    ).toBe(true);
    expect(() => migrationQuery({ version: "x", name: "a", file: "x", sql: "" })).toThrow(
      /Ogiltigt/,
    );
    expect(dollarTag("$bl_mig$ $bl_mig1$")).toBe("$bl_mig2$");
  });

  it("auth: lägger till omdirigeringar utan att ta bort befintliga och ändrar bara det som skiljer", () => {
    const current = {
      uri_allow_list: "https://annan.se/**",
      site_url: "https://app.binderlab.se",
      disable_signup: true,
    };
    const desired = desiredAuthConfig(current, {
      siteUrl: "https://app.binderlab.se",
      redirectUrls: ["https://app.binderlab.se/**"],
      smtp: null,
    });
    expect(desired.uri_allow_list).toBe("https://annan.se/**,https://app.binderlab.se/**");
    const diff = authConfigDiff(current, desired);
    expect(diff.disable_signup).toBeUndefined();
    expect(diff.site_url).toBeUndefined();
    // Utan SMTP (Supabase Free) rörs mallarna inte; appen tar emot standardmallens ?code=.
    expect(Object.keys(diff)).not.toContain("mailer_templates_invite_content");
    const withSmtp = desiredAuthConfig(current, {
      siteUrl: "https://app.binderlab.se",
      redirectUrls: [],
      smtp: {
        host: "smtp.resend.com",
        port: 465,
        user: "resend",
        pass: "x",
        adminEmail: "a@b.se",
        senderName: "Binderlab",
      },
    });
    expect(Object.keys(withSmtp)).toContain("mailer_templates_invite_content");
  });

  it("auth: rensar främmande *.vercel.app-poster och site_url när projektets värdar är kända", () => {
    const current = {
      site_url: "https://binderlab.vercel.app",
      uri_allow_list:
        "https://binderlab.vercel.app/**,https://*-x.vercel.app/**,https://app.binderlab.se/**,https://binderlab-team.vercel.app/**",
    };
    const pruned = desiredAuthConfig(current, {
      siteUrl: undefined,
      redirectUrls: [],
      ownVercelHosts: ["binderlab-team.vercel.app"],
      smtp: null,
    });
    // Egna domäner och projektets egen *.vercel.app ligger kvar; främmande och jokertecken tas bort.
    expect(pruned.uri_allow_list).toBe(
      "https://app.binderlab.se/**,https://binderlab-team.vercel.app/**",
    );
    expect(pruned.site_url).toBe("http://localhost:3000");
    // Utan kända värdar rörs inget, och utan siteUrl lämnas site_url.
    const untouched = desiredAuthConfig(current, {
      siteUrl: undefined,
      redirectUrls: [],
      smtp: null,
    });
    expect(untouched.uri_allow_list).toBe(current.uri_allow_list);
    expect(untouched.site_url).toBeUndefined();
    // dropRedirects tar bort exakta poster.
    expect(
      desiredAuthConfig(
        { uri_allow_list: "https://*-t.vercel.app/**,https://a.se/**" },
        {
          siteUrl: undefined,
          redirectUrls: [],
          dropRedirects: ["https://*-t.vercel.app/**"],
          smtp: null,
        },
      ).uri_allow_list,
    ).toBe("https://a.se/**");
  });

  it("Resend som SMTP tolkar avsändaren", () => {
    expect(
      resendSmtp({ RESEND_API_KEY: "re_1", MAIL_FROM: "Binderlab <rapporter@binderlab.se>" }),
    ).toMatchObject({
      host: "smtp.resend.com",
      port: 465,
      user: "resend",
      adminEmail: "rapporter@binderlab.se",
      senderName: "Binderlab",
    });
    expect(resendSmtp({ MAIL_FROM: "x@y.se" })).toBeNull();
  });
});

describe("hemligheter", () => {
  it("genererar starka, URL-säkra värden", () => {
    const a = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generatePassword()).not.toBe(a);
    expect(generateCronSecret().length).toBeGreaterThanOrEqual(64);
    expect(fingerprint("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("skripten skriver inga filer (ingen loggfil, inga hemligheter på disk)", async () => {
    const dir = path.resolve(__dirname, "../../scripts/deploy");
    const files: string[] = [];
    for (const entry of await readdir(dir, { recursive: true })) {
      if (String(entry).endsWith(".ts")) files.push(path.join(dir, String(entry)));
    }
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(
        /writeFile|appendFile|createWriteStream|fs\.write|console\.(log|info|debug)\(/,
      );
    }
  });
});
