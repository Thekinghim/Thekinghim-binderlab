import { describe, expect, it } from "vitest";

import { seenText } from "./seen-text";

describe("seenText", () => {
  it("säger rakt ut när inget utskick har gått fram", () => {
    expect(seenText({ occurrences: 10, lastSeen: "19 nov. 09:10", delivered: 0 })).toBe(
      "Sett 10 gånger, senast 19 nov. 09:10. Inget utskick har gått fram till någon.",
    );
  });

  it("räknar utskicken som gått fram, inte aviseringarna", () => {
    expect(seenText({ occurrences: 1, lastSeen: "i dag 07:00", delivered: 3 })).toBe(
      "Sett 1 gång, senast i dag 07:00. 3 utskick har gått fram.",
    );
  });

  it("visar inget om utskick för den som inte får se andras", () => {
    expect(seenText({ occurrences: 2, lastSeen: "i går 12:00", delivered: null })).toBe(
      "Sett 2 gånger, senast i går 12:00.",
    );
  });
});
