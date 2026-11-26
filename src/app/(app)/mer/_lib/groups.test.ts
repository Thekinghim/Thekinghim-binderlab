import { describe, expect, it } from "vitest";

import type { RouteId } from "@/components/shell/nav";

import { moreGroups } from "./groups";

const SHOWN = new Set<RouteId>([
  "hem",
  "automater",
  "rutt",
  "vart-lager",
  "mer",
  "pengar",
  "butiker",
]);

describe("moreGroups (Mer)", () => {
  it("ägaren: grupper efter flik, varje sida en gång", () => {
    const groups = moreGroups("owner", new Set([...SHOWN, "installningar", "datakallor"]));
    expect(groups.map((g) => g.title)).toEqual([
      "Hem",
      "Automater",
      "Vårt lager",
      "Butiker",
      "Pengar",
      "Övrigt",
    ]);
    const ids = groups.flatMap((g) => g.links.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("installningar");
    expect(ids).not.toContain("datakallor");
    expect(ids).not.toContain("automater");
    expect(ids).toContain("assistent");
    // Flikens namn, inte bara ruttens.
    expect(groups[1]?.links.find((l) => l.id === "lager")?.label).toBe("Lager i automaterna");
  });

  it("påfyllaren: inga sidor med pengar", () => {
    const ids = moreGroups("refiller", SHOWN).flatMap((g) => g.links.map((l) => l.id));
    for (const id of ["lonsamhet", "ekonomi", "utbetalningar", "rapporter", "inkopspriser"]) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toContain("drift");
  });
});
