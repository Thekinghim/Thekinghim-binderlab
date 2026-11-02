import { describe, expect, it } from "vitest";

import { orderCountOf, withOrderCounts } from "./slim";

describe("withOrderCounts", () => {
  it("byter order-id mot antalet på alla nivåer och lämnar resten orört", () => {
    const value = {
      text: "x",
      evidence: { rule: "r", orderIds: ["a", "b", "c"], dates: ["2026-10-01"] },
      points: [{ month: "2026-10", evidence: { orderIds: ["d"], dates: [] } }, { month: null }],
    };
    const slim = withOrderCounts(value);
    expect(slim).toEqual({
      text: "x",
      evidence: { rule: "r", orderIds: [], orderCount: 3, dates: ["2026-10-01"] },
      points: [
        { month: "2026-10", evidence: { orderIds: [], orderCount: 1, dates: [] } },
        { month: null },
      ],
    });
    expect(value.evidence.orderIds).toEqual(["a", "b", "c"]);
    expect(orderCountOf(slim.evidence)).toBe(3);
    expect(orderCountOf(value.evidence)).toBe(3);
    expect(withOrderCounts(slim)).toEqual(slim);
  });
});
