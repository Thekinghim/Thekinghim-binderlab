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
