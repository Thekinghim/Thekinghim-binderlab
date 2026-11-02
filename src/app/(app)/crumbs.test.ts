import { describe, expect, it } from "vitest";

import { crumbsFor, subpageLabel } from "./crumbs";

describe("brödsmulor", () => {
  it("Inställningar → Användare", () => {
    expect(crumbsFor("/installningar/anvandare", "Binderlab")).toEqual([
      "Binderlab",
      "Inställningar",
      "Användare",
    ]);
    expect(crumbsFor("/installningar", "Binderlab")).toEqual(["Binderlab", "Inställningar"]);
  });

  it("undersidor och dynamiska sidor", () => {
    expect(subpageLabel("/automater/enhetsekonomi")).toBe("Enhetsekonomi");
    expect(subpageLabel("/automater/bl-003")).toBe("Automat");
    expect(subpageLabel("/drift/besok/")).toBe("Besöksplan");
    expect(subpageLabel("/inkorg/nytt")).toBe("Nytt ärende");
    expect(subpageLabel("/inkorg/0b5c")).toBe("Ärende");
    expect(subpageLabel("/lonsamhet")).toBeNull();
  });

  it("sidor utanför menyn och utan organisation", () => {
    expect(crumbsFor("/kom-igang", "Binderlab")).toEqual(["Binderlab", "Kom igång"]);
    expect(crumbsFor("/att-gora", undefined)).toEqual(["Att göra"]);
  });
});
