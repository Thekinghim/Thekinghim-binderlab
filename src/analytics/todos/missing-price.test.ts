import { describe, expect, it } from "vitest";
import { computeTodos } from "./index";
import { daily, input, NOW, title } from "./test-helpers";
import type { TodoInput } from "./types";

const missing = (i: TodoInput) => computeTodos(i, NOW).filter((t) => t.kind === "missing-price");

// Fönstret: 30 dagar t.o.m. i dag = 4 okt.–2 nov. 2026.
const base = (p: Partial<TodoInput> = {}) =>
  input({
    titles: [title("t1", "Mystery Pack"), title("t2", "Black Bolt"), title("t3", "Stellar Crown")],
    orders: [
      ...daily("t1", "m1", "2026-10-20", 10, 7), // 70 order, pris finns
      ...daily("t2", "m1", "2026-10-20", 10, 3), // 30 order utan pris = 30 %
      ...daily("t3", "m1", "2026-10-20", 1, 1), // 1 order utan pris = 1 %
      ...daily("t2", "m1", "2026-09-01", 5, 5), // utanför fönstret
    ],
    prices: [{ titleId: "t1", unitCostOre: 2_500, validFrom: "2026-01-01" }],
    ...p,
  });

describe("titlar utan inköpspris", () => {
  it("visar titeln med andel av intäkten och länk till inköpspriser", () => {
    const todos = missing(base());
    expect(todos.map((t) => t.key)).toEqual(["missing-price:t2", "missing-price:t3"]);
    const [t2, t3] = todos;
    expect(t2).toMatchObject({
      title: "Lägg in inköpspris för Black Bolt",
      level: "soon",
      link: "/inkopspriser?titel=t2",
      fingerprint: "soon|-", // nivå + senaste prisändring (inget pris)
      atStakeOre: 34_300, // 30 × 49 kr × 7 / 30
      action: { kind: "add-price", label: "Lägg in inköpspris", params: { titleId: "t2" } },
    });
    expect(t2?.detail).toBe(
      "Black Bolt står för 29,7\u00a0% av intäkten 4 okt. –\u2060 2 nov. (1 470 kr, 30 order) men saknar inköpspris och räknas därför inte in i vinsten.",
    );
    expect(t2?.evidence.orderIds).toHaveLength(30);
    expect(t2?.evidence.figures.find((f) => f.key === "shareBp")?.value).toBe(2_970);
    expect(t3).toMatchObject({ level: "later" });
  });

  it("titel med pris från en dag efter några order: bara de tidigare orderna saknar pris", () => {
    const i = base({
      prices: [
        { titleId: "t1", unitCostOre: 2_500, validFrom: "2026-01-01" },
        { titleId: "t2", unitCostOre: 2_500, validFrom: "2026-10-25" },
        { titleId: "t3", unitCostOre: 2_500, validFrom: "2026-01-01" },
      ],
    });
    const [t2] = missing(i);
    expect(t2?.evidence.orderIds).toHaveLength(15); // 20–24 okt.
    expect(t2?.fingerprint).toBe("soon|2026-10-25");
  });

  it("inga punkter när alla titlar har pris eller inga order finns", () => {
    const priced = base({
      prices: ["t1", "t2", "t3"].map((titleId) => ({
        titleId,
        unitCostOre: 2_000,
        validFrom: "2026-01-01",
      })),
    });
    expect(missing(priced)).toHaveLength(0);
    expect(missing(input())).toHaveLength(0);
  });

  it("andelsgränsen för 'soon' är 10 %", () => {
    const i = input({
      titles: [title("a", "A"), title("b", "B")],
      orders: [...daily("a", "m1", "2026-10-20", 9, 1), ...daily("b", "m1", "2026-10-20", 1, 1)],
      prices: [{ titleId: "a", unitCostOre: 1_000, validFrom: "2026-01-01" }],
    });
    expect(missing(i)[0]).toMatchObject({ key: "missing-price:b", level: "soon" });
  });
});

describe("avbockning av saknat inköpspris", () => {
  // Black Bolt säljer utan pris varje dag sedan 1 sep., så fönstrets första dag flyttas varje dag.
  const longRunning = base({
    orders: [...daily("t1", "m1", "2026-09-01", 64, 1), ...daily("t2", "m1", "2026-09-01", 64, 1)],
  });
  const fp = (i: TodoInput, now: string) =>
    computeTodos(i, now).find((t) => t.key === "missing-price:t2")?.fingerprint;

  it("fingerprint är detsamma nästa dag och nästa vecka när orsaken är oförändrad", () => {
    expect(fp(longRunning, NOW)).toBe("soon|-");
    expect(fp(longRunning, "2026-11-03T10:00:00Z")).toBe("soon|-");
    expect(fp(longRunning, "2026-11-09T10:00:00Z")).toBe(fp(longRunning, NOW));
  });

  it("fingerprint ändras när ett pris läggs in som inte täcker alla order", () => {
    const partly: TodoInput = {
      ...longRunning,
      prices: [
        ...longRunning.prices,
        { titleId: "t2", unitCostOre: 2_500, validFrom: "2026-10-30" },
      ],
    };
    expect(fp(partly, NOW)).toBe("soon|2026-10-30");
  });

  it("fingerprint ändras när titeln blir viktigare ('later' → 'soon')", () => {
    const small = base({
      orders: [...daily("t1", "m1", "2026-10-20", 10, 7), ...daily("t2", "m1", "2026-11-01", 1, 1)],
    });
    expect(fp(small, NOW)).toBe("later|-");
    expect(fp(base(), NOW)).toBe("soon|-");
  });

  it("texten är en hel mening utan klumpig formulering", () => {
    const t = missing(base())[0];
    expect(t?.detail).toMatch(/men saknar inköpspris och räknas därför inte in i vinsten\.$/);
  });
});
