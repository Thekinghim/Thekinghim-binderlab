import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  formatOwnerCostReport,
  normalizeTitleKey,
  parseOwnerCostFile,
  planOwnerCosts,
  type KnownTitle,
} from "./owner-costs";

const raw = JSON.parse(
  readFileSync(
    new URL("../../../../../scripts/db/data/owner-costs-2026-10-15.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
const file = parseOwnerCostFile(raw);

const title = (titleId: string, ...names: string[]): KnownTitle => ({
  titleId,
  titleName: names[0]!,
  keys: names.map(normalizeTitleKey),
});

describe("datafilen", () => {
  it("har 11 kostnader exkl. moms från 2026-10-15 och två saknade", () => {
    expect(file.validFrom).toBe("2026-10-15");
    expect(file.entries.filter((e) => e.unitCostOre !== null)).toHaveLength(11);
    expect(file.entries.filter((e) => e.status === "missing").map((e) => e.name)).toEqual([
      "Mystery Pack Premium",
      "Perfect Order",
    ]);
    expect(file.entries.filter((e) => e.needsConfirmation).map((e) => e.name)).toEqual([
      "Black Bolt",
      "Ascended Heroes",
    ]);
    expect(file.questions).toHaveLength(6);
  });

  it("stoppar en saknad kostnad som har ett belopp och delade alias", () => {
    const entries = file.entries.map((e) => ({ ...e }));
    expect(() =>
      parseOwnerCostFile({
        ...raw,
        entries: [{ name: "X", aliases: [], unitCostOre: 100, status: "missing" }],
      }),
    ).toThrow(/missing/);
    expect(() =>
      parseOwnerCostFile({
        ...raw,
        entries: [
          ...entries,
          { name: "Y", aliases: ["black  BOLT"], unitCostOre: 1, status: "ok" },
        ],
      }),
    ).toThrow(/delar alias/);
  });
});

describe("planOwnerCosts", () => {
  it("matchar alias utan hänsyn till skiftläge och mellanslag", () => {
    expect(normalizeTitleKey("  Mystery   pack PREMIUM ")).toBe("mystery pack premium");
    const plan = planOwnerCosts(file, [title("a", "destin  rivals")], []);
    expect(plan.rows.find((r) => r.entry === "Destined Rivals")).toMatchObject({
      kind: "insert",
      titleId: "a",
      unitCostOre: 8000,
      previousOre: null,
    });
  });

  it("hoppar över samma pris, stoppar vid annat pris samma datum", () => {
    const titles = [title("a", "White Flair"), title("b", "Surging Sparks")];
    const plan = planOwnerCosts(file, titles, [
      { titleId: "a", validFrom: "2026-10-15", unitCostOre: 15000 },
      { titleId: "b", validFrom: "2026-10-15", unitCostOre: 1 },
    ]);
    expect(plan.rows.find((r) => r.entry === "White Flair")?.kind).toBe("unchanged");
    expect(plan.rows.find((r) => r.entry === "Surging Sparks")).toMatchObject({
      kind: "conflict",
      existingOre: 1,
    });
    expect(plan.blocked).toBe(true);
  });

  it("samma pris som redan gäller sedan tidigare skrivs inte igen", () => {
    const plan = planOwnerCosts(
      file,
      [title("a", "Mystery Pack")],
      [{ titleId: "a", validFrom: "2026-10-01", unitCostOre: 13000 }],
    );
    expect(plan.rows.find((r) => r.entry === "Mystery Pack")?.kind).toBe("unchanged");
  });

  it("flaggade rader väntar på --confirm-flagged", () => {
    const titles = [title("a", "Black bolt")];
    expect(planOwnerCosts(file, titles, []).rows.find((r) => r.entry === "Black Bolt")?.kind).toBe(
      "flagged",
    );
    expect(
      planOwnerCosts(file, titles, [], { confirmFlagged: true }).rows.find(
        (r) => r.entry === "Black Bolt",
      )?.kind,
    ).toBe("insert");
  });

  it("anger senare pris, saknade, omatchade, tvetydiga och titlar utan pris", () => {
    const plan = planOwnerCosts(
      file,
      [
        title("a", "30th Celebration"),
        title("b", "Mystery pack premium"),
        title("c", "Ascended Heroes"),
        title("d", "Ascended Heroes · engelska"),
        title("e", "Paldea Evolved"),
      ],
      [{ titleId: "a", validFrom: "2026-10-27", unitCostOre: 11200 }],
    );
    const by = (entry: string) => plan.rows.find((r) => r.entry === entry);
    expect(by("30th Celebration")).toMatchObject({
      kind: "insert",
      laterFrom: "2026-10-27",
      note: "Ägarens kostnad exkl. moms · Äldre uppgift, bekräfta",
    });
    expect(by("Mystery Pack Premium")).toEqual({
      kind: "missing",
      entry: "Mystery Pack Premium",
      titleName: "Mystery pack premium",
    });
    expect(by("Ascended Heroes")?.kind).toBe("ambiguous");
    expect(by("Perfect Order")).toMatchObject({ kind: "missing", titleName: null });
    expect(by("White Flair")?.kind).toBe("unmatched");
    expect(plan.uncoveredTitles).toEqual([
      "Ascended Heroes",
      "Ascended Heroes · engelska",
      "Paldea Evolved",
    ]);
    expect(plan.blocked).toBe(false);

    const report = formatOwnerCostReport(plan, file, { applied: false }).join("\n");
    expect(report).toContain(
      "30th Celebration: 133,00 kr, saknades (gäller t.o.m. dagen före 2026-10-27)",
    );
    expect(report).toContain("Frågor till ägaren:");
    expect(report).toContain("Torrkörning. Inget skrevs.");
  });
});
