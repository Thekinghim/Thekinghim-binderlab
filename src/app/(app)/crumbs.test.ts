import { describe, expect, it } from "vitest";

import { v2MobileNavForRole } from "@/components/shell/nav";

import { backTargetFor, crumbsFor, subpageLabel } from "./crumbs";

describe("brödsmulor", () => {
  it("Inställningar → Användare", () => {
    expect(crumbsFor("/installningar/anvandare", "Binderlab")).toEqual([
      "Binderlab",
      "Mer",
      "Inställningar",
      "Användare",
    ]);
    expect(crumbsFor("/installningar", "Binderlab")).toEqual(["Binderlab", "Mer", "Inställningar"]);
    expect(crumbsFor("/installningar/kontroll", "Binderlab")).toEqual([
      "Binderlab",
      "Mer",
      "Inställningar",
      "Kontroll",
    ]);
  });

  it("undersidor och dynamiska sidor", () => {
    expect(subpageLabel("/automater/enhetsekonomi")).toBe("Enhetsekonomi");
    expect(subpageLabel("/automater/bl-003")).toBe("Automat");
    expect(subpageLabel("/drift/besok/")).toBe("Besök");
    expect(subpageLabel("/inkorg/nytt")).toBe("Nytt ärende");
    expect(subpageLabel("/inkorg/0b5c")).toBe("Ärende");
    expect(subpageLabel("/lonsamhet")).toBeNull();
    expect(crumbsFor("/vart-lager/inventering", "B")).toEqual(["B", "Vårt lager", "Inventering"]);
  });

  it("sidor utanför menyn och utan organisation", () => {
    expect(crumbsFor("/kom-igang", "Binderlab")).toEqual(["Binderlab", "Kom igång"]);
    expect(crumbsFor("/att-gora", undefined)).toEqual(["Hem", "Att göra"]);
  });

  it("huvudflik / underflik, utan dubbla namn", () => {
    expect(crumbsFor("/", "B")).toEqual(["B", "Hem", "Översikt"]);
    expect(crumbsFor("/automater", "B")).toEqual(["B", "Automater"]);
    expect(crumbsFor("/drift/pafyllning", "B")).toEqual(["B", "Automater", "Drift", "Påfyllning"]);
    expect(crumbsFor("/drift/larm", "B")).toEqual(["B", "Automater", "Drift", "Notiser"]);
    expect(crumbsFor("/automater/svinn", "B")).toEqual(["B", "Automater", "Svinn"]);
    expect(crumbsFor("/automater/bl-001", "B")).toEqual(["B", "Automater", "Automat"]);
    expect(crumbsFor("/butiker/x1", "B")).toEqual(["B", "Butiker", "Butik"]);
    expect(crumbsFor("/ekonomi", "B", "bokforing")).toEqual(["B", "Pengar", "Bokföring"]);
    expect(crumbsFor("/prognos", "B")).toEqual(["B", "Vårt lager", "Inköp"]);
    expect(crumbsFor("/prognos", "B", "prognos")).toEqual(["B", "Vårt lager", "Prognos"]);
    expect(crumbsFor("/inkopspriser/ny-produkt", "B")).toEqual([
      "B",
      "Vårt lager",
      "Inköpspriser",
      "Ny produkt",
    ]);
  });
});

describe("tillbaka-pilens mål", () => {
  const tabs = v2MobileNavForRole("owner");
  const back = (path: string) => backTargetFor(path, tabs);

  it("ingen pil på flikarnas egna sidor", () => {
    for (const path of ["/", "/automater", "/rutt", "/vart-lager", "/mer", "/mer/"]) {
      expect(back(path)).toBeNull();
    }
  });

  it("undersidor går upp en nivå till en sida med namn", () => {
    expect(back("/automater/bl-001")).toEqual({ href: "/automater", label: "Automater" });
    expect(back("/automater/bl-001/styr")).toEqual({ href: "/automater/bl-001", label: "Automat" });
    expect(back("/butiker/ny")).toEqual({ href: "/butiker", label: "Butiker" });
    expect(back("/drift/pafyllning")?.href).toBe("/drift");
    expect(back("/pengar/utbetalningar/abc")?.href).toBe("/pengar/utbetalningar");
    expect(back("/pengar/utbetalningar")?.href).toBe("/pengar");
    expect(back("/datakallor/importer/x1")?.href).toBe("/datakallor");
    expect(back("/vart-lager/inventering")?.href).toBe("/vart-lager");
  });

  it("sidor från Mer går till Mer, sidor under en flik till fliken", () => {
    expect(back("/pengar")).toEqual({ href: "/mer", label: "Mer" });
    expect(back("/butiker")?.href).toBe("/mer");
    expect(back("/installningar")?.href).toBe("/mer");
    expect(back("/assistent")?.href).toBe("/mer");
    expect(back("/drift")?.href).toBe("/mer");
    expect(back("/inkorg")?.href).toBe("/mer");
    expect(back("/lager")?.href).toBe("/automater");
    expect(back("/att-gora")?.href).toBe("/");
    expect(back("/kom-igang")?.href).toBe("/");
    expect(back("/drift/besok")?.href).toBe("/rutt");
  });
});
