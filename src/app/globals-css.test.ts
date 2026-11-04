/**
 * Inträdesanimationerna (.rise, .fade-in) får inte ligga kvar efter slutet
 * (animation-fill-mode both/forwards). En kvarliggande animation av opacity/transform gör
 * blocket till en egen staplingskontext, och nästa block ritas då ovanpå menyer som
 * sticker ut ur det: Kolumner i Enhetsekonomi hamnade under Investeringar på iPhone.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

function animationOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[2];
  const decl = block ? /(^|;|\n)\s*animation\s*:\s*([^;]+);/.exec(block)?.[2] : undefined;
  if (!decl) throw new Error(`Hittade ingen animation för ${selector}`);
  return decl;
}

describe("globals.css inträdesanimationer", () => {
  it.each([".rise", ".fade-in"])("%s fylls bara bakåt, inte efter slutet", (selector) => {
    const animation = animationOf(selector);
    expect(animation).toMatch(/\bbackwards\b/);
    expect(animation).not.toMatch(/\b(both|forwards)\b/);
  });
});
