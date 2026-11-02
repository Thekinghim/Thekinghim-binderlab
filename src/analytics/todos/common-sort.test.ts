/** Prestanda (fas 7): uniqueSorted med standardsorteringen ger samma ordning som `<`. */

import { describe, expect, it } from "vitest";

import { uniqueSorted } from "./common";

describe("uniqueSorted", () => {
  it("sorterar som jämförelse med < och tar bort dubbletter", () => {
    const values = [
      "b",
      "a",
      "B",
      "Ä",
      "å",
      "z",
      "10",
      "9",
      "",
      "a",
      "\u{1F600}",
      "～",
      "cfbe6ac3-a2c8-451c-a0b7-c33d353f5cf8",
      "CFBE6AC3-a2c8-451c-a0b7-c33d353f5cf8",
      "2026-11-02",
      "2026-11-1",
    ];
    const expected = [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(uniqueSorted(values)).toEqual(expected);
  });
});
