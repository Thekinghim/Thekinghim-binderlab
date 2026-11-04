import { describe, expect, it } from "vitest";

import { ALERT_LIST_HREF, alertCountLink, DRIFT_TABS, driftTabActive } from "./nav";

describe("Drifts undersidor", () => {
  it("inställningarna heter Notiser, inte Larm (larmen står på Status)", () => {
    expect(DRIFT_TABS.map((t) => t.label)).toEqual(["Status", "Besök", "Påfyllning", "Notiser"]);
  });

  it("automatsidorna hör till Status", () => {
    expect(driftTabActive("/drift", "/drift/automat/abc")).toBe(true);
    expect(driftTabActive("/drift", "/drift/larm")).toBe(false);
    expect(driftTabActive("/drift/larm", "/drift/larm")).toBe(true);
  });
});

describe("antalet larm", () => {
  it("länkar till larmlistan", () => {
    expect(alertCountLink(5, 2)).toEqual({
      label: "5 öppna larm, 2 kritiska",
      href: ALERT_LIST_HREF,
    });
    expect(alertCountLink(1, 1)?.label).toBe("1 öppet larm, 1 kritiskt");
    expect(alertCountLink(3, 0)?.label).toBe("3 öppna larm");
    expect(ALERT_LIST_HREF).toBe("/drift#larm-sektion");
  });

  it("inga larm: ingen länk", () => {
    expect(alertCountLink(0, 0)).toBeNull();
  });
});
