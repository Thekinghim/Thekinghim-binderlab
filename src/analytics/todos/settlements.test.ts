import { describe, expect, it } from "vitest";

import { computeTodos } from "./index";
import { settlementDue, settlementTodos } from "./settlements";
import { createTodoContext } from "./context";
import type { TodoInput } from "./types";

const base: TodoInput = {
  orders: [],
  prices: [],
  agreements: [],
  placements: [],
  settings: { vatRateBp: 0, cardFeeBp: 0 },
  titles: [],
  machines: [],
  stores: [
    { id: "s1", name: "Kafé Ett" },
    { id: "s2", name: "Butik Två" },
  ],
  stock: [],
  reportRecipients: [],
  reportDeliveries: [],
};

const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

describe("settlementTodos", () => {
  it("en punkt per månad, bara belopp > 0", () => {
    const ctx = createTodoContext(
      {
        ...base,
        unpaidSettlements: [
          { id: "a", storeId: "s1", month: "2026-10-01", amountOre: 120_000 },
          { id: "b", storeId: "s2", month: "2026-10-01", amountOre: 30_000 },
          { id: "c", storeId: "s2", month: "2026-09-01", amountOre: 0 },
          { id: "d", storeId: "s1", month: "2026-09-01", amountOre: -5_000 },
        ],
      },
      at("2026-11-03"),
    );
    const todos = settlementTodos(ctx);
    expect(todos).toHaveLength(1);
    const t = todos[0]!;
    expect(t.key).toBe("settlement:2026-10");
    expect(t.kind).toBe("settlement");
    expect(t.title.replace(/ /g, " ")).toBe("Betala 1 500 kr till 2 butiker");
    expect(t.detail).toContain("Kafé Ett, Butik Två");
    expect(t.link).toBe("/butiker?vy=portal&manad=2026-10");
    expect(t.fingerprint).toBe("2|150000");
    expect(t.level).toBe("later");
    expect(t.daysLeft).toBe(12);
  });

  it("en avräkning som inte kan räknas visar inget gammalt belopp att betala", () => {
    const ctx = createTodoContext(
      {
        ...base,
        unpaidSettlements: [
          { id: "a", storeId: "s1", month: "2026-10-01", amountOre: 1_293_000, blocked: true },
        ],
      },
      at("2026-11-03"),
    );
    const [t] = settlementTodos(ctx);
    expect(t!.title).toBe("Räkna klart avräkningen till Kafé Ett");
    expect(t!.title).not.toContain("12");
    expect(t!.detail).toContain("Inköpspris saknas");
    const mixed = settlementTodos(
      createTodoContext(
        {
          ...base,
          unpaidSettlements: [
            { id: "a", storeId: "s1", month: "2026-10-01", amountOre: 50_000 },
            { id: "b", storeId: "s2", month: "2026-10-01", amountOre: 99_000, blocked: true },
          ],
        },
        at("2026-11-03"),
      ),
    )[0]!;
    expect(mixed.title.replace(/\u00a0/g, " ")).toBe("Betala 500 kr till Kafé Ett");
    expect(mixed.detail).toContain("Butik Två kan inte räknas än");
  });

  it("en butik: namnet i rubriken; nivå efter sista dagen", () => {
    const input = {
      ...base,
      unpaidSettlements: [{ id: "a", storeId: "s1", month: "2026-10-01", amountOre: 50_000 }],
    };
    const soon = settlementTodos(createTodoContext(input, at("2026-11-13")))[0]!;
    expect(soon.title.replace(/ /g, " ")).toBe("Betala 500 kr till Kafé Ett");
    expect(soon.level).toBe("soon");
    const late = settlementTodos(createTodoContext(input, at("2026-11-20")))[0]!;
    expect(late.level).toBe("now");
    expect(late.detail).toContain("Skulle ha betalats");
  });

  it("finns i computeTodos och sista dagen är den 15:e", () => {
    expect(settlementDue("2026-12")).toBe("2027-01-15");
    const all = computeTodos(
      {
        ...base,
        unpaidSettlements: [{ id: "a", storeId: "s1", month: "2026-10-01", amountOre: 1 }],
      },
      at("2026-11-03"),
    );
    expect(all.some((t) => t.kind === "settlement")).toBe(true);
  });
});
