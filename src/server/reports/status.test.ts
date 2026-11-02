import { describe, expect, it } from "vitest";

import { reportStatuses, type StatusRow } from "./status";

const row = (p: Partial<StatusRow> & { id: string }): StatusRow => ({
  kind: "store_statement",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  storeId: "s-1",
  generatedAt: "2026-11-01T05:00:00.000Z",
  approved: false,
  deliveries: [],
  ...p,
});

describe("reportStatuses", () => {
  it("utkast, godkänd, skickad och ersatt", () => {
    const statuses = reportStatuses([
      row({ id: "a", generatedAt: "2026-11-01T05:00:00.000Z" }),
      row({ id: "b", generatedAt: "2026-11-02T08:00:00.000Z", approved: true }),
      row({ id: "c", storeId: "s-2" }),
      row({
        id: "d",
        kind: "accountant_statement",
        storeId: null,
        approved: true,
        deliveries: [{ status: "failed" }, { status: "sent" }],
      }),
      row({ id: "e", kind: "owner_statement", storeId: null, deliveries: [{ status: "bounced" }] }),
    ]);
    expect(Object.fromEntries(statuses)).toEqual({
      a: "superseded",
      b: "approved",
      c: "draft",
      d: "sent",
      e: "draft",
    });
  });

  it("en skickad rapport blir aldrig ersatt", () => {
    const statuses = reportStatuses([
      row({ id: "old", approved: true, deliveries: [{ status: "delivered" }] }),
      row({ id: "new", generatedAt: "2026-11-03T08:00:00.000Z" }),
    ]);
    expect(statuses.get("old")).toBe("sent");
    expect(statuses.get("new")).toBe("draft");
  });
});
