/**
 * Pris mot kund (purchase_prices.customer_price_ore) visas på Inköpspriser och läses av EN
 * beräkning: butikens andel vid vinstdelning från CUSTOMER_PRICE_SHARE_FROM
 * (src/domain/profit-split.ts `shareCostOre`, ägarens beslut). Allt annat (vår vinst,
 * marginal, bokföring, lagervärde, och allt butiken ser utom andelens underlag) räknas på
 * unit_cost_ore, som förut.
 *
 * Här hålls det på plats i koden: kolumnen får bara nämnas i filerna nedan. Den som vill
 * räkna på priset måste lägga till sin fil här, och då syns beslutet i granskningen.
 * Mot databasen: test/db/kundpris-orord.test.ts (före datumet och utan vinstdelning ger
 * laddarna, rapporterna, bokföringen och lagervärdet identiska svar med och utan pris mot
 * kund) och test/db/kundpris-andel.test.ts (andelen från datumet, och att butiken aldrig
 * ser vårt inköpspris).
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
  // Hyllvyn på samma sida (visuellt): visar samma pris mot kund som tabellen.
  "src/app/(app)/inkopspriser/_components/price-shelf.tsx",
  "src/app/(app)/inkopspriser/_lib/price-economics.ts",
  // Utvecklingsseeden (ett exempel att titta på).
  "src/seed/catalog.ts",
  "src/seed/run-seed.ts",
  // Butikens andel vid vinstdelning (den enda beräkningen): typen, kontrollen av priset,
  // regeln (shareCostOre) och laddaren som läser kolumnen.
  ...LAYER_ALLOWED_SOURCES(),
]);

/**
 * Filerna i beräkningslagren som får nämna priset: andelens regel och laddaren. Inga
 * rapporter, ingen portal, inga avräkningar, ingen bokföring (de får andelens underlag
 * färdigräknat ur liggaren).
 */
function LAYER_ALLOWED_SOURCES(): string[] {
  return [
    "src/domain/types.ts",
    "src/domain/prices.ts",
    "src/domain/profit-split.ts",
    "src/server/data/core/queries.ts",
  ];
}

/** Testerna i beräkningslagren som får nämna priset (regelns egna tester). */
const LAYER_ALLOWED_TESTS = ["src/domain/customer-price-share.test.ts"];

/** Migreringen som lägger till kolumnen. */
const MIGRATION = "supabase/migrations/20261216000000_kundpris.sql";
/** Migreringen där spärren för stängda månader bevakar priset (jämför bara värdena). */
const GUARD_MIGRATION = "supabase/migrations/20261226000000_kundpris_andel.sql";

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

  it("beräkningslagren nämner den bara i andelens regel och laddaren (och regelns tester)", () => {
    const layers = ["src/domain", "src/analytics", "src/reports", "src/server"];
    const allowed = new Set([...LAYER_ALLOWED_SOURCES(), ...LAYER_ALLOWED_TESTS]);
    const hits = layers
      .flatMap((d) => files(path.join(ROOT, d), (f) => /\.(ts|tsx)$/.test(f)))
      .filter((f) => MENTION.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => !allowed.has(f));
    expect(hits).toEqual([]);
  });

  it("allt butiken ser (rapporter, portal, avräkningar, e-post) nämner den inte alls", () => {
    const storeFacing = [
      "src/reports",
      "src/server/portal",
      "src/server/settlements",
      "src/server/reports",
      "src/emails",
      "src/app/portal",
      "src/app/rapport",
    ];
    const hits = storeFacing
      .map((d) => path.join(ROOT, d))
      .flatMap((d) => files(d, (f) => /\.(ts|tsx)$/.test(f)))
      .filter((f) => MENTION.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(hits).toEqual([]);
  });

  it("ingen databasfunktion, vy eller policy räknar med kolumnen: bara migreringarna ovan", () => {
    const hits = files(path.join(ROOT, "supabase"), (f) => f.endsWith(".sql"))
      .filter((f) => MENTION.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(hits).toEqual([MIGRATION, GUARD_MIGRATION].sort());
    // Spärren jämför bara gammalt och nytt värde: ingen beräkning, inget val av kolumnen.
    const guard = readFileSync(path.join(ROOT, GUARD_MIGRATION), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(guard.match(/customer_price_ore/g)?.length).toBe(3);
    expect(guard).toMatch(/new\.customer_price_ore is not distinct from old\.customer_price_ore/);
    expect(guard).not.toMatch(/create\s+(or\s+replace\s+)?(view|policy)/i);
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
