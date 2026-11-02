import { afterEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/db/client";

import { verifyServerStartup } from "../startup";
import { assertDevAuthAllowed, DevAuthForbiddenError } from "./dev-guard";
import { DevAuthProvider } from "./dev-provider";
import { MemoryCookieJar } from "./types";

const LOCAL = "postgres://postgres@127.0.0.1:54322/binderlab_dev";
const REMOTE = "postgresql://postgres:pw@db.ukuuwokxbtwhqfnttzwr.supabase.co:5432/postgres";
const SECRET = "s".repeat(40);

const noDb = (): Db => {
  throw new Error("databasen ska inte användas");
};

function provider(env: { APP_ENV?: string; DATABASE_URL?: string; DEV_AUTH_SECRET?: string }) {
  return new DevAuthProvider({
    env: {
      APP_ENV: env.APP_ENV,
      DATABASE_URL: env.DATABASE_URL,
      DEV_AUTH_SECRET: env.DEV_AUTH_SECRET,
    },
    cookies: new MemoryCookieJar(),
    db: noDb,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dev-inloggningens spärr", () => {
  it("tillåter development mot lokal databas", () => {
    for (const url of [
      LOCAL,
      "postgres://postgres@localhost:5432/x",
      "postgres://u@[::1]:5432/x",
    ]) {
      expect(() =>
        assertDevAuthAllowed({ APP_ENV: "development", DATABASE_URL: url }),
      ).not.toThrow();
    }
    expect(
      provider({ APP_ENV: "development", DATABASE_URL: LOCAL, DEV_AUTH_SECRET: SECRET }).kind,
    ).toBe("dev");
  });

  it.each(["production", "preview", undefined, "Development"])("vägrar APP_ENV=%s", (appEnv) => {
    expect(() =>
      provider({ APP_ENV: appEnv, DATABASE_URL: LOCAL, DEV_AUTH_SECRET: SECRET }),
    ).toThrow(DevAuthForbiddenError);
  });

  it.each([
    REMOTE,
    "postgres://postgres@127.0.0.1.evil.example:5432/x",
    "postgres://postgres@10.0.0.5:5432/x",
    "inte-en-url",
    undefined,
  ])("vägrar databasen %s", (url) => {
    expect(() =>
      provider({ APP_ENV: "development", DATABASE_URL: url, DEV_AUTH_SECRET: SECRET }),
    ).toThrow(/lokal databas/);
  });

  it("vägrar produktionsbyggen och Vercel även med APP_ENV=development", () => {
    for (const extra of [
      { NODE_ENV: "production" },
      { VERCEL: "1" },
      { VERCEL_ENV: "preview" },
      { NODE_ENV: "production", NEXT_PHASE: "phase-production-server" },
    ]) {
      expect(
        () => assertDevAuthAllowed({ APP_ENV: "development", DATABASE_URL: LOCAL, ...extra }),
        JSON.stringify(extra),
      ).toThrow(DevAuthForbiddenError);
    }
    // Själva bygget (next build) lokalt får gå igenom; `next start` stoppas ovan.
    expect(() =>
      assertDevAuthAllowed({
        APP_ENV: "development",
        DATABASE_URL: LOCAL,
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
      }),
    ).not.toThrow();
  });

  it("kräver DEV_AUTH_SECRET", () => {
    expect(() => provider({ APP_ENV: "development", DATABASE_URL: LOCAL })).toThrow(
      /DEV_AUTH_SECRET/,
    );
  });
});

describe("verifyServerStartup", () => {
  const ok = () => ({}) as never;

  it("stoppar starten när dev-inloggningen pekas mot production eller fjärrdatabas", () => {
    expect(() =>
      verifyServerStartup({ APP_ENV: "production", AUTH_PROVIDER: "dev", DATABASE_URL: LOCAL }, ok),
    ).toThrow(DevAuthForbiddenError);
    expect(() =>
      verifyServerStartup({ APP_ENV: "preview", AUTH_PROVIDER: "dev", DATABASE_URL: LOCAL }, ok),
    ).toThrow(DevAuthForbiddenError);
    // Utan AUTH_PROVIDER blir development dev-inloggning: fjärrdatabasen stoppas.
    expect(() => verifyServerStartup({ APP_ENV: "development", DATABASE_URL: REMOTE }, ok)).toThrow(
      DevAuthForbiddenError,
    );
  });

  it("stoppar starten vid fel miljö i production, men bara loggar i development", () => {
    const fail = () => {
      throw new (class extends Error {})("annat fel");
    };
    expect(() => verifyServerStartup({ APP_ENV: "production", AUTH_PROVIDER: "supabase" })).toThrow(
      /Fel i miljövariablerna/,
    );
    expect(() =>
      verifyServerStartup({ APP_ENV: "production", AUTH_PROVIDER: "supabase" }, fail),
    ).toThrow("annat fel");

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      verifyServerStartup({ APP_ENV: "development", AUTH_PROVIDER: "dev", DATABASE_URL: LOCAL }),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/DEV_AUTH_SECRET: saknas/));
  });
});
