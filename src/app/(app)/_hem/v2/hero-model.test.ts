import { describe, expect, it } from "vitest";

import {
  aheadText,
  axisLabels,
  celebrateKey,
  goalPace,
  monthDay,
  resample,
  sparkGeometry,
  splitKpis,
} from "./hero-model";

describe("splitKpis", () => {
  it("lägger första rutan i hjälten och resten i mockens ordning", () => {
    const ids = [
      "profit",
      "profit-today",
      "revenue",
      "orders",
      "aov",
      "margin",
      "per-machine",
      "stock-value",
    ];
    const { hero, rest } = splitKpis(ids.map((id) => ({ id })));
    expect(hero?.id).toBe("profit");
    expect(rest.map((t) => t.id)).toEqual([
      "revenue",
      "orders",
      "margin",
      "profit-today",
      "aov",
      "per-machine",
      "stock-value",
    ]);
  });

  it("med I dag: vinsten i dag i hjälten och 30 dagar bland resten", () => {
    const { hero, rest } = splitKpis(
      ["profit-today", "profit-30d", "revenue", "x"].map((id) => ({ id })),
    );
    expect(hero?.id).toBe("profit-today");
    expect(rest.map((t) => t.id)).toEqual(["revenue", "profit-30d", "x"]);
  });

  it("tomt band", () => {
    expect(splitKpis([])).toEqual({ hero: null, rest: [] });
  });
});

describe("målets takt", () => {
  it("dag i månaden och månadens längd", () => {
    expect(monthDay("2026-11-23")).toEqual({ day: 23, daysInMonth: 30 });
    expect(monthDay("2028-02-10")).toEqual({ day: 10, daysInMonth: 29 });
  });

  it("takten är målet jämnt fördelat; efter = takten minus utfallet", () => {
    // Mockens tal: 50 000 kr, 23 november, 36 920 kr hittills.
    expect(goalPace(3_692_000, 5_000_000, 23, 30)).toEqual({ pace: 3_833_333, behind: 141_333 });
  });

  it("före takten: inget efter", () => {
    expect(goalPace(4_000_000, 5_000_000, 23, 30).behind).toBe(0);
  });

  it("mål ≤ 0 ger ingen takt", () => {
    expect(goalPace(0, 0, 10, 30)).toEqual({ pace: null, behind: 0 });
  });
});

describe("sparklinjen", () => {
  it("kräver minst två punkter", () => {
    expect(sparkGeometry([5], null)).toBeNull();
  });

  it("yta stängs mot botten och förra perioden ritas i samma skala", () => {
    const g = sparkGeometry([0, 100, 50], [50, 50, 50], 300, 96)!;
    expect(g.line.startsWith("M1.0,92.0")).toBe(true);
    expect(g.area.endsWith("Z")).toBe(true);
    expect(g.previous).toMatch(/^M1\.0,/);
  });

  it("förlustdagar ritas på nollan", () => {
    const g = sparkGeometry([-500, 100], null, 300, 96)!;
    expect(g.line.startsWith("M1.0,92.0")).toBe(true);
  });

  it("omsamplar förra perioden till samma längd", () => {
    expect(resample([0, 10], 3)).toEqual([0, 5, 10]);
    expect(resample([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("tre axeletiketter", () => {
    expect(axisLabels(["a", "b", "c", "d", "e"])).toEqual(["a", "c", "e"]);
    expect(axisLabels(["a", "b"])).toEqual(["a", "b"]);
    expect(axisLabels([])).toEqual([]);
  });
});

describe("firandet", () => {
  it("nyckeln är per organisation, person, månad och mål", () => {
    expect(celebrateKey("o", "u", "2026-11", "g")).toBe("binderlab:mal-firat:o:u:2026-11:g");
  });

  it("hur tidigt målet nåddes", () => {
    expect(aheadText(7)).toBe("7 dagar före månadens slut");
    expect(aheadText(1)).toBe("1 dag före månadens slut");
    expect(aheadText(0)).toBe("på månadens sista dag");
  });
});
