import { describe, expect, it } from "vitest";
import {
  activeSectionId,
  activeSubTab,
  activeV2NavId,
  navSections,
  routeById,
  sectionHref,
  sectionsForRole,
  shellRoutes,
  showsContext,
  splitSubTabs,
  subTabHref,
  v2MobileNavForRole,
  v2NavForRole,
  V2_ONLY_ROUTES,
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
    for (const r of shellRoutes.filter((r) => !V2_ONLY_ROUTES.has(r.id))) {
      const owners = navSections.filter((s) => s.tabs.some((t) => t.route === r.id));
      expect(owners, r.id).toHaveLength(1);
    }
    const keys = navSections.flatMap((s) => s.tabs.map((t) => t.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ägaren ser alla sex med alla underflikar", () => {
    expect(tree("owner")).toEqual({
      hem: ["Översikt", "Att göra"],
      automater: [
        "Automater",
        "Drift",
        "Lager i automaterna",
        "Order",
        "Svinn",
        "Inkorg",
        "Kampanjer",
        "Gratis-pack",
      ],
      "vart-lager": ["Vårt lager", "Mystery packs", "Inköp", "Prognos", "Inköpspriser"],
      butiker: ["Butiker", "Butiksägare", "Kontrakt", "Expansion", "Utbetalning"],
      pengar: ["Lönsamhet", "Ekonomi", "Bokföring", "Rapporter", "Värde"],
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
      // Påfyllaren packar mystery packs (innehållet och saldot, inga belopp).
      "vart-lager": ["Mystery packs"],
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
      ["/varde", "pengar"],
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

describe("underfliken Mer", () => {
  const labels = (role: Role, id: string) => {
    const s = sectionsForRole(role).find((x) => x.id === id);
    const split = splitSubTabs(s?.tabs ?? []);
    return { inline: split.inline.map((t) => t.label), more: split.more.map((t) => t.label) };
  };

  it("Automater visar de fyra mest använda; resten under Mer", () => {
    expect(labels("owner", "automater")).toEqual({
      inline: ["Automater", "Drift", "Lager i automaterna", "Order"],
      more: ["Svinn", "Inkorg", "Kampanjer", "Gratis-pack"],
    });
  });

  it("få flikar står alla i raden (påfyllaren, Vårt lager, Pengar)", () => {
    expect(labels("refiller", "automater")).toEqual({
      inline: ["Drift", "Lager i automaterna", "Inkorg"],
      more: [],
    });
    expect(labels("owner", "pengar").more).toEqual([]);
    expect(labels("owner", "vart-lager").more).toEqual([]);
  });

  it("flikarna under Mer har kvar sina adresser och blir aktiva som förut", () => {
    const more = splitSubTabs(navSections[1]!.tabs).more;
    expect(more.map(subTabHref)).toEqual([
      "/automater?vy=svinn",
      "/inkorg",
      "/kampanjer",
      "/kampanjer?vy=gratis-pack",
    ]);
    expect(activeSubTab("/kampanjer", "gratis-pack")?.tab.label).toBe("Gratis-pack");
    expect(activeSubTab("/inkorg/abc")?.tab.label).toBe("Inkorg");
  });

  it("Lager i automaterna har ett kort namn för mobilen", () => {
    expect(navSections[1]!.tabs.find((t) => t.route === "lager")?.short).toBe("Lager");
  });
});

describe("periodraden", () => {
  it("visas bara där perioden ändrar sidan", () => {
    const cases: Array<[string, string | null, boolean]> = [
      ["/", null, true],
      ["/lonsamhet", null, true],
      ["/automater", null, true],
      ["/automater/svinn", null, true],
      ["/order", null, true],
      ["/butiker", null, true],
      ["/ekonomi", null, true],
      ["/ekonomi", "kassaflode", true],
      ["/prognos", "prognos", true],
      // Inköp: lagret i dag och prognosen framåt.
      ["/prognos", null, false],
      ["/ekonomi", "bokforing", false],
      ["/ekonomi/bokforing/kvitto/1", null, false],
      ["/butiker", "utbetalning", false],
      // Butiksägare: bolagens uppgifter, ingen period.
      ["/butiker", "agare", false],
      ["/assistent", null, false],
      ["/drift", null, false],
      ["/drift/larm", null, false],
      ["/drift/pafyllning", null, false],
      ["/drift/besok", null, false],
      ["/drift/automat/0b5c", null, false],
      ["/att-gora", null, false],
      ["/installningar", null, false],
    ];
    for (const [path, view, shown] of cases) {
      expect(showsContext(path, view), `${path}?vy=${view}`).toBe(shown);
    }
  });
});

describe("V2-menyn", () => {
  it("ägaren ser sju poster; mobilen fem (Butiker och Pengar ligger på Mer)", () => {
    expect(v2NavForRole("owner").map((i) => [i.id, i.href])).toEqual([
      ["hem", "/"],
      ["automater", "/automater"],
      ["rutt", "/rutt"],
      ["vart-lager", "/vart-lager"],
      ["butiker", "/butiker"],
      ["pengar", "/pengar"],
      ["mer", "/mer"],
    ]);
    expect(v2MobileNavForRole("owner").map((i) => i.short ?? i.label)).toEqual([
      "Hem",
      "Automater",
      "Rutt",
      "Lager",
      "Mer",
    ]);
  });

  it("påfyllaren: Hem leder till Att göra, inga Butiker eller Pengar", () => {
    const items = v2NavForRole("refiller");
    expect(items.map((i) => i.id)).not.toContain("butiker");
    expect(items.map((i) => i.id)).not.toContain("pengar");
    expect(items.find((i) => i.id === "hem")?.href).toBe("/att-gora");
    expect(items.find((i) => i.id === "rutt")?.href).toBe("/rutt");
  });

  it("butiksrollen ser ingenting", () => {
    expect(v2NavForRole("store")).toEqual([]);
  });

  it.each([
    ["/", "hem"],
    ["/att-gora", "hem"],
    ["/automater/bl-001", "automater"],
    ["/drift", "automater"],
    ["/drift/besok", "rutt"],
    ["/rutt", "rutt"],
    ["/vart-lager/mystery", "vart-lager"],
    ["/prognos", "vart-lager"],
    ["/butiker/abc", "butiker"],
    ["/avtal", "butiker"],
    ["/lonsamhet", "pengar"],
    ["/pengar", "pengar"],
    ["/installningar/anvandare", "mer"],
    ["/assistent", "mer"],
    ["/mer", "mer"],
  ] as const)("%s → %s", (path, id) => {
    expect(activeV2NavId(path)).toBe(id);
  });

  it("de nya sidornas roller: Rutt och Mer för alla, Pengar som Lönsamhet", () => {
    expect(routeById("rutt").roles).toEqual(["owner", "admin", "refiller", "viewer"]);
    expect(routeById("mer").roles).toEqual(["owner", "admin", "refiller", "viewer"]);
    expect(routeById("pengar").roles).toEqual(routeById("lonsamhet").roles);
  });
});
