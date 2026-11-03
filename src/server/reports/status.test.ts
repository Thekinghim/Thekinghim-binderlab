import { describe, expect, it } from "vitest";

import { monthEnd, reportStatuses, staleImportDay, type StatusRow } from "./status";

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

describe("staleImportDay", () => {
  const TZ = "Europe/Stockholm";
  it("monthEnd ger sista dagen i månaden", () => {
    expect(monthEnd("2026-10")).toBe("2026-10-31");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
  });
  it("varnar när perioden slutar efter senaste synken", () => {
    expect(staleImportDay("2026-10-31", "2026-10-28T06:51:00.000Z", TZ)).toBe("2026-10-28");
    // 23.30 UTC den 31 är 1 nov. 00.30 i Stockholm: perioden är täckt.
    expect(staleImportDay("2026-10-31", "2026-10-31T23:30:00.000Z", TZ)).toBeNull();
    expect(staleImportDay("2026-10-31", "2026-11-02T08:00:00.000Z", TZ)).toBeNull();
  });
  it("ingen synk eller ogiltig tid ger ingen varning", () => {
    expect(staleImportDay("2026-10-31", null, TZ)).toBeNull();
    expect(staleImportDay("2026-10-31", "inte en tid", TZ)).toBeNull();
  });
});
