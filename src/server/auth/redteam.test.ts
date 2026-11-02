/**
 * Röda laget: attacktester mot inloggningen (granskning av fas 2-auth).
 *
 * Konvention:
 * - `it(...)`        = attacken stoppas i dag (regressionsskydd).
 * - `it("TÄPPT: …")` = ett hål som granskningen hittade (tidigare `hole(...)`,
 *   dvs. it.fails) och som nu är åtgärdat. Testet beskriver det säkra
 *   beteendet och är ett vanligt regressionstest.
 * - Nya kända hål kan läggas till som `it.fails` med samma konvention.
 *
 * Inga nätverksanrop och ingen databas: `@/db/client` ersätts av en fejk som
 * registrerar claims och SQL, och Supabase nås via en stubbad fetch.
 */

import {
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
} from "jose";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fejkad databas (vi.mock hissas upp före importerna nedan)
// ---------------------------------------------------------------------------

const fakeDb = vi.hoisted(() => ({
  claims: [] as { sub: string; email?: string }[],
  queries: [] as string[],
  handler: (() => []) as (query: { sql: string; params: unknown[] }) => unknown[],
  serviceDbUsed: 0,
}));

vi.mock("@/db/client", async () => {
  const { PgDialect: Dialect } = await import("drizzle-orm/pg-core");
  const dialect = new Dialect();
  const tx = {
    execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const q = dialect.sqlToQuery(query);
      fakeDb.queries.push(q.sql);
      return fakeDb.handler(q);
    },
  };
  return {
    withRls: async (
      claims: { sub: string; email?: string },
      fn: (t: typeof tx) => Promise<unknown>,
    ) => {
      fakeDb.claims.push(claims);
      return fn(tx);
    },
    getServiceDb: () => {
      fakeDb.serviceDbUsed += 1;
      return tx;
    },
  };
});

import { isLocalDatabaseUrl, parseServerEnv, resetServerEnvCache } from "@/lib/env";
import { proxy } from "@/proxy";

import { getRoleFor, requireRoleFor, resolveActiveOrganization } from "../access";
import { createRateLimiter } from "../rate-limit";
import { clientIp, resolveAppBaseUrl } from "../request-info";
import { verifyServerStartup } from "../startup";
import { assertDevAuthAllowed, DevAuthForbiddenError } from "./dev-guard";
import { DevAuthProvider } from "./dev-provider";
import {
  ACTIVE_ORG_COOKIE,
  acceptInviteFlow,
  activeOrgCookieOptions,
  createInviteFlow,
  loginFlow,
  logoutFlow,
  MESSAGES,
  switchOrganizationFlow,
} from "./flows";
import { hashPassword } from "./password";
import { isPublicPath, loginRedirectPath, safeRedirectPath } from "./paths";
import { DEV_SESSION_COOKIE, signDevSession, verifyDevSession } from "./session-token";
import { createSupabaseJwtVerifier, supabaseIssuer } from "./supabase-jwt";
import { SupabaseAuthProvider } from "./supabase-provider";
import { MemoryCookieJar, type AuthProvider, type AuthSession, type SignInResult } from "./types";

// ---------------------------------------------------------------------------
// Gemensamt
// ---------------------------------------------------------------------------

const SECRET = "r".repeat(48);
const OTHER_SECRET = "x".repeat(48);
const LOCAL_DB = "postgres://postgres@127.0.0.1:54322/binderlab_dev";
const REMOTE_DB = "postgresql://postgres:pw@db.ukuuwokxbtwhqfnttzwr.supabase.co:5432/postgres";
const ANNA: AuthSession = {
  userId: "0f0e0d0c-0b0a-4908-8706-050403020100",
  email: "anna@example.se",
};
const EVE: AuthSession = {
  userId: "e0e0e0e0-0000-4000-8000-00000000eeee",
  email: "eve@example.se",
};
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVITE_TOKEN = "ab".repeat(32);

const b64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");

function devEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_ENV: "development",
    DATABASE_URL: LOCAL_DB,
    DEV_AUTH_SECRET: SECRET,
    ...overrides,
  };
}

function devProvider(options: { db?: () => unknown; cookies?: MemoryCookieJar } = {}) {
  return new DevAuthProvider({
    env: devEnv(),
    cookies: options.cookies ?? new MemoryCookieJar(),
    db: (options.db ??
      (() => {
        throw new Error("databasen ska inte användas");
      })) as never,
    log: () => {},
  });
}

beforeEach(() => {
  fakeDb.claims = [];
  fakeDb.queries = [];
  fakeDb.handler = () => [];
  fakeDb.serviceDbUsed = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetServerEnvCache();
});

// ===========================================================================
// 1. Dev-inloggningen i preview/production
// ===========================================================================

