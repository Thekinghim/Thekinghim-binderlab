/** Spärren mot fjärrdatabaser och valet av databas för seeden. */

import { describe, expect, it } from "vitest";

import { DEFAULT_DEV_SEED_PASSWORD } from "./catalog";
import { resolveSeedTarget, SeedTargetError } from "./target";

const env = {
  DATABASE_URL: "postgres://postgres@127.0.0.1:54322/binderlab_dev",
  DATABASE_URL_TEST: "postgres://postgres@localhost:54322/binderlab_test",
};
const REMOTE = "postgres://postgres:x@db.abcdefgh.supabase.co:5432/postgres";

describe("resolveSeedTarget", () => {
  it("standard är binderlab_dev med standardlösenordet lokalt", () => {
    const t = resolveSeedTarget([], env);
    expect(t).toMatchObject({
      mode: "database",
      database: "binderlab_dev",
      local: true,
      manageUsers: true,
      password: DEFAULT_DEV_SEED_PASSWORD,
    });
  });

  it("test väljer DATABASE_URL_TEST, DEV_SEED_PASSWORD används om det finns", () => {
    const t = resolveSeedTarget(["test"], { ...env, DEV_SEED_PASSWORD: "ett-annat-lösen" });
    expect(t).toMatchObject({ database: "binderlab_test", password: "ett-annat-lösen" });
  });

  it("vägrar fjärrvärd utan --allow-remote", () => {
    expect(() => resolveSeedTarget(["--url", REMOTE], env)).toThrow(SeedTargetError);
    expect(() => resolveSeedTarget([], { DATABASE_URL: REMOTE })).toThrow(/Vägrar/);
  });

  it("med --allow-remote: inga användare skapas och standardlösenordet används aldrig", () => {
    const t = resolveSeedTarget(["--url", REMOTE, "--allow-remote"], env);
    expect(t).toMatchObject({ mode: "database", local: false, manageUsers: false, password: "" });
  });

  it("okända eller motsägande argument", () => {
    expect(() => resolveSeedTarget(["prod"], env)).toThrow(/Okänt/);
    expect(() => resolveSeedTarget(["dev", "--url", env.DATABASE_URL], env)).toThrow(/inte båda/);
    expect(() => resolveSeedTarget(["--url"], env)).toThrow(/saknar värde/);
    expect(() => resolveSeedTarget([], {})).toThrow(/DATABASE_URL saknas/);
  });

  it("--write-csv rör ingen databas", () => {
    expect(resolveSeedTarget(["--write-csv", "x.csv"], {})).toEqual({ mode: "csv", path: "x.csv" });
  });
});
