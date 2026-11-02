import { describe, expect, it } from "vitest";

import {
  databaseUrlHosts,
  EnvError,
  isLocalDatabaseUrl,
  parseClientEnv,
  parseServerEnv,
  type EnvSource,
} from "@/lib/env";

const DEV_SECRET = "d".repeat(40);

const devEnv: EnvSource = {
  APP_ENV: "development",
  AUTH_PROVIDER: "dev",
  DATABASE_URL: "postgres://postgres@127.0.0.1:54322/binderlab_dev",
  DEV_AUTH_SECRET: DEV_SECRET,
};

const prodEnv: EnvSource = {
  APP_ENV: "production",
  AUTH_PROVIDER: "supabase",
  DATABASE_URL: "postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres",
  SUPABASE_URL: "https://ukuuwokxbtwhqfnttzwr.supabase.co/",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc",
  SUPABASE_SECRET_KEY: "sb_secret_abc",
  APP_URL: "https://app.binderlab.se/",
};

function issuesOf(source: EnvSource): readonly string[] {
  try {
    parseServerEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as EnvError).issues;
  }
  throw new Error("Förväntade EnvError");
}

describe("parseServerEnv", () => {
  it("godtar en lokal dev-miljö", () => {
    const env = parseServerEnv(devEnv);
    expect(env.APP_ENV).toBe("development");
    expect(env.AUTH_PROVIDER).toBe("dev");
    expect(env.DEV_AUTH_SECRET).toBe(DEV_SECRET);
  });

  it("standard utan APP_ENV/AUTH_PROVIDER är development + dev (utom när NODE_ENV=production)", () => {
    const env = parseServerEnv({ DATABASE_URL: devEnv.DATABASE_URL, DEV_AUTH_SECRET: DEV_SECRET });
    expect(env.APP_ENV).toBe("development");
    expect(env.AUTH_PROVIDER).toBe("dev");
    expect(issuesOf({ NODE_ENV: "production", DATABASE_URL: devEnv.DATABASE_URL })).toContain(
      "APP_ENV: saknas",
    );
  });

  it("godtar production med Supabase och härleder JWKS-adressen", () => {
    const env = parseServerEnv(prodEnv);
    expect(env.SUPABASE_URL).toBe("https://ukuuwokxbtwhqfnttzwr.supabase.co");
    expect(env.SUPABASE_JWKS_URL).toBe(
      "https://ukuuwokxbtwhqfnttzwr.supabase.co/auth/v1/.well-known/jwks.json",
    );
    expect(env.APP_URL).toBe("https://app.binderlab.se");
  });

  it("räknar upp alla saknade och felaktiga värden på svenska", () => {
    const issues = issuesOf({ APP_ENV: "staging", AUTH_PROVIDER: "", DATABASE_URL: "" });
    expect(issues).toEqual(
      expect.arrayContaining([
        "APP_ENV: måste vara development, preview eller production",
        "DATABASE_URL: saknas",
      ]),
    );
    expect(() => parseServerEnv({ APP_ENV: "staging" })).toThrow(
      /Fel i miljövariablerna \(server\)/,
    );
  });

  it("kräver postgres://-adress", () => {
    expect(issuesOf({ ...devEnv, DATABASE_URL: "mysql://x@127.0.0.1/db" })).toContain(
      "DATABASE_URL: måste vara en postgres://-adress",
    );
  });

  it("vägrar AUTH_PROVIDER=dev i preview och production", () => {
    for (const appEnv of ["preview", "production"]) {
      expect(issuesOf({ ...prodEnv, ...devEnv, APP_ENV: appEnv })).toContain(
        "AUTH_PROVIDER: dev är bara tillåtet när APP_ENV=development",
      );
    }
  });

  it("vägrar dev-inloggning mot en fjärrdatabas", () => {
    expect(issuesOf({ ...devEnv, DATABASE_URL: prodEnv.DATABASE_URL })).toContain(
      "DATABASE_URL: dev-inloggningen kräver en lokal databas (localhost eller 127.0.0.1)",
    );
  });

  it("kräver DEV_AUTH_SECRET med minst 32 tecken för dev", () => {
    expect(issuesOf({ ...devEnv, DEV_AUTH_SECRET: undefined })[0]).toMatch(
      /^DEV_AUTH_SECRET: saknas/,
    );
    expect(issuesOf({ ...devEnv, DEV_AUTH_SECRET: "kort" })).toContain(
      "DEV_AUTH_SECRET: måste vara minst 32 tecken",
    );
  });

  it("kräver Supabase-variablerna när AUTH_PROVIDER=supabase", () => {
    const issues = issuesOf({
      APP_ENV: "preview",
      DATABASE_URL: prodEnv.DATABASE_URL,
    });
    expect(issues).toEqual([
      "SUPABASE_URL: saknas (krävs när AUTH_PROVIDER=supabase)",
      "SUPABASE_PUBLISHABLE_KEY: saknas (krävs när AUTH_PROVIDER=supabase)",
      "SUPABASE_SECRET_KEY: saknas (krävs för inbjudningsmejl i preview och production)",
    ]);
  });

  it("stoppar en hemlig nyckel i SUPABASE_PUBLISHABLE_KEY", () => {
    expect(issuesOf({ ...prodEnv, SUPABASE_PUBLISHABLE_KEY: "sb_secret_x" })).toContain(
      "SUPABASE_PUBLISHABLE_KEY: är en hemlig nyckel; använd publishable-nyckeln",
    );
    const serviceJwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url"),
      "sig",
    ].join(".");
    expect(issuesOf({ ...prodEnv, SUPABASE_PUBLISHABLE_KEY: serviceJwt })).toHaveLength(1);
  });

  it("kräver APP_URL med https i production", () => {
    expect(issuesOf({ ...prodEnv, APP_URL: undefined })[0]).toMatch(/^APP_URL: saknas/);
    expect(issuesOf({ ...prodEnv, APP_URL: "http://app.binderlab.se" })).toContain(
      "APP_URL: måste börja med https:// i production",
    );
  });

  it("kräver https för Supabase utanför development", () => {
    for (const APP_ENV of ["preview", "production"]) {
      const issues = issuesOf({
        ...prodEnv,
        APP_ENV,
        SUPABASE_URL: "http://ukuuwokxbtwhqfnttzwr.supabase.co",
        SUPABASE_JWKS_URL: "http://x.example/jwks.json",
      });
      expect(issues).toContain("SUPABASE_URL: måste börja med https:// utanför development");
      expect(issues).toContain("SUPABASE_JWKS_URL: måste börja med https:// utanför development");
    }
    expect(() =>
      parseServerEnv({
        ...devEnv,
        AUTH_PROVIDER: "supabase",
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc",
      }),
    ).not.toThrow();
  });

  it("räknar tomma strängar som saknade", () => {
    const env = parseServerEnv({ ...devEnv, SENTRY_DSN: "  ", APP_URL: "" });
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.APP_URL).toBeUndefined();
  });
});

