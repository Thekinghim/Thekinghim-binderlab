import { describe, expect, it } from "vitest";
import { menuRoutesForRole, shellRoutes, type Role } from "./nav";

const sidebar = (role: Role) => {
  const routes = menuRoutesForRole(role);
  return {
    main: routes.filter((r) => r.section === "main" && !r.group).map((r) => r.id),
    more: routes.filter((r) => r.section === "main" && r.group === "more").map((r) => r.id),
    system: routes.filter((r) => r.section === "system").map((r) => r.id),
  };
};

describe("menyns grupper", () => {
  it("ägaren ser 7 primära, 8 under Mer och 2 under System", () => {
    const s = sidebar("owner");
    expect(s.main).toEqual([
      "hem",
      "att-gora",
      "lonsamhet",
      "order",
      "lager",
      "automater",
      "rapporter",
    ]);
    expect(s.more).toHaveLength(8);
    expect(s.more).toContain("butiker");
    expect(s.system).toEqual(["datakallor", "installningar"]);
  });

  it("Avtal och Effekt syns inte i sidomenyn men finns kvar som rutter", () => {
    const s = sidebar("owner");
    for (const id of ["avtal", "effekt", "assistent"] as const) {
      expect([...s.main, ...s.more, ...s.system]).not.toContain(id);
      expect(shellRoutes.some((r) => r.id === id)).toBe(true);
    }
  });

  it("högst 7 primära och 8 under Mer för varje roll", () => {
    for (const role of ["owner", "admin", "viewer", "refiller"] as const) {
      const s = sidebar(role);
      expect(s.main.length).toBeLessThanOrEqual(7);
      expect(s.more.length).toBeLessThanOrEqual(8);
    }
  });

  it("varje rutt ligger i exakt en grupp", () => {
    const ids = shellRoutes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of shellRoutes) {
      const groups = [
        r.section === "system",
        r.section === "main" && !r.group && r.menu !== false,
        r.group === "more",
        r.group === "hidden" || r.menu === false,
      ].filter(Boolean);
      expect(groups, r.id).toHaveLength(1);
    }
  });

  it("påfyllaren ser varken Lönsamhet, Ekonomi, Inköpspriser eller Rapporter", () => {
    const ids = menuRoutesForRole("refiller").map((r) => r.id);
    for (const id of ["lonsamhet", "ekonomi", "inkopspriser", "rapporter"]) {
      expect(ids).not.toContain(id);
    }
  });
});
