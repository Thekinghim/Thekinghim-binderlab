/**
 * Kolumnmenyn i DataTable öppnas ovanför knappen när den inte ryms under. På /butiker
 * (1 440 × 900) låg knappen nära fönstrets nederkant och menyn hamnade på y 844–1044,
 * utanför fönstret.
 */

import { describe, expect, it } from "vitest";

import { columnMenuHeight, menuSide } from "./data-table";

describe("menuSide", () => {
  it("öppnar uppåt när menyn inte ryms under knappen men ryms ovanför", () => {
    const button = { top: 808, bottom: 840 };
    expect(menuSide(button, columnMenuHeight(5), 900)).toBe("above");
  });

  it("öppnar nedåt när menyn ryms under knappen", () => {
    const button = { top: 200, bottom: 232 };
    expect(menuSide(button, columnMenuHeight(11), 900)).toBe("below");
  });

  it("öppnar nedåt när det ändå är mer plats under (sidan kan rullas)", () => {
    const button = { top: 100, bottom: 132 };
    expect(menuSide(button, columnMenuHeight(30), 700)).toBe("below");
  });

  it("räknar menyns höjd ur antalet kolumner (rader om 32 px plus fot)", () => {
    expect(columnMenuHeight(5)).toBe(203);
  });
});