describe("parseClientEnv", () => {
  it("har development som standard och godtar tomma värden", () => {
    expect(parseClientEnv({})).toEqual({ NEXT_PUBLIC_APP_ENV: "development" });
  });

  it("stoppar hemliga nycklar i NEXT_PUBLIC_*", () => {
    expect(() =>
      parseClientEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_oops" }),
    ).toThrow(/får aldrig ligga i NEXT_PUBLIC_/);
  });

  it("validerar adresser", () => {
    expect(() => parseClientEnv({ NEXT_PUBLIC_SENTRY_DSN: "inte en adress" })).toThrow(
      /NEXT_PUBLIC_SENTRY_DSN: måste vara en http\(s\)-adress/,
    );
  });
});

describe("lokal databas (dev-spärren)", () => {
  it.each([
    "postgres://postgres@127.0.0.1:54322/binderlab_dev",
    "postgresql://u:p@localhost/x?sslmode=disable",
    "postgres://u@[::1]:5432/x",
  ])("%s är lokal", (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(true);
  });

  it.each([
    "postgres://postgres@localhost:54322/db?host=db.evil.example",
    "postgres://postgres@localhost:54322/db?HOST=db.evil.example",
    "postgres://postgres@localhost:54322/db?hostaddr=10.0.0.5",
    "postgres://localhost#@db.evil.example/db",
    "postgres://localhost,db.evil.example/db",
    "postgres://u@LOCALHOST.evil.example/db",
    "postgres:///db",
    "postgres://u@/db",
    "mysql://u@localhost/db",
  ])("%s är inte lokal", (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(false);
  });

  it("tolkar värdarna som postgres.js", () => {
    expect(databaseUrlHosts("postgres://u:p@a,b:2/db")).toEqual(["a", "b"]);
    expect(databaseUrlHosts("postgres://u@[::1]:5432/db")).toEqual(["::1"]);
    expect(databaseUrlHosts("postgres://u@localhost/db?host=x")).toBeNull();
  });
});
