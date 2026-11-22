import { describe, expect, it } from "vitest";

import {
  classifyFont,
  findBlankGaps,
  isPackTooSmall,
  isSpacedUppercase,
  isTruncated,
  isWrongFont,
  legacyClasses,
  legacyVariables,
  normalizeFamily,
  parseFontFamilies,
} from "./detect";
import { probeScript } from "./probe";
import { fileToRoute, isExcluded, matchesPattern, patternFor, routeFilter } from "./routes";
import { searchTerms } from "./report";

describe("typsnitt", () => {
  it("delar font-family med citattecken", () => {
    expect(parseFontFamilies(`"Google Sans", 'V2 Google Sans Fallback', system-ui`)).toEqual([
      "Google Sans",
      "V2 Google Sans Fallback",
      "system-ui",
    ]);
  });

  it("tar bort next/font-prefix och hash", () => {
    expect(normalizeFamily("__Google_Sans_5a3b2c")).toBe("google sans");
    expect(normalizeFamily("__Google_Sans_Code_Fallback_1a2b3c")).toBe("google sans code");
    expect(normalizeFamily("GeistMono")).toBe("geistmono");
  });

  it("Google Sans är rätt, Geist och monospace fel, Code bara i Ctrl K", () => {
    expect(classifyFont(`"Google Sans", system-ui`).kind).toBe("google-sans");
    expect(classifyFont(`__Google_Sans_abc123, "__Google_Sans_Fallback_abc123"`).kind).toBe(
      "google-sans",
    );
    expect(classifyFont(`GeistMono, ui-monospace, monospace`).kind).toBe("monospace");
    expect(classifyFont(`"Geist Mono", monospace`).kind).toBe("monospace");
    expect(classifyFont(`GeistSans, system-ui`).kind).toBe("other");
    const code = classifyFont(`"Google Sans Code", ui-monospace`).kind;
    expect(code).toBe("google-sans-code");
    expect(isWrongFont(code, true)).toBe(false);
    expect(isWrongFont(code, false)).toBe(true);
    expect(isWrongFont("google-sans", false)).toBe(false);
    expect(isWrongFont("other", true)).toBe(true);
  });
});

describe("VERSALER med spärrning", () => {
  it("flaggar .label (0,08 em) men inte normal text eller 0,02 em", () => {
    expect(isSpacedUppercase("uppercase", "0.88px", "11px")).toBe(true);
    expect(isSpacedUppercase("uppercase", "normal", "11px")).toBe(false);
    expect(isSpacedUppercase("uppercase", "0.22px", "11px")).toBe(false);
    expect(isSpacedUppercase("none", "2px", "11px")).toBe(false);
  });
});

describe("gamla klasser och variabler", () => {
  it("hittar den gamla designens klasser med varianter", () => {
    expect(
      legacyClasses([
        "label",
        "meta",
        "tnum",
        "text-muted",
        "hover:text-fg",
        "max-md:text-sm",
        "border-line",
        "bg-raised",
        "rounded-xs",
        "font-mono",
        "text-signal-fg/80",
      ]),
    ).toEqual([
      "label",
      "meta",
      "text-muted",
      "hover:text-fg",
      "max-md:text-sm",
      "border-line",
      "bg-raised",
      "rounded-xs",
      "font-mono",
      "text-signal-fg/80",
    ]);
  });

  it("lämnar V2 och vanliga verktygsklasser", () => {
    expect(
      legacyClasses([
        "v2-card",
        "text-v2-mute",
        "bg-v2-panel",
        "rounded-v2-lg",
        "text-v2-sm",
        "flex",
        "truncate",
        "text-left",
        "border-t",
        "rounded-full",
        "text-[13px]",
      ]),
    ).toEqual([]);
  });

  it("hittar --bl-* och Geist i inline-stil", () => {
    expect(
      legacyVariables("color: var(--bl-fg-muted); font-family: var(--font-geist-mono)"),
    ).toEqual(["--bl-fg-muted", "--font-geist-mono"]);
    expect(legacyVariables("color: var(--v2-ink)")).toEqual([]);
  });
});

describe("layout", () => {
  it("tomma ytor är minst en skärmhöjd utan innehåll", () => {
    expect(
      findBlankGaps(
        [
          [0, 200],
          [150, 400],
          [1400, 1500],
        ],
        2600,
        900,
      ),
    ).toEqual([
      { start: 400, end: 1400 },
      { start: 1500, end: 2600 },
    ]);
    expect(findBlankGaps([[0, 800]], 1200, 900)).toEqual([]);
    expect(findBlankGaps([], 3000, 900)).toEqual([]);
  });

  it("packbilder under 32 px", () => {
    expect(isPackTooSmall(22)).toBe(true);
    expect(isPackTooSmall(32)).toBe(false);
    expect(isPackTooSmall(0)).toBe(false);
  });

  it("avklippt text på bredd eller rader", () => {
    const base = {
      scrollWidth: 100,
      clientWidth: 100,
      scrollHeight: 20,
      clientHeight: 20,
      overflowX: "visible",
      textOverflow: "clip",
      lineClamp: "none",
    };
    expect(isTruncated(base)).toBe(false);
    expect(isTruncated({ ...base, scrollWidth: 180, textOverflow: "ellipsis" })).toBe(true);
    expect(isTruncated({ ...base, scrollWidth: 180 })).toBe(false);
    expect(isTruncated({ ...base, scrollHeight: 60, lineClamp: "2" })).toBe(true);
  });
});

describe("sidor", () => {
  it("ruttgrupper försvinner, privata mappar är inga sidor", () => {
    expect(fileToRoute("(app)/automater/(oversikt)/page.tsx")).toBe("/automater");
    expect(fileToRoute("(app)/page.tsx")).toBe("/");
    expect(fileToRoute("(app)/automater/[automat]/page.tsx")).toBe("/automater/[automat]");
    expect(fileToRoute("(app)/_hem/page.tsx")).toBeNull();
    expect(fileToRoute("(app)/lonsamhet/loading.tsx")).toBeNull();
    expect(isExcluded("/design/epost")).toBe(true);
    expect(isExcluded("/designer")).toBe(false);
    expect(isExcluded("/plattform")).toBe(true);
  });

  it("adresser matchas mot det mest specifika mönstret", () => {
    const patterns = ["/", "/butiker/[butik]", "/butiker/ny", "/fyll-pa/[machineId]/qr"];
    expect(patternFor("/butiker/ny", patterns)).toBe("/butiker/ny");
    expect(patternFor("/butiker/abc", patterns)).toBe("/butiker/[butik]");
    expect(patternFor("/", patterns)).toBe("/");
    expect(matchesPattern("/fyll-pa/x/qr", "/fyll-pa/[machineId]/qr")).toBe(true);
    expect(patternFor("/logga-in", patterns)).toBeNull();
  });

  it("--routes: exakt, del eller prefix", () => {
    const f = routeFilter("/lonsamhet,automater,/portal*");
    expect(f("/lonsamhet")).toBe(true);
    expect(f("/automater/[automat]")).toBe(true);
    expect(f("/portal/rapporter")).toBe(true);
    expect(f("/pengar")).toBe(false);
  });
});

describe("rapporten", () => {
  it("söker på hela texten och de längsta orden", () => {
    expect(searchTerms("För ny: 5 dagar")).toEqual(["För ny: 5 dagar", "För ny", "dagar"]);
  });

  it("probe-skriptet går att tolka (inga beroenden utanför sig själv)", () => {
    expect(
      () => new Function(`return ${probeScript({ phone: true, maxPerKey: 3 })}`),
    ).not.toThrow();
  });
});
