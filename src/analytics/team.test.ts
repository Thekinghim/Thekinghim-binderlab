import { describe, expect, it } from "vitest";

import { BOTH, isMine, personLabel, personOptions, todoAssignee } from "./team";

const ME = "u-me";
const CO = "u-co";
const team = [
  { userId: ME, name: "Ägaren" },
  { userId: CO, name: "Kim" },
];

describe("isMine", () => {
  it("Båda (null) och jag är mina, delägarens är inte", () => {
    expect(isMine(null, ME)).toBe(true);
    expect(isMine(undefined, ME)).toBe(true);
    expect(isMine(ME, ME)).toBe(true);
    expect(isMine(CO, ME)).toBe(false);
  });
});

describe("personLabel och personOptions", () => {
  it("Jag, namnet, Delägaren utan namn och Båda", () => {
    expect(personLabel(ME, ME, team)).toBe("Jag");
    expect(personLabel(CO, ME, team)).toBe("Kim");
    expect(personLabel("u-x", ME, team)).toBe("Delägaren");
    expect(personLabel(null, ME, team)).toBe("Båda");
  });

  it("ordningen är Jag, övriga, Båda; ett sparat val som inte finns tas med", () => {
    expect(personOptions(ME, team)).toEqual([
      { value: ME, label: "Jag" },
      { value: CO, label: "Kim" },
      { value: BOTH, label: "Båda" },
    ]);
    expect(personOptions(ME, team, "u-gone").map((o) => o.label)).toEqual([
      "Jag",
      "Kim",
      "Delägaren",
      "Båda",
    ]);
    // Påfyllaren ser bara sig själv (RLS): Jag och Båda.
    expect(personOptions(ME, []).map((o) => o.label)).toEqual(["Jag", "Båda"]);
  });
});

describe("todoAssignee", () => {
  const responsibles = new Map<string, string | null>([
    ["m1", CO],
    ["m2", null],
  ]);
  it("uttrycklig tilldelning går före automatens ansvariga, även Båda", () => {
    const item = { key: "refill:m1:t1", machineIds: ["m1"] };
    expect(todoAssignee(item, new Map([[item.key, ME]]), responsibles)).toEqual({
      userId: ME,
      source: "assigned",
    });
    expect(todoAssignee(item, new Map([[item.key, null]]), responsibles)).toEqual({
      userId: null,
      source: "assigned",
    });
  });

  it("annars automatens ansvariga när punkten gäller en automat, annars Båda", () => {
    expect(
      todoAssignee({ key: "refill:m1:t1", machineIds: ["m1"] }, new Map(), responsibles),
    ).toEqual({ userId: CO, source: "machine" });
    expect(
      todoAssignee({ key: "refill:m2:t1", machineIds: ["m2"] }, new Map(), responsibles).userId,
    ).toBeNull();
    expect(
      todoAssignee({ key: "contract:c", machineIds: ["m1", "m2"] }, new Map(), responsibles),
    ).toEqual({ userId: null, source: "none" });
  });
});
