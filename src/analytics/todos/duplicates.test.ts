import { describe, expect, it } from "vitest";
import { computeTodos } from "./index";
import { daily, input, NOW, title } from "./test-helpers";
import type { TodoInput } from "./types";

const dups = (i: TodoInput) => computeTodos(i, NOW).filter((t) => t.kind === "duplicate-title");

describe("titlar som kan slås ihop", () => {
  it("föreslår 'Black bolt' → 'Black Bolt' (färre order in i fler)", () => {
    const i = input({
      titles: [
        title("a", "Black Bolt"),
        title("b", "Black bolt"),
        title("c", "Mystery Pack"),
        title("d", "Mystery pack premium"),
      ],
      orders: [...daily("a", "m1", "2026-10-20", 10, 4), ...daily("b", "m1", "2026-10-30", 3, 1)],
    });
    const todos = dups(i);
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      key: "duplicate-title:a:b",
      level: "later",
      title: 'Slå ihop "Black bolt" med "Black Bolt"',
      detail:
        'Namnen skiljer sig bara i versaler, accenter eller skiljetecken. "Black bolt" har 3 order, "Black Bolt" har 40 order.',
      link: "/titlar?slaihop=b&med=a",
      action: { kind: "merge-titles", params: { fromTitleId: "b", intoTitleId: "a" } },
      atStakeOre: 3_430, // 3 × 49 kr × 7 / 30
    });
    expect(todos[0]?.evidence.titleIds).toEqual(["a", "b"]);
    expect(todos[0]?.evidence.orderIds).toHaveLength(43);
  });

  it("'Mystery Pack' och 'Mystery pack premium' föreslås inte", () => {
    const i = input({ titles: [title("c", "Mystery Pack"), title("d", "Mystery pack premium")] });
    expect(dups(i)).toHaveLength(0);
  });

  it("arkiverade titlar jämförs inte", () => {
    const i = input({
      titles: [title("a", "Black Bolt"), title("b", "Black bolt", { archived: true })],
    });
    expect(dups(i)).toHaveLength(0);
  });

  it("lika många order: titeln med lägst id behålls", () => {
    const i = input({ titles: [title("z", "Surgnig Sparks"), title("y", "Surging Sparks")] });
    expect(dups(i)[0]?.action?.params).toEqual({ fromTitleId: "z", intoTitleId: "y" });
    expect(dups(i)[0]?.key).toBe("duplicate-title:y:z");
  });

  it("fingerprint ändras när ett namn ändras", () => {
    const a = dups(input({ titles: [title("a", "Black Bolt"), title("b", "Black bolt")] }))[0];
    const b = dups(input({ titles: [title("a", "Black Bolt"), title("b", "Black  bolt")] }))[0];
    expect(a?.key).toBe(b?.key);
    expect(a?.fingerprint).not.toBe(b?.fingerprint);
  });
});
