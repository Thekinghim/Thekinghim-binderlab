import { describe, expect, it } from "vitest";

import * as catalog from "./catalog";

/**
 * Demon visas externt: telefonnumren ska ligga i PTS nummerserier för fiktiva nummer
 * (070-174 06 05 – 070-174 06 99 och 08-465 004 00 – 08-465 004 99), som aldrig delas ut.
 */
const FICTIVE = [/^070-174 06 (0[5-9]|[1-9]\d)$/, /^08-465 004 \d\d$/];

/** Alla strängar i katalogen som ser ut som svenska telefonnummer. */
function phoneLike(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (/^\+?\d[\d -]{6,}\d$/.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) phoneLike(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) phoneLike(v, out);
  }
  return out;
}

describe("demokatalogen", () => {
  it("har bara fiktiva telefonnummer (PTS)", () => {
    const phones = phoneLike(catalog);
    expect(phones.length).toBeGreaterThanOrEqual(10);
    for (const phone of phones) {
      expect(
        FICTIVE.some((re) => re.test(phone)),
        `${phone} är inget fiktivt nummer`,
      ).toBe(true);
    }
  });

  it("har inga riktiga butiksnamn kvar", () => {
    const names = catalog.DEMO_STORES.map((s) => s.name);
    expect(names).not.toContain("Seriecentralen");
    expect(JSON.stringify(catalog)).not.toMatch(/seriecentralen/i);
  });
});
