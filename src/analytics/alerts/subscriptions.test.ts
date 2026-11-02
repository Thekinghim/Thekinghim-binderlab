import { describe, expect, it } from "vitest";
import { evidence } from "@/analytics/todos/common";
import {
  isQuiet,
  mergeDeliveries,
  quietEndsAt,
  routeNotifications,
  type AlertNotification,
  type AlertSubscription,
} from "./index";

function note(
  p: Partial<AlertNotification> & Pick<AlertNotification, "key" | "kind" | "severity">,
): AlertNotification {
  return {
    incidentId: `${p.key}@x`,
    reason: "new",
    machineId: null,
    titleId: null,
    title: `Larm ${p.key}`,
    detail: "",
    at: "2026-11-02T22:30:00Z",
    evidence: evidence({ rule: "test" }),
    link: "/",
    ...p,
  };
}

const offline = note({
  key: "machine:m1",
  kind: "machine_offline",
  severity: "critical",
  machineId: "m1",
});
const suspected = note({
  key: "machine:m2",
  kind: "machine_suspected_fault",
  severity: "warning",
  machineId: "m2",
});
const lowStock = note({
  key: "low_stock:m2:t1",
  kind: "low_stock",
  severity: "warning",
  machineId: "m2",
  titleId: "t1",
});
const importFail = note({ key: "import:s1", kind: "import_failed", severity: "critical" });
const highDay = note({ key: "day_anomaly:all:2026-11-01", kind: "day_anomaly", severity: "info" });

const owner: AlertSubscription = { userId: "owner", kinds: "all", machineIds: "all" };

describe("tysta timmar", () => {
  it("över midnatt och inom dagen", () => {
    const q = { start: "22:00", end: "07:00" };
    expect(isQuiet(22 * 60, q)).toBe(true);
    expect(isQuiet(6 * 60 + 59, q)).toBe(true);
    expect(isQuiet(7 * 60, q)).toBe(false);
    expect(isQuiet(12 * 60, { start: "12:00", end: "13:00" })).toBe(true);
    expect(isQuiet(12 * 60, { start: "12:00", end: "12:00" })).toBe(false);
    expect(() => isQuiet(0, { start: "25:00", end: "07:00" })).toThrow();
  });

  it("slutet av tysta timmar i svensk tid, även natten då sommartiden slutar", () => {
    const q = { start: "22:00", end: "07:00" };
    // 23:30 svensk tid 2 nov. (UTC+1) → 07:00 3 nov. = 06:00Z
    expect(
      new Date(
        quietEndsAt(Date.parse("2026-11-02T22:30:00Z"), q, "Europe/Stockholm"),
      ).toISOString(),
    ).toBe("2026-11-03T06:00:00.000Z");
    // 23:00 sommartid 24 okt. → 07:00 vintertid 25 okt. = 06:00Z (natten har 25 timmar)
    expect(
      new Date(
        quietEndsAt(Date.parse("2026-10-24T21:00:00Z"), q, "Europe/Stockholm"),
      ).toISOString(),
    ).toBe("2026-10-25T06:00:00.000Z");
    // Inte tyst: oförändrat
    expect(quietEndsAt(Date.parse("2026-11-02T12:00:00Z"), q, "Europe/Stockholm")).toBe(
      Date.parse("2026-11-02T12:00:00Z"),
    );
  });
});

describe("routeNotifications", () => {
  const NIGHT = "2026-11-02T22:30:00Z"; // 23:30 svensk tid

  it("samlar allt till en användare i ett utskick, allvarligast först", () => {
    const res = routeNotifications([suspected, offline, lowStock], [owner], "2026-11-02T12:00:00Z");
    expect(res).toHaveLength(1);
    expect(res[0]?.items.map((n) => n.key)).toEqual([
      "machine:m1",
      "low_stock:m2:t1",
      "machine:m2",
    ]);
    expect(res[0]?.subject).toBe("3 larm: Larm machine:m1 med flera");
    expect(res[0]?.deferred).toBe(false);
  });

  it("filtrerar på typ, automat och allvar", () => {
    const refiller: AlertSubscription = {
      userId: "r",
      kinds: ["low_stock", "machine_offline", "import_failed"],
      machineIds: ["m2"],
    };
    const res = routeNotifications(
      [offline, suspected, lowStock, importFail, highDay],
      [refiller],
      NIGHT,
    );
    expect(res.flatMap((d) => d.items.map((n) => n.key))).toEqual(["import:s1", "low_stock:m2:t1"]);
    const infoToo = routeNotifications([highDay], [{ ...owner, minSeverity: "info" }], NIGHT);
    expect(infoToo).toHaveLength(1);
    expect(routeNotifications([highDay], [owner], NIGHT)).toEqual([]);
  });

  it("tysta timmar skjuter upp varningar; kritiska går direkt om inte avstängt", () => {
    const sleepy: AlertSubscription = { ...owner, quietHours: { start: "22:00", end: "07:00" } };
    const res = routeNotifications([offline, suspected], [sleepy], NIGHT);
    expect(res.map((d) => [d.sendAt, d.deferred, d.items.map((n) => n.key)])).toEqual([
      ["2026-11-02T22:30:00.000Z", false, ["machine:m1"]],
      ["2026-11-03T06:00:00.000Z", true, ["machine:m2"]],
    ]);
    const strict = routeNotifications(
      [offline],
      [{ ...sleepy, criticalDuringQuietHours: false }],
      NIGHT,
    );
    expect(strict[0]?.deferred).toBe(true);
  });

  it("'resolved' och påminnelser enligt prenumerationen; inaktiv får inget", () => {
    const resolved = { ...offline, reason: "resolved" as const };
    const reminder = { ...offline, reason: "reminder" as const, incidentId: "y" };
    expect(routeNotifications([resolved], [owner], NIGHT)).toEqual([]);
    expect(
      routeNotifications([resolved], [{ ...owner, notifyResolved: true }], NIGHT),
    ).toHaveLength(1);
    expect(routeNotifications([reminder], [{ ...owner, reminders: false }], NIGHT)).toEqual([]);
    expect(routeNotifications([offline], [{ ...owner, active: false }], NIGHT)).toEqual([]);
  });

  it("flera prenumerationer för samma användare ger varje avisering en gång", () => {
    const res = routeNotifications(
      [offline],
      [owner, { userId: "owner", kinds: ["machine_offline"], machineIds: ["m1"] }],
      NIGHT,
    );
    expect(res).toHaveLength(1);
    expect(res[0]?.items).toHaveLength(1);
  });
});

describe("mergeDeliveries", () => {
  it("senaste aviseringen per incident gäller i ett väntande utskick", () => {
    const sleepy: AlertSubscription = {
      ...owner,
      quietHours: { start: "22:00", end: "07:00" },
      notifyResolved: true,
    };
    const pending = routeNotifications([suspected], [sleepy], "2026-11-02T22:30:00Z");
    const later = routeNotifications(
      [{ ...suspected, reason: "resolved", title: "Löst: Larm machine:m2" }, lowStock],
      [sleepy],
      "2026-11-03T01:00:00Z",
    );
    const merged = mergeDeliveries(pending, later);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.items.map((n) => [n.key, n.reason])).toEqual([
      ["low_stock:m2:t1", "new"],
      ["machine:m2", "resolved"],
    ]);
  });
});
