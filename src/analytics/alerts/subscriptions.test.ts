import { describe, expect, it } from "vitest";
import { evidence } from "@/analytics/todos/common";
import {
  inDeliveryWindow,
  isQuiet,
  nextDeliveryAt,
  mergeDeliveries,
  quietEndsAt,
  routeNotifications,
  WAKE_KINDS,
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

  it("slut i automat kl. 02 väntar till de tysta timmarna är slut; bara 'står still' väcker", () => {
    const sleepy: AlertSubscription = { ...owner, quietHours: { start: "22:00", end: "07:00" } };
    const at02 = Date.parse("2026-11-03T01:00:00Z"); // 02:00 svensk tid
    const empty = { ...lowStock, severity: "critical" as const };
    const fault = note({ key: "machine:m3", kind: "machine_fault", severity: "critical" });
    const res = routeNotifications([empty, importFail, offline, fault], [sleepy], at02);
    expect(res.map((d) => [d.sendAt, d.deferred, d.items.map((n) => n.key)])).toEqual([
      ["2026-11-03T01:00:00.000Z", false, ["machine:m1", "machine:m3"]],
      // 07:00 svensk tid
      ["2026-11-03T06:00:00.000Z", true, ["import:s1", "low_stock:m2:t1"]],
    ]);
    // På dagen kommer det direkt.
    const noon = Date.parse("2026-11-03T11:00:00Z");
    expect(routeNotifications([empty], [sleepy], noon)[0]).toMatchObject({
      sendAt: "2026-11-03T11:00:00.000Z",
      deferred: false,
    });
    expect(WAKE_KINDS).toEqual(["machine_offline", "machine_fault"]);
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

describe("mergeDeliveries: påminnelser", () => {
  it("en påminnelse ersätter aldrig en avisering som väntar: nytt förblir nytt", () => {
    const sleepy: AlertSubscription = { ...owner, quietHours: { start: "22:00", end: "07:00" } };
    const pending = routeNotifications([lowStock], [sleepy], "2026-11-02T22:30:00Z");
    const later = routeNotifications(
      [{ ...lowStock, reason: "reminder" }],
      [sleepy],
      "2026-11-03T03:00:00Z",
    );
    const merged = mergeDeliveries(pending, later);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.items.map((n) => n.reason)).toEqual(["new"]);
  });
});

describe("tider för aviseringar", () => {
  const weekdays = [{ days: [1, 2, 3, 4, 5], start: "07:00", end: "18:00" }];
  const tz = "Europe/Stockholm";
  const ms = (iso: string) => Date.parse(iso);

  it("inom och utanför tiderna; tid över midnatt hör till startdagen", () => {
    // Mån 2 nov. 10:00 svensk tid = 09:00Z.
    expect(inDeliveryWindow(ms("2026-11-02T09:00:00Z"), weekdays, tz)).toBe(true);
    expect(inDeliveryWindow(ms("2026-11-02T17:00:00Z"), weekdays, tz)).toBe(false); // 18:00
    expect(inDeliveryWindow(ms("2026-11-07T09:00:00Z"), weekdays, tz)).toBe(false); // lördag
    const friNight = [{ days: [5], start: "18:00", end: "02:00" }];
    expect(inDeliveryWindow(ms("2026-11-07T00:00:00Z"), friNight, tz)).toBe(true); // lör 01:00
    expect(inDeliveryWindow(ms("2026-11-08T00:00:00Z"), friNight, tz)).toBe(false); // sön 01:00
    expect(
      inDeliveryWindow(
        ms("2026-11-08T00:00:00Z"),
        [{ days: [7], start: "00:00", end: "00:00" }],
        tz,
      ),
    ).toBe(true);
  });

  it("nästa tid: lördag → måndag 07:00, kväll → nästa morgon", () => {
    expect(new Date(nextDeliveryAt(ms("2026-11-07T09:00:00Z"), weekdays, tz)).toISOString()).toBe(
      "2026-11-09T06:00:00.000Z",
    );
    expect(new Date(nextDeliveryAt(ms("2026-11-02T19:00:00Z"), weekdays, tz)).toISOString()).toBe(
      "2026-11-03T06:00:00.000Z",
    );
    // Över sommartidens slut: lör 24 okt. 12:00 (+02) → mån 26 okt. 07:00 (+01) = 06:00Z.
    expect(new Date(nextDeliveryAt(ms("2026-10-24T10:00:00Z"), weekdays, tz)).toISOString()).toBe(
      "2026-10-26T06:00:00.000Z",
    );
    expect(() => nextDeliveryAt(0, [], tz)).toThrow();
    expect(() => inDeliveryWindow(0, [{ days: [0], start: "07:00", end: "18:00" }], tz)).toThrow();
  });

  it("routeNotifications: varning skjuts till nästa tid, kritiskt går direkt; tysta timmar gäller också", () => {
    const sub: AlertSubscription = {
      userId: "u1",
      kinds: "all",
      machineIds: "all",
      deliveryWindows: weekdays,
    };
    // Lör 7 nov. 10:00 svensk tid.
    const sat = "2026-11-07T09:00:00Z";
    const d = routeNotifications([offline, lowStock], [sub], sat);
    expect(d.map((x) => [x.sendAt, x.deferred, x.items.map((i) => i.key)])).toEqual([
      ["2026-11-07T09:00:00.000Z", false, ["machine:m1"]],
      ["2026-11-09T06:00:00.000Z", true, ["low_stock:m2:t1"]],
    ]);
    // "Slut i automat" (kritiskt) på lördagen väntar inte till måndag: bara natten väntas ut.
    const empty = { ...lowStock, severity: "critical" as const };
    expect(routeNotifications([empty], [sub], sat).map((x) => [x.sendAt, x.deferred])).toEqual([
      ["2026-11-07T09:00:00.000Z", false],
    ]);
    const sleepy = { ...sub, quietHours: { start: "22:00", end: "07:00" } };
    // Lör 02:00 svensk tid → lör 07:00, inte mån 07:00.
    expect(
      routeNotifications([empty], [sleepy], "2026-11-07T01:00:00Z").map((x) => x.sendAt),
    ).toEqual(["2026-11-07T06:00:00.000Z"]);
    // Med "Kritiska larm alltid direkt" avstängt följer det tiderna som allt annat.
    expect(
      routeNotifications([empty], [{ ...sub, criticalDuringQuietHours: false }], sat).map(
        (x) => x.sendAt,
      ),
    ).toEqual(["2026-11-09T06:00:00.000Z"]);
    // Tider 06–22 alla dagar och tysta timmar 05–08: mån 05:30 → 08:00 (07:00Z).
    const both: AlertSubscription = {
      ...sub,
      deliveryWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: "06:00", end: "22:00" }],
      quietHours: { start: "05:00", end: "08:00" },
    };
    const early = routeNotifications([lowStock], [both], "2026-11-02T04:30:00Z");
    expect(early.map((x) => x.sendAt)).toEqual(["2026-11-02T07:00:00.000Z"]);
    const noBypass = routeNotifications(
      [offline],
      [{ ...sub, criticalDuringQuietHours: false }],
      sat,
    );
    expect(noBypass.map((x) => x.sendAt)).toEqual(["2026-11-09T06:00:00.000Z"]);
  });
});