describe("1. Aktivera DevAuthProvider utanför lokal utveckling", () => {
  it("miljövalideringen nekar AUTH_PROVIDER=dev i preview och production", () => {
    for (const APP_ENV of ["preview", "production"]) {
      expect(() =>
        parseServerEnv({
          ...devEnv({ APP_ENV }),
          AUTH_PROVIDER: "dev",
          APP_URL: "https://app.binderlab.se",
        }),
      ).toThrow(/dev är bara tillåtet när APP_ENV=development/);
    }
  });

  it("NODE_ENV=production utan APP_ENV faller inte tillbaka till dev-inloggning", () => {
    expect(() =>
      parseServerEnv({ NODE_ENV: "production", DATABASE_URL: LOCAL_DB, DEV_AUTH_SECRET: SECRET }),
    ).toThrow(/APP_ENV/);
    expect(() =>
      verifyServerStartup({
        NODE_ENV: "production",
        AUTH_PROVIDER: "dev",
        DATABASE_URL: LOCAL_DB,
        DEV_AUTH_SECRET: SECRET,
      }),
    ).toThrow(DevAuthForbiddenError);
  });

  it("konstruktorn kastar i preview/production och mot fjärrdatabaser", () => {
    const bad: Record<string, string | undefined>[] = [
      { APP_ENV: "production" },
      { APP_ENV: "preview" },
      { APP_ENV: "Development" },
      { APP_ENV: " development" },
      { APP_ENV: undefined },
      { DATABASE_URL: REMOTE_DB },
      { DATABASE_URL: "postgres://postgres@127.0.0.1.nip.io:5432/db" },
      { DATABASE_URL: "postgres://postgres@localhost.evil.example/db" },
      { DATABASE_URL: "postgres://localhost@db.evil.example/db" },
      { DATABASE_URL: "postgres://localhost:pw@db.evil.example:5432/db" },
      { DATABASE_URL: "postgres://localhost,db.evil.example/db" },
      { DATABASE_URL: "postgres:///db" },
      { DATABASE_URL: undefined },
    ];
    for (const overrides of bad) {
      expect(
        () =>
          new DevAuthProvider({
            env: devEnv(overrides),
            cookies: new MemoryCookieJar(),
            db: (() => null) as never,
          }),
        JSON.stringify(overrides),
      ).toThrow();
    }
  });

  it("startkontrollen stoppar dev-inloggning i production även om resten av miljön är fel", () => {
    expect(() =>
      verifyServerStartup({ APP_ENV: "production", AUTH_PROVIDER: "dev", DATABASE_URL: LOCAL_DB }),
    ).toThrow(DevAuthForbiddenError);
  });

  it("postgres.js ansluter till ?host= i stället för värden i adressen (bakgrund till nästa test)", async () => {
    const url = "postgres://postgres@localhost:54322/db?host=db.ukuuwokxbtwhqfnttzwr.supabase.co";
    const client = postgres(url);
    try {
      expect(client.options.host).toEqual(["db.ukuuwokxbtwhqfnttzwr.supabase.co"]);
    } finally {
      await client.end();
    }
    // Före åtgärden såg spärren bara "localhost" (true). Nu tolkas adressen
    // som postgres.js gör, och ?host= gör den tvetydig.
    expect(isLocalDatabaseUrl(url)).toBe(false);
  });

  // HÅL 1 (medel): spärren tittar på URL:ens hostname, men postgres.js följer
  // ?host=. En DATABASE_URL som "ser lokal ut" kan peka på produktionsdatabasen.
  it("TÄPPT: spärren nekar en lokal-utseende URL som ansluter till en fjärrvärd via ?host=", () => {
    expect(() =>
      assertDevAuthAllowed({
        APP_ENV: "development",
        DATABASE_URL:
          "postgres://postgres@localhost:54322/db?host=db.ukuuwokxbtwhqfnttzwr.supabase.co",
      }),
    ).toThrow(DevAuthForbiddenError);
  });

  // HÅL 2 (låg, härdning): spärren bryr sig inte om NODE_ENV eller VERCEL.
  // `next start` (NODE_ENV=production) med APP_ENV=development och en lokal
  // databas (t.ex. egen server med Postgres på samma maskin) slår på dev-inloggningen.
  it("TÄPPT: dev-inloggningen spärras när NODE_ENV=production eller VERCEL=1", () => {
    for (const extra of [{ NODE_ENV: "production" }, { VERCEL: "1" }]) {
      expect(() =>
        verifyServerStartup({
          ...extra,
          APP_ENV: "development",
          AUTH_PROVIDER: "dev",
          DATABASE_URL: LOCAL_DB,
          DEV_AUTH_SECRET: SECRET,
        }),
      ).toThrow(DevAuthForbiddenError);
    }
  });

  it("proxyn i production godtar inte en giltigt signerad dev-cookie", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("AUTH_PROVIDER", "supabase");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("SUPABASE_URL", "https://ukuuwokxbtwhqfnttzwr.supabase.co");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    vi.stubEnv("APP_URL", "https://app.binderlab.se");
    vi.stubEnv("DEV_AUTH_SECRET", SECRET);
    resetServerEnvCache();
    const forged = await signDevSession(ANNA, SECRET);
    const response = await proxy(
      new NextRequest("https://app.binderlab.se/lonsamhet", {
        headers: { cookie: `${DEV_SESSION_COOKIE}=${forged}` },
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://app.binderlab.se/logga-in?next=%2Flonsamhet",
    );
  });
});

// ===========================================================================
// 2. Förfalskade sessions-JWT
// ===========================================================================

describe("2a. Förfalskad dev-sessions-JWT", () => {
  async function forge(
    options: {
      secret?: string;
      alg?: string;
      iss?: string;
      aud?: string;
      sub?: string;
      email?: unknown;
      exp?: number;
      nbf?: number;
      iat?: number | null;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const builder = new SignJWT(
      options.email === undefined ? { email: ANNA.email } : { email: options.email },
    )
      .setProtectedHeader({ alg: options.alg ?? "HS256", typ: "JWT" })
      .setSubject(options.sub ?? ANNA.userId)
      .setIssuer(options.iss ?? "binderlab-dev")
      .setAudience(options.aud ?? "binderlab")
      .setExpirationTime(options.exp ?? now + 3600);
    if (options.iat !== null) {
      builder.setIssuedAt(options.iat ?? now);
    }
    if (options.nbf !== undefined) {
      builder.setNotBefore(options.nbf);
    }
    return builder.sign(new TextEncoder().encode(options.secret ?? SECRET));
  }

  it("kontroll: en korrekt token godtas (så att de negativa testerna betyder något)", async () => {
    expect((await verifyDevSession(await forge(), SECRET)).ok).toBe(true);
  });

  it("alg none (med och utan signaturdel) nekas", async () => {
    const payload = b64url(
      JSON.stringify({
        sub: ANNA.userId,
        email: ANNA.email,
        iss: "binderlab-dev",
        aud: "binderlab",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    for (const alg of ["none", "None", "NONE"]) {
      const header = b64url(JSON.stringify({ alg, typ: "JWT" }));
      for (const token of [`${header}.${payload}.`, `${header}.${payload}`]) {
        expect(await verifyDevSession(token, SECRET)).toEqual({ ok: false, reason: "invalid" });
      }
    }
  });

  it("fel nyckel, HS384/HS512 med rätt nyckel och tom nyckel nekas", async () => {
    expect((await verifyDevSession(await forge({ secret: OTHER_SECRET }), SECRET)).ok).toBe(false);
    expect((await verifyDevSession(await forge({ alg: "HS384" }), SECRET)).ok).toBe(false);
    expect((await verifyDevSession(await forge({ alg: "HS512" }), SECRET)).ok).toBe(false);
    expect(await verifyDevSession(await forge(), "")).toEqual({ ok: false, reason: "invalid" });
  });

  it("RS256-token (HS/RS-förväxling åt andra hållet) nekas", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: ANNA.email })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(ANNA.userId)
      .setIssuer("binderlab-dev")
      .setAudience("binderlab")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    expect((await verifyDevSession(token, SECRET)).ok).toBe(false);
  });

  it("utgången, ännu-inte-giltig, fel issuer och fel audience nekas", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyDevSession(await forge({ exp: now - 1 }), SECRET)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect((await verifyDevSession(await forge({ nbf: now + 3600 }), SECRET)).ok).toBe(false);
    for (const iss of ["binderlab", "https://ukuuwokxbtwhqfnttzwr.supabase.co/auth/v1", ""]) {
      expect((await verifyDevSession(await forge({ iss }), SECRET)).ok, iss).toBe(false);
    }
    for (const aud of ["authenticated", "binderlab-dev", ""]) {
      expect((await verifyDevSession(await forge({ aud }), SECRET)).ok, aud).toBe(false);
    }
  });

  it("saknad iat, sub som inte är uuid och saknad e-post nekas", async () => {
    expect((await verifyDevSession(await forge({ iat: null }), SECRET)).ok).toBe(false);
    for (const sub of ["' or 1=1 --", "00000000-0000-0000-0000-000000000000x", "*"]) {
      expect((await verifyDevSession(await forge({ sub }), SECRET)).ok, sub).toBe(false);
    }
    for (const email of ["", 42, null]) {
      expect((await verifyDevSession(await forge({ email }), SECRET)).ok).toBe(false);
    }
  });

  it("ändrad payload med kvarlämnad signatur nekas (byta sub till en annan användare)", async () => {
    const [header, , signature] = (await forge()).split(".");
    const evil = b64url(
      JSON.stringify({
        sub: EVE.userId,
        email: EVE.email,
        iss: "binderlab-dev",
        aud: "binderlab",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    expect((await verifyDevSession(`${header}.${evil}.${signature}`, SECRET)).ok).toBe(false);
  });

  it("DevAuthProvider.getSession rör inte databasen för en förfalskad cookie", async () => {
    const cookies = new MemoryCookieJar();
    cookies.set(DEV_SESSION_COOKIE, await forge({ secret: OTHER_SECRET }));
    expect(await devProvider({ cookies }).getSession()).toBeNull();
  });

  it("en giltig token för en raderad användare ger ingen session", async () => {
    const cookies = new MemoryCookieJar();
    cookies.set(DEV_SESSION_COOKIE, await signDevSession(ANNA, SECRET));
    const db = () => ({ execute: async () => [] });
    expect(await devProvider({ cookies, db }).getSession()).toBeNull();
  });

  it("e-posten i sessionen kommer från databasen, inte från token", async () => {
    const cookies = new MemoryCookieJar();
    cookies.set(
      DEV_SESSION_COOKIE,
      await signDevSession({ userId: ANNA.userId, email: "admin@binderlab.se" }, SECRET),
    );
    const db = () => ({ execute: async () => [{ email: ANNA.email }] });
    expect(await devProvider({ cookies, db }).getSession()).toEqual(ANNA);
  });
});

describe("2b. Förfalskad Supabase-åtkomsttoken", () => {
  const SUPABASE_URL = "https://ukuuwokxbtwhqfnttzwr.supabase.co";
  const ISSUER = supabaseIssuer(SUPABASE_URL);
  let es: { privateKey: CryptoKey; publicJwk: JWK };
  let rs: { privateKey: CryptoKey; publicJwk: JWK; spki: string };
  let attacker: { privateKey: CryptoKey; publicJwk: JWK };
  let jwks: JSONWebKeySet;

  beforeAll(async () => {
    const e = await generateKeyPair("ES256", { extractable: true });
    const r = await generateKeyPair("RS256", { extractable: true });
    const a = await generateKeyPair("ES256", { extractable: true });
    es = {
      privateKey: e.privateKey,
      publicJwk: { ...(await exportJWK(e.publicKey)), kid: "es-1", alg: "ES256" },
    };
    rs = {
      privateKey: r.privateKey,
      publicJwk: { ...(await exportJWK(r.publicKey)), kid: "rs-1", alg: "RS256" },
      spki: await exportSPKI(r.publicKey),
    };
    attacker = { privateKey: a.privateKey, publicJwk: await exportJWK(a.publicKey) };
    jwks = { keys: [es.publicJwk, rs.publicJwk] };
  });

  const verifier = () =>
    createSupabaseJwtVerifier({ supabaseUrl: SUPABASE_URL, jwks: createLocalJWKSet(jwks) });

  function claims(extra: Record<string, unknown> = {}) {
    return new SignJWT({ email: ANNA.email, role: "authenticated", ...extra })
      .setSubject(ANNA.userId)
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h");
  }

  it("kontroll: en korrekt ES256-token godtas", async () => {
    const token = await claims()
      .setProtectedHeader({ alg: "ES256", kid: "es-1" })
      .sign(es.privateKey);
    expect((await verifier()(token)).ok).toBe(true);
  });

  it("HS256 signerad med RS-nyckelns publika PEM/JWK (klassisk alg-förväxling) nekas", async () => {
    const enc = new TextEncoder();
    for (const secret of [rs.spki, JSON.stringify(rs.publicJwk), rs.publicJwk.n ?? ""]) {
      for (const kid of ["rs-1", undefined]) {
        const token = await claims()
          .setProtectedHeader(kid ? { alg: "HS256", kid } : { alg: "HS256" })
          .sign(enc.encode(secret));
        expect((await verifier()(token)).ok).toBe(false);
      }
    }
  });

  it("HS256 med publishable-nyckeln som hemlighet (äldre Supabase-projekt) nekas", async () => {
    const token = await claims()
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("sb_publishable_test_publishable_key_xxxxxxxxx"));
    expect((await verifier()(token)).ok).toBe(false);
  });

  it("inbäddad jwk-rubrik och jku-rubrik med angriparens nyckel nekas", async () => {
    const embedded = await claims()
      .setProtectedHeader({ alg: "ES256", jwk: attacker.publicJwk })
      .sign(attacker.privateKey);
    expect((await verifier()(embedded)).ok).toBe(false);
    const jku = await claims()
      .setProtectedHeader({ alg: "ES256", kid: "es-1", jku: "https://evil.example/jwks.json" })
      .sign(attacker.privateKey);
    expect((await verifier()(jku)).ok).toBe(false);
  });

  it("service_role, anon-roll, is_anonymous och aud som lista utan authenticated nekas", async () => {
    const sign = (b: SignJWT) =>
      b.setProtectedHeader({ alg: "ES256", kid: "es-1" }).sign(es.privateKey);
    expect((await verifier()(await sign(claims({ role: "service_role" })))).ok).toBe(false);
    expect((await verifier()(await sign(claims({ role: "anon" })))).ok).toBe(false);
    expect((await verifier()(await sign(claims({ is_anonymous: true })))).ok).toBe(false);
    expect((await verifier()(await sign(claims().setAudience(["anon", "service_role"])))).ok).toBe(
      false,
    );
    expect(await verifier()(await sign(claims().setIssuer(`${SUPABASE_URL}/auth/v1/`)))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("en dev-token (HS256, DEV_AUTH_SECRET) godtas inte av Supabase-verifieraren", async () => {
    expect((await verifier()(await signDevSession(ANNA, SECRET))).ok).toBe(false);
  });

  function sessionCookie(accessToken: string): string {
    const now = Math.floor(Date.now() / 1000);
    const session = {
      access_token: accessToken,
      refresh_token: "r-1",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      user: { id: ANNA.userId, email: ANNA.email, aud: "authenticated", role: "authenticated" },
    };
    return `base64-${b64url(JSON.stringify(session))}`;
  }

  it("SupabaseAuthProvider: förfalskad sb-*-auth-token-cookie (egen nyckel / alg none) ger ingen session", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const cookieName = "sb-ukuuwokxbtwhqfnttzwr-auth-token";
    const provider = (value: string) => {
      const cookies = new MemoryCookieJar();
      cookies.set(cookieName, value);
      return new SupabaseAuthProvider({
        env: {
          SUPABASE_URL,
          SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
          SUPABASE_SECRET_KEY: undefined,
          SUPABASE_JWKS_URL: undefined,
        },
        cookies,
        jwks: createLocalJWKSet(jwks),
      });
    };
    // Kontroll: rätt signerad token i samma cookieformat godtas.
    const good = await claims()
      .setProtectedHeader({ alg: "ES256", kid: "es-1" })
      .sign(es.privateKey);
    expect(await provider(sessionCookie(good)).getSession()).toEqual(ANNA);

    const selfSigned = await claims()
      .setProtectedHeader({ alg: "ES256", kid: "es-1" })
      .sign(attacker.privateKey);
    const [, payload] = good.split(".");
    const none = `${b64url(JSON.stringify({ alg: "none" }))}.${payload}.`;
    for (const forged of [selfSigned, none, await signDevSession(ANNA, SECRET)]) {
      expect(await provider(sessionCookie(forged)).getSession()).toBeNull();
    }
  });
});

// ===========================================================================
// 3. requireRole och withUserDb
// ===========================================================================

describe("3. Kringgå requireRole / nå data utan withUserDb", () => {
  function membershipRows(role: string | null) {
    fakeDb.handler = ({ sql }) =>
      sql.includes("from public.memberships") && role !== null ? [{ role }] : [];
  }

  it("organisations-id som inte är uuid (SQL-injektion, tomt, versaler med skräp) nekas utan databasfråga", async () => {
    membershipRows("owner");
    for (const id of ["' or 1=1 --", `${ORG_A}' or '1'='1`, `${ORG_A} `, "", "*", `{${ORG_A}}`]) {
      await expect(requireRoleFor(ANNA, id, ["owner"]), id).rejects.toMatchObject({
        reason: "forbidden",
      });
    }
    expect(fakeDb.queries).toEqual([]);
  });

  it("organisations-id skickas som parameter, aldrig inbakat i SQL", async () => {
    membershipRows("owner");
    await requireRoleFor(ANNA, ORG_A.toUpperCase(), ["owner"]);
    expect(fakeDb.queries.join("\n")).not.toContain(ORG_A);
    expect(fakeDb.queries.join("\n").toLowerCase()).not.toContain(ORG_A.toLowerCase());
  });

  it("fel roll, okänd roll från databasen och tom rollista ger inget tillträde", async () => {
    membershipRows("viewer");
    await expect(requireRoleFor(ANNA, ORG_A, ["owner", "admin"])).rejects.toMatchObject({
      reason: "forbidden",
    });
    membershipRows("superadmin");
    expect(await getRoleFor(ANNA, ORG_A)).toBeNull();
    await expect(requireRoleFor(ANNA, ORG_A, ["owner"])).rejects.toThrow();
    membershipRows(null);
    await expect(requireRoleFor(ANNA, ORG_A, ["viewer"])).rejects.toMatchObject({
      reason: "forbidden",
    });
    await expect(requireRoleFor(ANNA, ORG_A, [])).rejects.toThrow(TypeError);
  });

  it("rollfrågan körs under RLS med claims från den verifierade sessionen, inte som ägare", async () => {
    membershipRows("admin");
    await requireRoleFor(ANNA, ORG_A, ["admin"]);
    expect(fakeDb.claims).toEqual([{ sub: ANNA.userId, email: ANNA.email }]);
    expect(fakeDb.serviceDbUsed).toBe(0);
    expect(fakeDb.queries.join("\n")).toContain("auth.uid()");
  });

  it("en förfalskad bl_org-cookie ger inte en organisation där man inte är medlem", async () => {
    fakeDb.handler = () => [
      { id: ORG_A, name: "A", slug: "a", timezone: "Europe/Stockholm", role: "viewer" },
    ];
    const active = await resolveActiveOrganization(ANNA, ORG_B);
    expect(active?.id).toBe(ORG_A);
  });

  it("switchOrganization till en organisation utan medlemskap nekas och sätter ingen cookie", async () => {
    membershipRows(null);
    const cookies = new MemoryCookieJar();
    const result = await switchOrganizationFlow(
      { user: ANNA, cookies, secureCookies: true },
      ORG_B,
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.notMember });
    expect(cookies.get(ACTIVE_ORG_COOKIE)).toBeUndefined();
    expect(
      await switchOrganizationFlow({ user: null, cookies, secureCookies: true }, ORG_A),
    ).toEqual({ ok: false, error: MESSAGES.notLoggedIn });
  });

  it("en viewer kan inte bjuda in; mejlet skickas aldrig och RPC:n anropas inte", async () => {
    membershipRows("viewer");
    const sendInvite = vi.fn(async () => {});
    const provider = { kind: "dev", sendInvite } as unknown as AuthProvider;
    const result = await createInviteFlow(
      { provider, user: ANNA, baseUrl: "http://localhost:3200" },
      { organizationId: ORG_A, email: "ny@example.se", role: "owner" },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.inviteForbidden });
    expect(sendInvite).not.toHaveBeenCalled();
    expect(fakeDb.queries.some((q) => q.includes("create_invitation"))).toBe(false);
  });

  it("massinbjudan via e-postlista eller rubrikinjektion i adressen nekas av valideringen", async () => {
    membershipRows("owner");
    const sendInvite = vi.fn(async () => {});
    const provider = { kind: "dev", sendInvite } as unknown as AuthProvider;
    for (const email of ["a@example.se,b@example.se", "a@example.se\r\nBcc: x@evil.example"]) {
      const result = await createInviteFlow(
        { provider, user: ANNA, baseUrl: "http://localhost:3200" },
        { organizationId: ORG_A, email, role: "viewer" },
      );
      expect(result.ok, email).toBe(false);
    }
    expect(sendInvite).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Sessionsfixering och inloggnings-CSRF
// ===========================================================================

describe("4. Sessionsfixering", () => {
  it("inloggning ersätter en planterad sessionscookie med en ny, egen token", async () => {
    const hash = await hashPassword("rätt-lösenord-123");
    const cookies = new MemoryCookieJar();
    const planted = await signDevSession(EVE, SECRET);
    cookies.set(DEV_SESSION_COOKIE, planted);
    const db = () => ({
      execute: async () => [{ id: ANNA.userId, email: ANNA.email, encrypted_password: hash }],
    });
    const result = await devProvider({ cookies, db }).signInWithPassword(
      ANNA.email,
      "rätt-lösenord-123",
    );
    expect(result.ok).toBe(true);
    const token = cookies.get(DEV_SESSION_COOKIE);
    expect(token).not.toBe(planted);
    const check = await verifyDevSession(token ?? "", SECRET);
    expect(check.ok && check.session.userId).toBe(ANNA.userId);
  });

  it("misslyckad inloggning lämnar den befintliga sessionen orörd (ingen utloggning via CSRF)", async () => {
    const cookies = new MemoryCookieJar();
    const mine = await signDevSession(ANNA, SECRET);
    cookies.set(DEV_SESSION_COOKIE, mine);
    const db = () => ({ execute: async () => [] });
    await devProvider({ cookies, db }).signInWithPassword(EVE.email, "fel-lösenord-123");
    expect(cookies.get(DEV_SESSION_COOKIE)).toBe(mine);
  });

  it("utloggning tar bort både sessionen och bl_org", async () => {
    const cookies = new MemoryCookieJar();
    cookies.set(DEV_SESSION_COOKIE, await signDevSession(ANNA, SECRET));
    cookies.set(ACTIVE_ORG_COOKIE, ORG_A);
    await logoutFlow({ provider: devProvider({ cookies }), cookies });
    expect(cookies.getAll()).toEqual([]);
  });

  // Känd begränsning (dev): sessions-JWT:n är tillståndslös. En kopierad token
  // gäller i 7 dagar även efter utloggning. Supabase har samma sak för
  // åtkomsttoken (upp till 1 h), se rapporten.
  it("dokumenterat: en kopierad dev-token gäller fortfarande efter utloggning", async () => {
    const cookies = new MemoryCookieJar();
    const token = await signDevSession(ANNA, SECRET);
    cookies.set(DEV_SESSION_COOKIE, token);
    await devProvider({ cookies }).signOut();
    expect((await verifyDevSession(token, SECRET)).ok).toBe(true);
  });

  // HÅL 3 (medel): acceptInvite byter token_hash mot en session INNAN
  // inbjudan kontrolleras. En angripare skickar offret en länk
  // /inbjudan/<valfri 64-hex>?token_hash=<angriparens egen magiclink>&type=magiclink.
  // Offret loggas in som angriparen (inloggnings-CSRF) och kan sedan mata in
  // uppgifter (eller ett nytt lösenord) i angriparens konto, även om
  // accept_invitation misslyckas.
  it("TÄPPT: en misslyckad acceptInvite lämnar ingen ny session efter sig", async () => {
    const cookies = new MemoryCookieJar();
    const provider = {
      kind: "supabase",
      completeEmailLink: async () => {
        cookies.set("sb-ukuuwokxbtwhqfnttzwr-auth-token", "angriparens-session");
        return EVE;
      },
      setPassword: vi.fn(async () => {}),
    } as unknown as AuthProvider;
    fakeDb.handler = ({ sql }) => {
      if (sql.includes("accept_invitation")) {
        throw Object.assign(new Error("Inbjudan finns inte."), {
          code: "BL010",
          severity: "ERROR",
        });
      }
      return [];
    };
    const result = await acceptInviteFlow(
      { provider, user: null, cookies, secureCookies: true },
      {
        token: INVITE_TOKEN,
        emailTokenHash: "angriparens_magiclink_hash",
        emailLinkType: "magiclink",
      },
    );
    expect(result.ok).toBe(false);
    expect(cookies.getAll()).toEqual([]);
  });

  it("dev: acceptInvite med en okänd inbjudan skapar inget konto och ingen session", async () => {
    const cookies = new MemoryCookieJar();
    const registerInvitedUser = vi.fn(async (): Promise<SignInResult> => ({
      ok: true,
      session: EVE,
    }));
    const provider = { kind: "dev", registerInvitedUser } as unknown as AuthProvider;
    const result = await acceptInviteFlow(
      {
        provider,
        user: null,
        cookies,
        secureCookies: false,
        describe: async () => ({ status: "missing" }),
      },
      { token: INVITE_TOKEN, password: "ett-långt-lösenord" },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.invitationMissing });
    expect(registerInvitedUser).not.toHaveBeenCalled();
    expect(cookies.getAll()).toEqual([]);
  });
});

// ===========================================================================
// 5. Öppen omdirigering (?next=)
// ===========================================================================

describe("5. Öppen omdirigering i inloggningen", () => {
  it("klassiska varianter stoppas", () => {
    for (const next of [
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/\t/evil.example",
      "/\n/evil.example",
      " //evil.example",
      "http:/evil.example",
      "/logga-in?next=//evil.example",
      ["/"],
      { toString: () => "//evil.example" },
    ]) {
      const result = safeRedirectPath(next);
      expect(result.startsWith("//"), JSON.stringify(next)).toBe(false);
      expect(result.startsWith("/"), JSON.stringify(next)).toBe(true);
    }
  });

  it("kodade snedstreck förblir en lokal sökväg", () => {
    expect(safeRedirectPath("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
    expect(safeRedirectPath("/%5Cevil.example")).toBe("/%5Cevil.example");
  });

  // HÅL 4 (medel): kontrollen görs på indata, men det som returneras är den
  // NORMALISERADE sökvägen. Punktsegment kollapsar till "//evil.example",
  // som webbläsaren tolkar som en protokollrelativ adress till en annan värd.
  // /logga-in?next=/.//evil.example skickar offret till evil.example efter
  // en lyckad inloggning (nätfiske med äkta inloggningssida).
  it("TÄPPT: punktsegment kan inte normaliseras till //evil.example", () => {
    for (const next of [
      "/.//evil.example",
      "/%2e//evil.example",
      "/%2E%2E//evil.example",
      "/a/..//evil.example",
      "/..//evil.example?x=1",
    ]) {
      expect(safeRedirectPath(next), next).not.toMatch(/^\/\//);
    }
  });

  it("proxyns next-parameter kan inte bära en extern adress", () => {
    expect(loginRedirectPath("//evil.example")).toBe("/logga-in");
    expect(loginRedirectPath("/lonsamhet", "?vy=butik")).toBe(
      "/logga-in?next=%2Flonsamhet%3Fvy%3Dbutik",
    );
  });
});

// ===========================================================================
// 6. Läcker om en e-postadress finns
// ===========================================================================

describe("6. Uppräkning av e-postadresser", () => {
  function counting(result: SignInResult) {
    const calls: string[] = [];
    const provider = {
      kind: "dev",
      signInWithPassword: async (email: string) => {
        calls.push(email);
        return result;
      },
    } as unknown as AuthProvider;
    return { provider, calls };
  }

  it("okänd adress och fel lösenord ger exakt samma svar", async () => {
    const hash = await hashPassword("rätt-lösenord-123");
    const dbFor = (exists: boolean) => () => ({
      execute: async () =>
        exists ? [{ id: ANNA.userId, email: ANNA.email, encrypted_password: hash }] : [],
    });
    const limiter = createRateLimiter({ limit: 100, windowMs: 60_000 });
    const known = await loginFlow(
      { provider: devProvider({ db: dbFor(true) }), limiter, ip: "1.1.1.1" },
      { email: ANNA.email, password: "fel-lösenord-123" },
    );
    const unknown = await loginFlow(
      { provider: devProvider({ db: dbFor(false) }), limiter, ip: "1.1.1.1" },
      { email: "finns-inte@example.se", password: "fel-lösenord-123" },
    );
    const noPassword = await loginFlow(
      {
        provider: devProvider({
          db: () => ({
            execute: async () => [{ id: EVE.userId, email: EVE.email, encrypted_password: null }],
          }),
        }),
        limiter,
        ip: "1.1.1.1",
      },
      { email: EVE.email, password: "fel-lösenord-123" },
    );
    expect(known).toEqual({ ok: false, error: MESSAGES.loginInvalid });
    expect(unknown).toEqual(known);
    expect(noPassword).toEqual(known);
  });

  it("svarstiden för en okänd adress är av samma storleksordning (scrypt körs ändå)", async () => {
    const hash = await hashPassword("rätt-lösenord-123");
    const known = devProvider({
      db: () => ({
        execute: async () => [{ id: ANNA.userId, email: ANNA.email, encrypted_password: hash }],
      }),
    });
    const unknown = devProvider({ db: () => ({ execute: async () => [] }) });
    await unknown.signInWithPassword("värm@upp.se", "x"); // skapar dummyhashen
    const time = async (p: DevAuthProvider) => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        await p.signInWithPassword("x@example.se", "fel-lösenord-123");
        samples.push(performance.now() - start);
      }
      return samples.sort((a, b) => a - b)[1] ?? 0;
    };
    const tKnown = await time(known);
    const tUnknown = await time(unknown);
    expect(tUnknown).toBeGreaterThan(tKnown * 0.3);
  });

  it("spärren efter för många försök ser likadan ut för befintliga och okända adresser", async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const { provider } = counting({ ok: false, reason: "invalid_credentials" });
    const run = (email: string) =>
      loginFlow({ provider, limiter, ip: "9.9.9.9" }, { email, password: "fel-lösenord-123" });
    for (const email of ["anna@example.se", "finns-inte@example.se"]) {
      await run(email);
      await run(email);
    }
    expect((await run("anna@example.se")).error).toBe((await run("finns-inte@example.se")).error);
  });
});

// ===========================================================================
// 7. Cookie-flaggor
// ===========================================================================

describe("7. Cookie-flaggor", () => {
  it("dev-sessionen: httpOnly, SameSite=Lax, path=/, 7 dagar", async () => {
    const hash = await hashPassword("rätt-lösenord-123");
    const cookies = new MemoryCookieJar();
    const db = () => ({
      execute: async () => [{ id: ANNA.userId, email: ANNA.email, encrypted_password: hash }],
    });
    await devProvider({ cookies, db }).signInWithPassword(ANNA.email, "rätt-lösenord-123");
    expect(cookies.optionsFor(DEV_SESSION_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
  });

  it("bl_org: httpOnly och Secure utanför development", () => {
    expect(activeOrgCookieOptions(true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
  });

  // HÅL 5 (medel): @supabase/ssr sätter som standard httpOnly=false och inget
  // Secure. Appen har ingen webbläsarklient (createBrowserClient används inte),
  // så sessionscookien kan vara httpOnly. Utan det kan en XSS läsa
  // refresh-token och ta över kontot permanent; utan Secure kan cookien
  // skickas över http.
  it("TÄPPT: Supabase-sessionens cookie är httpOnly och Secure", async () => {
    const SUPABASE_URL = "https://ukuuwokxbtwhqfnttzwr.supabase.co";
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }] };
    const accessToken = await new SignJWT({ email: ANNA.email, role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject(ANNA.userId)
      .setIssuer(supabaseIssuer(SUPABASE_URL))
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/auth/v1/token")) {
          return Response.json({
            access_token: accessToken,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_token: "refresh-1",
            user: {
              id: ANNA.userId,
              email: ANNA.email,
              aud: "authenticated",
              role: "authenticated",
            },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const cookies = new MemoryCookieJar();
    const provider = new SupabaseAuthProvider({
      env: {
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        SUPABASE_SECRET_KEY: undefined,
        SUPABASE_JWKS_URL: undefined,
      },
      cookies,
      jwks: createLocalJWKSet(jwks),
    });
    const result = await provider.signInWithPassword(ANNA.email, "rätt-lösenord-123");
    expect(result.ok).toBe(true);
    const names = cookies.getAll().map((c) => c.name);
    expect(names.some((n) => n.startsWith("sb-ukuuwokxbtwhqfnttzwr-auth-token"))).toBe(true);
    for (const name of names) {
      expect(cookies.optionsFor(name), name).toMatchObject({ httpOnly: true, secure: true });
    }
  });
});

// ===========================================================================
// 8. Begränsning av inloggningsförsök
// ===========================================================================

describe("8. Rate limit", () => {
  function slowProvider(delayMs = 5) {
    const calls: string[] = [];
    const provider = {
      kind: "dev",
      signInWithPassword: async (email: string): Promise<SignInResult> => {
        calls.push(email);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { ok: false, reason: "invalid_credentials" };
      },
    } as unknown as AuthProvider;
    return { provider, calls };
  }
  const limiter = () => createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
  const attempt = { email: "anna@example.se", password: "gissning-123456" };

  it("sjätte försöket i följd från samma IP stoppas innan providern anropas", async () => {
    const { provider, calls } = slowProvider(0);
    const l = limiter();
    for (let i = 0; i < 8; i += 1) {
      await loginFlow({ provider, limiter: l, ip: "1.2.3.4" }, attempt);
    }
    expect(calls).toHaveLength(5);
  });

  it("versaler och mellanslag i e-postadressen ger inte nya försök", async () => {
    const { provider, calls } = slowProvider(0);
    const l = limiter();
    for (const email of [
      "anna@example.se",
      "ANNA@example.se",
      " Anna@Example.se ",
      "anna@EXAMPLE.SE",
    ]) {
      for (let i = 0; i < 2; i += 1) {
        await loginFlow({ provider, limiter: l, ip: "1.2.3.4" }, { ...attempt, email });
      }
    }
    expect(calls).toHaveLength(5);
  });

  // HÅL 6 (hög): kontroll och räkning är inte atomära. Kontrollen görs före
  // det långsamma lösenordsanropet och räkningen efter, så parallella
  // förfrågningar passerar alla kontrollen innan någon har räknats.
  it("TÄPPT: 50 parallella försök kommer inte förbi gränsen på 5", async () => {
    const { provider, calls } = slowProvider(20);
    const l = limiter();
    await Promise.all(
      Array.from({ length: 50 }, () => loginFlow({ provider, limiter: l, ip: "1.2.3.4" }, attempt)),
    );
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  // HÅL 7 (medel): nyckeln är IP|e-post och det finns ingen gräns per konto.
  // Ett botnät (eller förfalskad x-forwarded-for utanför Vercel) får 5 nya
  // gissningar per IP mot samma konto.
  it("TÄPPT: ett konto spärras efter många misslyckanden oavsett IP", async () => {
    const { provider, calls } = slowProvider(0);
    const l = limiter();
    for (let i = 0; i < 100; i += 1) {
      await loginFlow(
        { provider, limiter: l, ip: `10.0.${Math.floor(i / 250)}.${i % 250}` },
        attempt,
      );
    }
    expect(calls.length).toBeLessThanOrEqual(20);
  });

  // HÅL 8 (medel): när minnet når maxKeys (10 000) tas den ÄLDSTA nyckeln
  // bort. Ogiltiga e-postadresser räknas utan något lösenordsanrop, så 10 000
  // billiga skräpförsök raderar offrets räknare och ger 5 nya gissningar.
  it("TÄPPT: skräpförsök kan inte radera räknaren för ett annat konto", async () => {
    const { provider, calls } = slowProvider(0);
    const l = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
    const ctx = { provider, limiter: l, ip: "1.2.3.4" };
    for (let i = 0; i < 5; i += 1) {
      await loginFlow(ctx, attempt);
    }
    for (let i = 0; i < 10_000; i += 1) {
      await loginFlow(ctx, { email: `skrap${i}`, password: "x" });
    }
    for (let i = 0; i < 5; i += 1) {
      await loginFlow(ctx, attempt);
    }
    expect(calls).toHaveLength(5);
  });

  it("x-forwarded-for: klientens påhittade första värde används inte, bara det sista hoppet", () => {
    const headers = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(clientIp(headers)).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "x".repeat(100) }))).toBe("okänd");
  });
});

// ===========================================================================
// 9. Övrigt: Host-rubrik, öppna sökvägar, konfiguration
// ===========================================================================

describe("9. Övrigt", () => {
  it("inbjudningslänkar i production byggs från APP_URL, aldrig från en förfalskad Host", () => {
    const headers = new Headers({ host: "evil.example", "x-forwarded-host": "evil.example" });
    expect(
      resolveAppBaseUrl(
        {
          APP_ENV: "production",
          APP_URL: "https://app.binderlab.se",
          VERCEL_BRANCH_URL: undefined,
          VERCEL_URL: undefined,
        },
        headers,
      ),
    ).toBe("https://app.binderlab.se");
    expect(() =>
      resolveAppBaseUrl(
        {
          APP_ENV: "preview",
          APP_URL: undefined,
          VERCEL_BRANCH_URL: undefined,
          VERCEL_URL: undefined,
        },
        headers,
      ),
    ).toThrow();
  });

  it("öppna sökvägar: inloggnings- och inbjudningssidor, inget annat av appen", () => {
    for (const path of [
      "/",
      "/lonsamhet",
      "/inkopspriser",
      "/installningar",
      "/logga-inx",
      "/inbjudan",
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  // HÅL 9 (låg): "/design" matchas som prefix, så alla framtida rutter som
  // börjar på /design (t.ex. /designer, /design-export) blir öppna i proxyn.
  // /rapport/* är också helt öppen; fas 6-rapporterna måste skydda sig själva
  // (signerad token) om de hamnar där.
  it("TÄPPT: bara /design och /design/* är öppna, inte allt som börjar på /design", () => {
    expect(isPublicPath("/designer-admin")).toBe(false);
  });

  // HÅL 10 (låg, härdning): http:// godtas för SUPABASE_URL och
  // SUPABASE_JWKS_URL i production. Nycklarna som verifierar alla sessioner
  // skulle då hämtas okrypterat.
  it("TÄPPT: production kräver https för SUPABASE_URL och SUPABASE_JWKS_URL", () => {
    expect(() =>
      parseServerEnv({
        APP_ENV: "production",
        AUTH_PROVIDER: "supabase",
        DATABASE_URL: REMOTE_DB,
        SUPABASE_URL: "http://ukuuwokxbtwhqfnttzwr.supabase.co",
        SUPABASE_JWKS_URL: "http://ukuuwokxbtwhqfnttzwr.supabase.co/auth/v1/.well-known/jwks.json",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        SUPABASE_SECRET_KEY: "sb_secret_test",
        APP_URL: "https://app.binderlab.se",
      }),
    ).toThrow();
  });
});
