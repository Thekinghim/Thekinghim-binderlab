/**
 * Delägarens Lager, Inköpslista, Inköpspriser och Vinst per produkt (Enkel vy) visar aldrig
 * butikernas andel, utbetalningar, avräkningar, avtal eller kontrakt. Vinsten är alltid
 * före butikernas andel. Kontrolleras i källkoden: skärmarna importerar inget om de
 * sakerna, och modellen läser bara vinsten före andelen.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"));
const read = (f: string) => readFileSync(`${dir}/${f}`, "utf8");

describe("Enkel vy: Lager, Inköp, Priser och Vinst per produkt", () => {
  it("skärmarna finns", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "model.ts",
        "stock-screen.tsx",
        "stock-list.tsx",
        "buy-list-screen.tsx",
        "prices-screen.tsx",
        "price-list.tsx",
        "stock-tabs.tsx",
      ]),
    );
  });

  it.each(files)("%s importerar inget om butikernas andel, utbetalningar eller avtal", (file) => {
    const imports = read(file)
      .split("\n")
      .filter((l) => /^\s*(import|from)\b|\bfrom "/.test(l));
    for (const line of imports) {
      expect(line, `${file}: ${line}`).not.toMatch(
        /payout|settlement|avrakning|utbetalning|avtal|kontrakt|contract|butiker|store-share|storeShare|_hem|ekonomi|bokforing|rapporter|lonsamhet/i,
      );
    }
  });

  it("vinsten per produkt är före butikernas andel, aldrig efter", () => {
    const model = read("model.ts");
    expect(model).toMatch(/profitBeforeShareOre/);
    expect(model).not.toMatch(/profitAfterShareOre|compensationOre|commissionOre|rentOre/);
    const sales = readFileSync(
      fileURLToPath(new URL("../forsaljning/_components/sales-screen.tsx", import.meta.url)),
      "utf8",
    );
    expect(sales).toMatch(/productProfits\(/);
    expect(sales).toMatch(/storeShare: false/);
    expect(sales).not.toMatch(/profitAfterShareOre|compensationOre/);
  });

  it("Lager, Inköp och Inköpspriser lämnar över till den enkla skärmen först", () => {
    for (const [page, screen] of [
      ["../vart-lager/page.tsx", "<SimpleStockScreen"],
      ["../prognos/page.tsx", "<SimpleBuyListScreen"],
      ["../inkopspriser/page.tsx", "<SimplePricesScreen"],
    ] as const) {
      const src = readFileSync(fileURLToPath(new URL(page, import.meta.url)), "utf8");
      const route = src.indexOf("await requireRoute(");
      const simple = src.indexOf('if (ctx.viewMode === "simple") return ' + screen);
      expect(route, page).toBeGreaterThan(-1);
      expect(simple, page).toBeGreaterThan(route);
      // Inget av hela sidan (perioder, butiksandel, loggar) läses före den enkla skärmen.
      const between = src.slice(route, simple);
      expect(between, page).not.toMatch(/loadPeriod|loadDomainInput|searchParams\b/);
    }
  });
});
