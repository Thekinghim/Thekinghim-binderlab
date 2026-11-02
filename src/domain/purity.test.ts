/**
 * Beräkningslagret ska vara rent och oberoende av processens tidszon.
 *
 * 1. Statisk kontroll: ingen kod i src/domain (utom testhjälpen) använder Date, Intl,
 *    slump, miljövariabler, flyttalsformatering eller importerar utanför src/domain.
 * 2. Samma beräkningar körs med TZ = UTC, Europe/Stockholm och Asia/Shanghai i samma
 *    process (Node läser om TZ när variabeln ändras) och ska ge identiska resultat.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as domain from "./index";
import { randomScenario } from "./testing/fixtures";

const DIR = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

describe("rena funktioner", () => {
  it.each(sourceFiles())("%s använder inte Date, Intl, slump eller miljön", (file) => {
    const src = readFileSync(join(DIR, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const forbidden: Array<[RegExp, string]> = [
      [/\bDate\b/, "Date"],
      [/\bIntl\b/, "Intl"],
      [/toLocale/, "toLocale…"],
      [/Math\.random/, "Math.random"],
      [/process\./, "process"],
      [/parseFloat|toFixed|toPrecision/, "flyttalsformatering"],
      [/from\s+["'](?!\.\/)/, "import utanför src/domain"],
    ];
    for (const [re, what] of forbidden) {
      expect(re.test(src), `${file} använder ${what}`).toBe(false);
    }
  });
});

describe("oberoende av processens tidszon", () => {
  const original = process.env.TZ;
  afterAll(() => {
    process.env.TZ = original;
  });

  function snapshot(): string {
    const parts: unknown[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const input = randomScenario(seed);
      parts.push(
        domain.profitabilityViews(input, ["title", "machine", "store", "day", "week", "month"]),
      );
      parts.push(domain.titleEconomics(input));
      parts.push(domain.unitEconomics({ ...input, investments: [] }));
    }
    parts.push(domain.eachDay("2026-03-27", "2026-04-01").map((d) => [d, domain.isoWeekLabel(d)]));
    parts.push(domain.eachDay("2026-10-23", "2026-10-27").map((d) => [d, domain.addDays(d, 1)]));
    return JSON.stringify(parts);
  }

  it("ger identiska resultat i UTC, Europe/Stockholm och Asia/Shanghai", () => {
    const results: Record<string, string> = {};
    const offsets: Record<string, number> = {};
    for (const tz of ["UTC", "Europe/Stockholm", "Asia/Shanghai"]) {
      process.env.TZ = tz;
      // Kontrollera att tidszonen faktiskt bytts i processen.
      offsets[tz] = new Date(Date.UTC(2026, 6, 1, 12)).getTimezoneOffset();
      results[tz] = snapshot();
    }
    expect(offsets).toEqual({ UTC: 0, "Europe/Stockholm": -120, "Asia/Shanghai": -480 });
    expect(results["Europe/Stockholm"]).toBe(results.UTC);
    expect(results["Asia/Shanghai"]).toBe(results.UTC);
  });
});
