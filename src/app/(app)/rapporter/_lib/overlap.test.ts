import { describe, expect, it } from "vitest";

import { bookkeepingOverlap, type OverlapInput } from "./overlap";

const base: OverlapInput = {
  type: "bokforing",
  range: null,
  month: "2026-10",
  today: "2026-11-03",
  archive: [],
};

describe("bookkeepingOverlap", () => {
  it("eget datum i en avslutad månad överlappar månadspaketet", () => {
    expect(bookkeepingOverlap({ ...base, range: { start: "2026-10-15", end: "2026-10-31" } })).toBe(
      "Överlappar oktoberpaketet – importera inte båda.",
    );
  });

  it("flera månader skrivs ihop", () => {
    expect(bookkeepingOverlap({ ...base, range: { start: "2026-09-20", end: "2026-11-02" } })).toBe(
      "Överlappar september- och oktoberpaketet – importera inte båda.",
    );
    expect(
      bookkeepingOverlap({
        ...base,
        today: "2026-12-01",
        range: { start: "2026-09-20", end: "2026-11-02" },
      }),
    ).toBe("Överlappar september-, oktober- och novemberpaketet – importera inte båda.");
  });

  it("pågående månad: bara ett annat arkiverat underlag ger varning", () => {
    const range = { start: "2026-11-01", end: "2026-11-02" };
    expect(bookkeepingOverlap({ ...base, range })).toBeNull();
    expect(
      bookkeepingOverlap({
        ...base,
        range,
        archive: [
          { type: "bokforing", custom: true, period: { start: "2026-11-02", end: "2026-11-03" } },
        ],
      }),
    ).toMatch(/^Överlappar underlaget .*nov.* – importera inte båda\.$/);
    // Samma intervall är samma underlag (ny version), ingen varning.
    expect(
      bookkeepingOverlap({
        ...base,
        range,
        archive: [{ type: "bokforing", custom: true, period: range }],
      }),
    ).toBeNull();
  });

  it("hel månad varnar för ett arkiverat underlag med eget datum i månaden", () => {
    const archive = [
      { type: "bokforing", custom: true, period: { start: "2026-10-15", end: "2026-10-31" } },
      { type: "butik", custom: true, period: { start: "2026-10-01", end: "2026-10-10" } },
    ];
    expect(bookkeepingOverlap({ ...base, archive })).toMatch(
      /^Överlappar underlaget 15–31 okt\. 2026 – /,
    );
    expect(bookkeepingOverlap({ ...base, month: "2026-09", archive })).toBeNull();
  });

  it("bara bokföringsunderlag", () => {
    expect(
      bookkeepingOverlap({
        ...base,
        type: "butik",
        range: { start: "2026-10-15", end: "2026-10-31" },
      }),
    ).toBeNull();
  });
});
