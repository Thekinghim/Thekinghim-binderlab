import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** vercel.json schemalägger båda cron-routerna, och routerna finns och kräver CRON_SECRET. */
describe("vercel.json: cron", () => {
  const root = path.resolve(__dirname, "../../../..");
  const config = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as {
    crons: { path: string; schedule: string }[];
  };

  it("har rapporterna en gång i månaden och larmen en gång om dagen (Vercel Hobby)", () => {
    expect(config.crons).toEqual(
      expect.arrayContaining([
        { path: "/api/cron/rapporter", schedule: "17 5 1 * *" },
        { path: "/api/cron/larm", schedule: "7 5 * * *" },
      ]),
    );
  });

  it("kör funktionerna i London, där databasen finns, inte i Vercels standardregion i USA", () => {
    // docs/operations.md, Personuppgifter och biträden: Supabase ligger i eu-west-2 (London).
    expect((config as { regions?: string[] }).regions).toEqual(["lhr1"]);
  });

  it("varje cron pekar på en route som kräver CRON_SECRET", () => {
    for (const c of config.crons) {
      const file = path.join(root, "src/app", c.path, "route.ts");
      expect(existsSync(file), file).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source).toContain("CRON_SECRET");
      expect(source).toMatch(/export async function GET/);
    }
  });
});
