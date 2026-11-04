import { describe, expect, it } from "vitest";

import { crumbsFor, subpageLabel } from "./crumbs";

describe("brödsmulor", () => {
  it("Inställningar → Användare", () => {
    expect(crumbsFor("/installningar/anvandare", "Binderlab")).toEqual([
      "Binderlab",
      "Mer",
      "Inställningar",
      "Användare",
    ]);
    expect(crumbsFor("/installningar", "Binderlab")).toEqual(["Binderlab", "Mer", "Inställningar"]);
  });

  it("undersidor och dynamiska sidor", () => {
    expect(subpageLabel("/automater/enhetsekonomi")).toBe("Enhetsekonomi");
    expect(subpageLabel("/automater/bl-003")).toBe("Automat");
    expect(subpageLabel("/drift/besok/")).toBe("Besök");
    expect(subpageLabel("/inkorg/nytt")).toBe("Nytt ärende");
    expect(subpageLabel("/inkorg/0b5c")).toBe("Ärende");
    expect(subpageLabel("/lonsamhet")).toBeNull();
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
  });
});
