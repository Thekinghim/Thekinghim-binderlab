import { describe, expect, it } from "vitest";
import {
  activeSectionId,
  activeSubTab,
  navSections,
  sectionHref,
  sectionsForRole,
  shellRoutes,
  subTabHref,
  type Role,
} from "./nav";
import { withQuery } from "./side-nav";

const tree = (role: Role) =>
  Object.fromEntries(sectionsForRole(role).map((s) => [s.id, s.tabs.map((t) => t.label)]));

describe("huvudflikar", () => {
  it("exakt sex huvudflikar i rätt ordning", () => {
    expect(navSections.map((s) => s.label)).toEqual([
      "Hem",
      "Automater",
      "Vårt lager",
      "Butiker",
      "Pengar",
      "Mer",
    ]);
  });

  it("varje rutt ligger under exakt en huvudflik", () => {
    for (const r of shellRoutes) {
      const owners = navSections.filter((s) => s.tabs.some((t) => t.route === r.id));
      expect(owners, r.id).toHaveLength(1);
    }
    const keys = navSections.flatMap((s) => s.tabs.map((t) => t.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ägaren ser alla sex med alla underflikar", () => {
    expect(tree("owner")).toEqual({
      hem: ["Översikt", "Att göra"],
      automater: ["Automater", "Drift", "Lager i automaterna", "Order", "Svinn", "Inkorg"],
      "vart-lager": ["Vårt lager", "Prognos & inköp", "Inköpspriser"],
      butiker: ["Butiker", "Avtal", "Expansion"],
      pengar: ["Lönsamhet", "Ekonomi", "Bokföring", "Rapporter"],
      mer: ["Inställningar", "Datakällor", "Assistent", "Marknad", "Effekt"],
    });
  });

  it("läsaren saknar Att göra, Inställningar och Datakällor", () => {
    const t = tree("viewer");
    expect(Object.keys(t)).toHaveLength(6);
    expect(t.hem).toEqual(["Översikt"]);
    expect(t.mer).toEqual(["Assistent", "Marknad", "Effekt"]);
  });

  it("påfyllaren ser bara det den får; tomma huvudflikar döljs", () => {
    expect(tree("refiller")).toEqual({
      hem: ["Att göra"],
      automater: ["Drift", "Lager i automaterna", "Inkorg"],
      mer: ["Assistent"],
    });
    const hem = sectionsForRole("refiller").find((s) => s.id === "hem");
    expect(hem && sectionHref(hem)).toBe("/att-gora");
  });

  it("butiksrollen ser ingenting i appen", () => {
    expect(sectionsForRole("store")).toEqual([]);
  });

  it("huvudflikens adress är första tillåtna underfliken", () => {
    const hrefs = Object.fromEntries(sectionsForRole("owner").map((s) => [s.id, sectionHref(s)]));
    expect(hrefs).toEqual({
      hem: "/",
      automater: "/automater",
      "vart-lager": "/vart-lager",
      butiker: "/butiker",
      pengar: "/lonsamhet",
      mer: "/installningar",
    });
  });
});

describe("aktiv flik", () => {
  it("huvudfliken lyser för alla underflikar och undersidor", () => {
    const cases: Array<[string, string | null]> = [
      ["/", "hem"],
      ["/att-gora", "hem"],
      ["/automater", "automater"],
      ["/automater/bl-003", "automater"],
      ["/drift/pafyllning", "automater"],
      ["/lager", "automater"],
      ["/inkorg/0b5c", "automater"],
      ["/vart-lager", "vart-lager"],
      ["/prognos", "vart-lager"],
      ["/butiker/abc", "butiker"],
      ["/avtal", "butiker"],
      ["/expansion/saljunderlag", "butiker"],
      ["/ekonomi", "pengar"],
      ["/rapporter", "pengar"],
      ["/installningar/anvandare", "mer"],
      ["/datakallor/importer/1", "mer"],
      ["/assistent", "mer"],
      ["/kom-igang", null],
      ["/sok", null],
    ];
    for (const [path, id] of cases) expect(activeSectionId(path), path).toBe(id);
  });

  it("Ekonomi och Bokföring skiljs åt av vyn", () => {
    expect(activeSubTab("/ekonomi")?.tab.label).toBe("Ekonomi");
    expect(activeSubTab("/automater/svinn")?.tab.label).toBe("Svinn");
    expect(activeSubTab("/automater/bl-001")?.tab.label).toBe("Automater");
    expect(activeSubTab("/ekonomi", "kassaflode")?.tab.label).toBe("Ekonomi");
    expect(activeSubTab("/ekonomi", "bokforing")?.tab.label).toBe("Bokföring");
    expect(activeSubTab("/ekonomi/bokforing/kvitto/1")?.tab.label).toBe("Bokföring");
  });

  it("underflikens adress bär vyn och perioden", () => {
    const bok = navSections.flatMap((s) => s.tabs).find((t) => t.view === "bokforing");
    expect(bok && subTabHref(bok)).toBe("/ekonomi?vy=bokforing");
    expect(withQuery("/ekonomi?vy=bokforing", "?period=7d")).toBe(
      "/ekonomi?vy=bokforing&period=7d",
    );
    expect(withQuery("/lager", "?period=7d")).toBe("/lager?period=7d");
    expect(withQuery("/lager", "")).toBe("/lager");
  });
});
