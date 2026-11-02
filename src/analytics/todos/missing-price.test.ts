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
      fingerprint: "2026-10-20",
      atStakeOre: 34_300, // 30 × 49 kr × 7 / 30
      action: { kind: "add-price", label: "Lägg in inköpspris", params: { titleId: "t2" } },
    });
    expect(t2?.detail).toBe(
      "Black Bolt står för 30\u00a0% av intäkten 4 okt. – 2 nov. (1 470 kr, 30 order) men saknar inköpspris, så de orderna räknas inte in i vinsten.",
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
    expect(t2?.fingerprint).toBe("2026-10-20");
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
