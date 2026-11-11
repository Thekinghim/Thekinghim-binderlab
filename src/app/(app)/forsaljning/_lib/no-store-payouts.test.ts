/**
 * Delägarens Försäljning (Enkel vy, startsidan "/" och /forsaljning) visar bara hennes
 * siffror: aldrig utbetalningen till butikerna ("Betala butikerna: …", Till butiken,
 * avräkningar). De raderna hör till ägarens Hem i full vy (_hem/payout-line.tsx).
 *
 * Kontrolleras i källkoden: skärmen får inte importera något om utbetalningar, och Hem
 * måste lämna över till Försäljning i den enkla vyn innan Hem-innehållet (med raderna)
 * renderas.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("Försäljning i Enkel vy utan butikernas utbetalning", () => {
  it("skärmen och modellen importerar inget om utbetalningar eller avräkningar", () => {
    for (const file of ["../_components/sales-screen.tsx", "./model.ts", "../page.tsx"]) {
      const src = read(file);
      const imports = src.split("\n").filter((l) => /^\s*(import|from)\b|\bfrom "/.test(l));
      for (const line of imports) {
        expect(line, `${file}: ${line}`).not.toMatch(/payout|settlement|_hem|butiker|todos/i);
      }
      // Vinsten före butikernas andel (som i resten av den enkla vyn): ingen andel dras.
      if (file.endsWith("sales-screen.tsx")) expect(src).toMatch(/storeShare: false/);
    }
  });

  it("Hem lämnar över till Försäljning i Enkel vy innan utbetalningsraderna", () => {
    const src = read("../../page.tsx");
    const simple = src.indexOf('if (simple.viewMode === "simple")');
    const salesReturn = src.indexOf("return <SalesScreen ctx={simple}");
    const content = src.indexOf("<HemContent");
    const payouts = src.indexOf("<PayoutLines");
    expect(simple).toBeGreaterThan(-1);
    expect(salesReturn).toBeGreaterThan(simple);
    expect(content).toBeGreaterThan(salesReturn);
    expect(payouts).toBeGreaterThan(content);
  });
});
