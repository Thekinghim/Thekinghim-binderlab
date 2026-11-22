import { describe, expect, it } from "vitest";

import { buildHistory } from "./history-model";

describe("buildHistory", () => {
  it("blandar händelserna, nyast först, utan belopp", () => {
    const out = buildHistory({
      fills: [
        { at: "2026-11-04T10:00:00.000Z", who: "Kim", packs: 23, titles: 2 },
        { at: "2026-11-01T10:00:00.000Z", who: null, packs: 1, titles: 1 },
        { at: "2026-11-02T10:00:00.000Z", who: "Kim", packs: 0, titles: 0 },
      ],
      counts: [{ at: "2026-11-03T08:00:00.000Z", titles: 3 }],
      swaps: [
        {
          at: "2026-11-05T09:00:00.000Z",
          channel: "A2",
          from: "Black Bolt",
          to: "Surging Sparks",
          returned: 4,
          taken: 6,
        },
      ],
      offline: [{ at: "2026-11-06T09:00:00.000Z", message: null }],
      placements: [{ from: "2026-09-01", storeName: "Butiken" }],
    });
    expect(out.map((e) => [e.kind, e.title, e.detail])).toEqual([
      ["offline", "Offline", "Automaten slutade svara."],
      [
        "swap",
        "Produktbyte · Fack A2",
        "Black Bolt → Surging Sparks · 4 pack tillbaka till lagret, 6 pack ur lagret",
      ],
      ["fill", "Påfylld av Kim", "23 pack · 2 titlar"],
      ["count", "Inventering", "3 titlar räknade"],
      ["fill", "Påfylld", "1 pack · 1 titel"],
      ["placed", "Installerad", "Start · Butiken"],
    ]);
    expect(out[0]!.alert).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/kr|ore|öre/);
  });

  it("begränsar antalet rader", () => {
    const fills = Array.from({ length: 60 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      who: null,
      packs: 1,
      titles: 1,
    }));
    const out = buildHistory({ fills, counts: [], swaps: [], offline: [], placements: [] });
    expect(out).toHaveLength(40);
    expect(out[0]!.at).toBe(fills[59]!.at);
  });
});
