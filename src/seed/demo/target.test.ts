import { describe, expect, it } from "vitest";

import { resolveDemoSeedTarget } from "./target";

const env = {
  DATABASE_URL: "postgres://postgres@127.0.0.1:54322/binderlab_dev",
  DATABASE_URL_TEST: "postgres://postgres@127.0.0.1:54322/binderlab_test",
};

describe("demo: mål för seeden", () => {
  it("lokal dev som standard, med standardlösenordet", () => {
    const t = resolveDemoSeedTarget([], env);
    expect(t).toMatchObject({ database: "binderlab_dev", local: true, large: false, reset: false });
    expect(t.password).toBe("binderlab-dev");
  });

  it("flaggorna --stor, --aterstall och --radera", () => {
    expect(resolveDemoSeedTarget(["test", "--stor", "--aterstall"], env)).toMatchObject({
      database: "binderlab_test",
      large: true,
      reset: true,
      deleteOnly: false,
    });
    expect(resolveDemoSeedTarget(["--radera"], env).deleteOnly).toBe(true);
    expect(() => resolveDemoSeedTarget(["--aterstall", "--radera"], env)).toThrow(/inte båda/);
  });

  it("--datum och --original (demons nu)", () => {
    expect(resolveDemoSeedTarget([], env)).toMatchObject({ date: null, original: false });
    expect(resolveDemoSeedTarget(["test", "--datum", "2026-12-01"], env)).toMatchObject({
      database: "binderlab_test",
      date: "2026-12-01",
    });
    expect(resolveDemoSeedTarget(["--original"], env).original).toBe(true);
    expect(() => resolveDemoSeedTarget(["--datum", "1 dec"], env)).toThrow(/ÅÅÅÅ-MM-DD/);
    expect(() => resolveDemoSeedTarget(["--datum", "2026-12-01", "--original"], env)).toThrow(
      /inte båda/,
    );
  });

  it("vägrar fjärrvärd utan --allow-remote och okända argument", () => {
    const remote = ["--url", "postgres://u@db.example.supabase.co:5432/postgres"];
    expect(() => resolveDemoSeedTarget(remote, env)).toThrow(/Vägrar/);
    const ok = resolveDemoSeedTarget([...remote, "--allow-remote"], env);
    expect(ok).toMatchObject({ local: false, manageUsers: false });
    expect(() => resolveDemoSeedTarget(["--snabb"], env)).toThrow(/Okänt argument/);
    expect(() => resolveDemoSeedTarget(["--write-csv", "x.csv"], env)).toThrow(/db:seed/);
  });
});
