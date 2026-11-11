import { describe, expect, it } from "vitest";

import { navSections, subTabHref } from "./nav";
import {
  BUY_LIST_HREF,
  COUNT_HREF,
  MYSTERY_HREF,
  PRICES_HREF,
  REFILL_HREF,
  SALES_HREF,
  STOCK_HREF,
  STOCK_SUBTABS,
  SIMPLE_TABS,
  simpleHomeFor,
  simpleTabActive,
  simpleTabsFor,
  simpleViewAllows,
} from "./simple-view";

describe("Enkel vy: tillåtna sökvägar", () => {
  it.each([
    "/",
    "/forsaljning",
    "/fyll-pa",
    "/fyll-pa/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f",
    "/vart-lager/mystery",
    "/vart-lager/mystery/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f",
    "/vart-lager/mystery/",
    // Lager, Inköpslistan och Inköpspriserna (delägaren köper in): bara exakt de sökvägarna.
    "/vart-lager",
    "/vart-lager/",
    "/prognos",
    "/inkopspriser",
    "/inkopspriser/",
    // Inventering ("Count stock"): räkna ett helt lager, bara exakt den sökvägen.
    "/vart-lager/inventering",
    "/vart-lager/inventering/",
    "/logga-in",
    "/inbjudan/abc",
  ])("släpper igenom %s", (path) => {
    expect(simpleViewAllows(path)).toBe(true);
  });

  it.each([
    "//",
    "/?",
    "/lonsamhet",
    "/installningar",
    "/installningar/anvandare",
    "/installningar/konto",
    "/vart-lager/flytta",
    "/vart-lager/x",
    "/vart-lager/inventering/x",
    "/vart-lager/inventeringx",
    "/vart-lagerx",
    "/inkopspriser/ny-produkt",
    "/inkopspriser/ny-produkt/bild",
    "/inkopspriserx",
    "/prognos/x",
    "/prognosx",
    "/lager",
    "/vinst",
    "/butiker?vy=utbetalning",
    "/ekonomi",
    "/bokforing",
    "/rapporter",
    "/automater",
    "/inkorg",
    "/vart-lager/mysteryx",
    "/forsaljningar",
    "/fyll-pax",
    // Utskriften av QR-koden: svensk sida med länk till Automater, inte för den enkla vyn.
    "/fyll-pa/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f/qr",
    "/fyll-pa/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f/qr/",
    "/att-gora",
    "/drift",
    "/assistent",
    "/sok",
    "/order",
    "/installningar/export",
    "/fyll-pa/../lonsamhet",
    "/vart-lager/mystery/../../installningar",
    "fyll-pa",
    "",
    "/fyll-pa\\..\\installningar",
  ])("stoppar %s", (path) => {
    expect(simpleViewAllows(path)).toBe(false);
  });
});

describe("Enkel vy: butikernas andel och utbetalningen är bara för ägaren i full vy", () => {
  // Proxyn skickar bara sökvägen (utan ?vy=…): /butiker?vy=utbetalning är /butiker.
  it("fliken Utbetalning (/butiker?vy=utbetalning) och butikssidorna stoppas", () => {
    const tabs = navSections.flatMap((s) => s.tabs).filter((t) => t.label === "Utbetalning");
    expect(tabs).toHaveLength(1);
    const href = subTabHref(tabs[0]!);
    expect(href).toBe("/butiker?vy=utbetalning");
    expect(simpleViewAllows(new URL(href, "http://x").pathname)).toBe(false);
    // Även om sökvägen någon gång skulle komma med frågan.
    expect(simpleViewAllows(href)).toBe(false);
  });

  it.each([
    "/butiker",
    "/butiker/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f",
    "/avtal",
    "/avtal/x/fil",
    "/expansion",
    "/att-gora",
    "/lonsamhet",
    "/installningar/export",
    "/assistent/fraga",
  ])("stoppar %s", (path) => {
    expect(simpleViewAllows(path)).toBe(false);
  });

  it("varje flik i hela appens meny utom de i den enkla vyn stoppas", () => {
    const allowed = new Set([
      "/",
      "/forsaljning",
      REFILL_HREF,
      MYSTERY_HREF,
      STOCK_HREF,
      BUY_LIST_HREF,
      PRICES_HREF,
    ]);
    for (const t of navSections.flatMap((s) => s.tabs)) {
      const path = new URL(subTabHref(t), "http://x").pathname;
      expect(simpleViewAllows(path), path).toBe(allowed.has(path));
    }
  });
});

describe("Enkel vy: flikar och startsida", () => {
  it("ägaren ser Fyll på, Försäljning, Lager och Mystery i den ordningen", () => {
    expect(simpleTabsFor("owner").map((t) => t.href)).toEqual([
      REFILL_HREF,
      SALES_HREF,
      STOCK_HREF,
      MYSTERY_HREF,
    ]);
    expect(simpleHomeFor("owner")).toBe(SALES_HREF);
    expect(SALES_HREF).toBe("/");
  });

  it("påfyllaren ser ingen försäljning och börjar på Fyll på", () => {
    expect(simpleTabsFor("refiller").map((t) => t.id)).toEqual(["refill", "mystery"]);
    expect(simpleHomeFor("refiller")).toBe(REFILL_HREF);
  });

  it("läsaren fyller inte på", () => {
    expect(simpleTabsFor("viewer").map((t) => t.id)).toEqual(["sales", "stock", "mystery"]);
    expect(simpleHomeFor("viewer")).toBe(SALES_HREF);
  });

  it("påfyllaren ser inte Lager (inköp och priser är ekonomi)", () => {
    expect(simpleTabsFor("refiller").some((t) => t.id === "stock")).toBe(false);
  });

  it("varje flik, underflik och startsida är själv tillåten", () => {
    for (const role of ["owner", "admin", "refiller", "viewer"] as const) {
      expect(simpleViewAllows(simpleHomeFor(role))).toBe(true);
      for (const tab of simpleTabsFor(role)) expect(simpleViewAllows(tab.href)).toBe(true);
    }
    expect(STOCK_SUBTABS.map((s) => s.href)).toEqual([STOCK_HREF, BUY_LIST_HREF, PRICES_HREF]);
    for (const sub of STOCK_SUBTABS) expect(simpleViewAllows(sub.href)).toBe(true);
  });

  it("Lager är markerad på sina tre underflikar men inte på Mystery", () => {
    const stock = SIMPLE_TABS.find((t) => t.id === "stock")!;
    const mystery = SIMPLE_TABS.find((t) => t.id === "mystery")!;
    expect(COUNT_HREF).toBe("/vart-lager/inventering");
    for (const path of [STOCK_HREF, `${STOCK_HREF}/`, BUY_LIST_HREF, PRICES_HREF, COUNT_HREF]) {
      expect(simpleTabActive(stock, path), path).toBe(true);
      expect(simpleTabActive(mystery, path), path).toBe(false);
    }
    for (const path of [MYSTERY_HREF, `${MYSTERY_HREF}/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f`]) {
      expect(simpleTabActive(stock, path), path).toBe(false);
      expect(simpleTabActive(mystery, path), path).toBe(true);
    }
    const refill = SIMPLE_TABS.find((t) => t.id === "refill")!;
    expect(simpleTabActive(refill, "/fyll-pa/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f")).toBe(true);
    expect(simpleTabActive(refill, "/fyll-pax")).toBe(false);
  });
});
