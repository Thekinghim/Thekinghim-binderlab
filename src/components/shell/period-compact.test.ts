import { describe, expect, it } from "vitest";

import { compactPeriod } from "./period-compact";

describe("periodraden på mobilen", () => {
  it("en rad med periodens namn och datum", () => {
    expect(compactPeriod("30d", "6 okt. – 4 nov.")).toEqual({
      name: "30 dagar",
      range: "6 okt. – 4 nov.",
      label: "Period: 30 dagar, 6 okt. – 4 nov.",
    });
    expect(compactPeriod("manad", "1 – 4 nov.").name).toBe("Denna månad");
  });

  it("eget intervall heter Eget; samma text skrivs inte två gånger", () => {
    expect(compactPeriod("eget", "1 – 15 okt.").name).toBe("Eget");
    expect(compactPeriod("idag", "I dag")).toEqual({
      name: "I dag",
      range: "",
      label: "Period: I dag",
    });
  });
});
