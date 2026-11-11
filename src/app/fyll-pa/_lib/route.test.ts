import { describe, expect, it } from "vitest";

import { machineIdFrom, shownMachineId } from "./route";

const A = "067621fb-dec9-415f-8584-1ff013eda035";

describe("automatens id ur adressen i Fyll på", () => {
  it("/fyll-pa/<id> ger id:t", () => {
    expect(machineIdFrom(`/fyll-pa/${A}`)).toBe(A);
    expect(machineIdFrom(`/fyll-pa/${A.toUpperCase()}`)).toBe(A.toUpperCase());
  });

  it("listan, annat än ett id och andra sidor ger null", () => {
    for (const path of ["/fyll-pa", "/fyll-pa/", "/fyll-pa/inte-ett-id", "/drift", "", null]) {
      expect(machineIdFrom(path), String(path)).toBeNull();
    }
    expect(machineIdFrom(undefined)).toBeNull();
  });

  it("det som står efter id:t spelar ingen roll", () => {
    expect(machineIdFrom(`/fyll-pa/${A}/qr`)).toBe(A);
  });
});

describe("vilken skärm som visas (shownMachineId)", () => {
  const base = { nav: null, hydrated: true, pathname: "/fyll-pa", initialMachineId: null };

  it("utan tryck gäller adressen; före hydreringen den automat servern renderade för", () => {
    expect(shownMachineId(base)).toBeNull();
    expect(shownMachineId({ ...base, pathname: `/fyll-pa/${A}` })).toBe(A);
    expect(
      shownMachineId({ ...base, hydrated: false, pathname: "/fyll-pa", initialMachineId: A }),
    ).toBe(A);
  });

  it("efter Klar visas listan direkt, fast Next ännu tror att adressen är automatens", () => {
    // Trycket bytte adressen till listan; usePathname ger fortfarande automaten tills
    // omhämtningen är klar. Förut stod automatens skärm (med Klar-knappen) kvar så länge.
    expect(shownMachineId({ ...base, nav: { machineId: null }, pathname: `/fyll-pa/${A}` })).toBe(
      null,
    );
  });

  it("ett tryck på en automat i listan visar den direkt", () => {
    expect(shownMachineId({ ...base, nav: { machineId: A }, pathname: "/fyll-pa" })).toBe(A);
  });

  it("bakåt i webbläsaren (inget tryck kvar) följer adressen igen", () => {
    expect(shownMachineId({ ...base, nav: null, pathname: `/fyll-pa/${A}` })).toBe(A);
  });
});
