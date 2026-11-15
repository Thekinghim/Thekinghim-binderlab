/**
 * Pris mot kund (purchase_prices.customer_price_ore) visas bara på Inköpspriser. Ingen
 * beräkning får läsa det: vinst, marginal, rapporter, butikens andel, bokföring och
 * lagervärde räknas på unit_cost_ore, som förut.
 *
 * Här hålls det på plats i koden: kolumnen får bara nämnas i filerna nedan. Den som vill
 * räkna på priset måste lägga till sin fil här, och då syns beslutet i granskningen.
 * Samma sak mot databasen (laddarna, rapporten, bokföringen och lagervärdet ger identiska
 * svar med och utan pris mot kund): test/db/kundpris-orord.test.ts.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../../..");

/** Kolumnen i SQL och i TypeScript (Drizzle, typer, formulär). */
const MENTION = /customer_price_ore|customerPriceOre|customerPrice\b|CustomerPrice/;

/** Filerna som får nämna pris mot kund, och varför. */
const ALLOWED = new Set([
  // Schemat och katalogerna (ingen logik).
  "src/db/schema.ts",
  "src/app/datamodell/schema.ts",
  // Sidan Inköpspriser: läser, visar och sparar.
  "src/app/(app)/inkopspriser/actions.ts",
  "src/app/(app)/inkopspriser/page.tsx",
  "src/app/(app)/inkopspriser/_lib/data.ts",
  "src/app/(app)/inkopspriser/_lib/model.ts",
  "src/app/(app)/inkopspriser/_components/price-form.tsx",
  "src/app/(app)/inkopspriser/_components/price-history.tsx",
  "src/app/(app)/inkopspriser/_components/title-table.tsx",
  // Utvecklingsseeden (ett exempel att titta på).
  "src/seed/catalog.ts",
  "src/seed/run-seed.ts",
]);

/** Migreringen som lägger till kolumnen: den enda SQL som får nämna den. */
const MIGRATION = "supabase/migrations/20261216000000_kundpris.sql";

function files(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".git")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

describe("pris mot kund läses bara av Inköpspriser", () => {
  it("ingen annan källfil nämner kolumnen (beräkningar, rapporter, bokföring, lager, portal)", () => {
    const hits = files(path.join(ROOT, "src"), (f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => MENTION.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => !ALLOWED.has(f));
    expect(hits).toEqual([]);
  });

  it("beräkningslagren nämner den inte alls, inte ens i tester", () => {
    const layers = ["src/domain", "src/analytics", "src/reports", "src/server"];
    const hits = layers
      .flatMap((d) => files(path.join(ROOT, d), (f) => /\.(ts|tsx)$/.test(f)))
      .filter((f) => MENTION.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(hits).toEqual([]);
  });

  it("ingen databasfunktion, vy eller policy läser kolumnen: bara migreringen som skapar den", () => {
    const hits = files(path.join(ROOT, "supabase"), (f) => f.endsWith(".sql"))
      .filter((f) => MENTION.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(hits).toEqual([MIGRATION]);
    // Migreringen lägger bara till kolumnen och rätten att uppdatera den.
    const sql = readFileSync(path.join(ROOT, MIGRATION), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?(function|view|policy|trigger)/i);
  });

  it("listan är aktuell: varje tillåten fil finns och nämner priset", () => {
    for (const file of ALLOWED) {
      expect(MENTION.test(readFileSync(path.join(ROOT, file), "utf8")), file).toBe(true);
    }
  });
});
