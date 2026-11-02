import { describe, expect, it } from "vitest";
import { computeTodos } from "./index";
import { input, NOW } from "./test-helpers";
import type { ReportDeliveryRef, ReportRecipientRef, TodoInput } from "./types";

const recipients: ReportRecipientRef[] = [
  { id: "r1", name: "Anna", kind: "store", storeId: "s1", active: true },
  { id: "r2", name: "Byrån", kind: "accountant", storeId: null, active: true },
  { id: "r3", name: "Kim", kind: "partner", storeId: null, active: false },
  { id: "r4", name: "Bo", kind: "store", storeId: "s2", active: true }, // ingen automat i s2
];

const delivery = (p: Partial<ReportDeliveryRef>): ReportDeliveryRef => ({
  id: "d1",
  recipientId: "r1",
  reportKind: "store_statement",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  storeId: "s1",
  status: "delivered",
  sentAt: "2026-11-01T09:00:00Z",
  ...p,
});

const reports = (p: Partial<TodoInput> = {}, now = NOW) =>
  computeTodos(input({ reportRecipients: recipients, ...p }), now).filter(
    (t) => t.kind === "report-due",
  );

describe("rapporter att skicka", () => {
  it("förra månadens rapport till varje aktiv mottagare med verksamhet", () => {
    const todos = reports();
    expect(todos.map((t) => t.key)).toEqual(["report-due:r1:2026-10", "report-due:r2:2026-10"]);
    expect(todos[0]).toMatchObject({
      title: "Skicka butiksrapporten för oktober till Anna (ICA Nära)",
      detail: "Ska skickas senast 30 nov. (28 dagar kvar).",
      level: "later",
      daysLeft: 28,
      link: "/rapporter?period=2026-10&mottagare=r1",
      action: {
        kind: "send-report",
        params: { recipientId: "r1", month: "2026-10", reportKind: "store_statement" },
      },
    });
    expect(todos[1]?.title).toBe("Skicka bokföringsunderlaget för oktober till Byrån");
  });

  it("skickad, köad eller levererad rapport tar bort punkten", () => {
    for (const status of ["queued", "sent", "delivered"] as const) {
      expect(reports({ reportDeliveries: [delivery({ status })] }).map((t) => t.key)).toEqual([
        "report-due:r2:2026-10",
      ]);
    }
  });

  it("misslyckat utskick, fel period eller fel typ räknas inte", () => {
    const failed = reports({ reportDeliveries: [delivery({ status: "failed" })] });
    expect(failed[0]?.detail).toContain("Senaste utskicket misslyckades 1 nov.");
    expect(failed[0]?.fingerprint).toBe("1");
    const bounced = reports({ reportDeliveries: [delivery({ status: "bounced" })] });
    expect(bounced[0]?.detail).toContain("studsade");
    const september = reports({
      reportDeliveries: [delivery({ periodStart: "2026-09-01", periodEnd: "2026-09-30" })],
    });
    expect(september).toHaveLength(2);
    const wrongKind = reports({ reportDeliveries: [delivery({ reportKind: "profitability" })] });
    expect(wrongKind).toHaveLength(2);
    const otherRecipient = reports({ reportDeliveries: [delivery({ recipientId: "r9" })] });
    expect(otherRecipient).toHaveLength(2);
  });

  it("nivån följer sista dagen", () => {
    expect(reports({ options: { reportDueDay: 5 } })[0]).toMatchObject({
      level: "soon",
      daysLeft: 3,
    });
    expect(reports({ options: { reportDueDay: 1 } })[0]).toMatchObject({
      level: "now",
      daysLeft: -1,
      detail: "Skulle ha skickats senast 1 nov.",
    });
    expect(reports({ options: { reportDueDay: 2 } })[0]?.detail).toBe("Ska skickas i dag.");
  });

  it("sista dag begränsas till månadens längd", () => {
    const feb = reports({ options: { reportDueDay: 31 } }, "2027-02-10T10:00:00Z");
    expect(feb[0]).toMatchObject({ daysLeft: 18, key: "report-due:r1:2027-01" });
  });

  it("butik vars automat flyttade in under förra månaden får rapport", () => {
    const todos = reports({
      placements: [
        { machineId: "m1", storeId: "s1", from: "2026-01-01", to: "2026-10-14" },
        { machineId: "m1", storeId: "s2", from: "2026-10-15", to: null },
      ],
    });
    expect(todos.map((t) => t.key)).toContain("report-due:r4:2026-10");
  });
});
