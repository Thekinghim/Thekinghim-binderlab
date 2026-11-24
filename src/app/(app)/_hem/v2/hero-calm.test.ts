import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HERO_CALM_CLASS } from "./hero-model";

const CSS = readFileSync(path.join(__dirname, "hem.css"), "utf8");

/** Varje enkel väljare (`.hem2 .hh.hh-calm .hh-sec` → [hem2], [hh, hh-calm], [hh-sec]) i hem.css. */
function compounds(css: string): string[][] {
  const out: string[][] = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of noComments.matchAll(/([^{}]+)\{/g)) {
    const prelude = (m[1] ?? "").trim();
    if (prelude.startsWith("@")) continue;
    for (const selector of prelude.split(",")) {
      for (const part of selector.trim().split(/\s*[>+~]\s*|\s+/)) {
        const classes = [...part.matchAll(/\.([\w-]+)/g)].map((c) => c[1] ?? "");
        if (classes.length > 0) out.push(classes);
      }
    }
  }
  return out;
}

describe("hjältekortets lugna läge (HeroIntro)", () => {
  it("har ett eget klassnamn, inte Kräver åtgärds .calm", () => {
    expect(HERO_CALM_CLASS).not.toBe("calm");
    expect(compounds(CSS).some((c) => c.includes("calm"))).toBe(true);
  });

  it("styls bara tillsammans med .hh, så ingen annan regel når hjälten", () => {
    // Tidigare hette klassen "calm": `.hem2 .calm` (flexrad, align-items: center) träffade då
    // hjälten när man kom tillbaka till Hem och korten krympte till innehållets bredd.
    const users = compounds(CSS).filter((c) => c.includes(HERO_CALM_CLASS));
    expect(users.length).toBeGreaterThan(0);
    for (const c of users) expect(c).toContain("hh");
  });
});
