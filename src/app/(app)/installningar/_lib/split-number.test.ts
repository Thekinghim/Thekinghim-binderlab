import { describe, expect, it } from "vitest";

import { splitFirstNumber } from "./split-number";

describe("splitFirstNumber", () => {
  it("delar vid första heltalet, med tusental", () => {
    expect(splitFirstNumber("2 personer har tillgång.")).toEqual({
      before: "",
      value: 2,
      after: " personer har tillgång.",
    });
    expect(splitFirstNumber("Data till 1\u00a0234 order.")).toEqual({
      before: "Data till ",
      value: 1234,
      after: " order.",
    });
  });
  it("inget tal: hela texten", () => {
    expect(splitFirstNumber("Allt klart.")).toEqual({
      before: "Allt klart.",
      value: null,
      after: "",
    });
  });
});

describe("splitFirstNumber: namn med siffror", () => {
  it("siffror i ett namn är inget tal (Mitt konto visade 'wille1 452')", () => {
    expect(splitFirstNumber("wille1452")).toEqual({ before: "wille1452", value: null, after: "" });
    expect(splitFirstNumber("BL-001 är tom.")).toEqual({
      before: "BL-001 är tom.",
      value: null,
      after: "",
    });
  });
  it("ett fristående tal efter ett namn räknas fortfarande", () => {
    expect(splitFirstNumber("wille1452 har 3 butiker.")).toEqual({
      before: "wille1452 har ",
      value: 3,
      after: " butiker.",
    });
  });
});
