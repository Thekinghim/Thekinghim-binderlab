import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = join(process.cwd(), "src/app/(app)");

/**
 * Genomgång B (docs/review/fas-7/genomgang-b.md): Order, Lager, Automater (med
 * enhetsekonomi), Butiker, Datakällor och Prognos & inköp har eget felläge och
 * laddningsläge på svenska, och detaljsidorna en svensk sida för okänt id med en h1.
 */
describe("sidorna i genomgång B", () => {
  const segments = ["order", "lager", "automater", "butiker", "datakallor", "prognos"];

  it.each(segments)("%s har ett felläge (error.tsx) som använder RouteError", (segment) => {
    const file = join(APP, segment, "error.tsx");
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src).toContain('"use client"');
    expect(src).toContain("RouteError");
    expect(src).toContain("retry");
  });

  it.each(segments)("%s har ett laddningsläge (loading.tsx) med etikett", (segment) => {
    const file = join(APP, segment, "loading.tsx");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toMatch(/label="Laddar /);
  });

  it.each(["automater/[automat]", "butiker/[butik]", "datakallor/importer/[id]"])(
    "%s har en svensk sida för okänt id (not-found.tsx) med en h1",
    (segment) => {
      const file = join(APP, segment, "not-found.tsx");
      expect(existsSync(file)).toBe(true);
      const src = readFileSync(file, "utf8");
      expect(src).toContain("<h1");
      expect(src).toMatch(/finns inte\./);
    },
  );
});
