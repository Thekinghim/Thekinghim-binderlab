import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = join(process.cwd(), "src/app/(app)");

/**
 * Okänt id i en detaljrutt ska ge HTTP 404. Next.js bestämmer statuskoden när svaret börjar
 * strömmas (loading.tsx), så existenskontrollen ligger i detaljsegmentets layout.tsx, ovanför
 * segmentets eget laddningsläge, och listans laddningsläge ligger i gruppen (oversikt) så att
 * det inte omsluter detaljsidan. Statusen provas mot en körande server (docs/operations.md).
 */
const DETAIL = [
  { segment: "automater", detail: "[automat]", notFoundIn: "automater" },
  { segment: "butiker", detail: "[butik]", notFoundIn: "butiker" },
  { segment: "inkorg", detail: "[id]", notFoundIn: "inkorg" },
  { segment: "drift", detail: "automat/[id]", notFoundIn: "drift/automat" },
  { segment: "datakallor", detail: "importer/[id]", notFoundIn: "datakallor/importer" },
] as const;

describe("detaljrutter med laddningsläge ger 404 för okänt id", () => {
  it.each(DETAIL)("$segment/$detail kontrollerar id:t i layout.tsx", ({ segment, detail }) => {
    const layout = join(APP, segment, detail, "layout.tsx");
    expect(existsSync(layout)).toBe(true);
    expect(readFileSync(layout, "utf8")).toContain("notFound()");
    expect(existsSync(join(APP, segment, detail, "loading.tsx"))).toBe(true);
  });

  it.each(DETAIL)("$segment har inget laddningsläge ovanför detaljsidan", ({ segment }) => {
    expect(existsSync(join(APP, segment, "loading.tsx"))).toBe(false);
    expect(existsSync(join(APP, segment, "(oversikt)", "loading.tsx"))).toBe(true);
    expect(existsSync(join(APP, segment, "(oversikt)", "page.tsx"))).toBe(true);
  });

  it.each(DETAIL)("$notFoundIn har sidan för okänt id", ({ notFoundIn, detail, segment }) => {
    expect(existsSync(join(APP, notFoundIn, "not-found.tsx"))).toBe(true);
    // Inte kvar i detaljsegmentet, där den inte fångar layoutens notFound().
    expect(existsSync(join(APP, segment, detail, "not-found.tsx"))).toBe(false);
  });
});
