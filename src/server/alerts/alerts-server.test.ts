import { describe, expect, it } from "vitest";

import type { AlertDelivery, AlertIncident } from "@/analytics/alerts";
import { alertEmail, absoluteLink, pushPayload, smsText } from "@/server/notify/content";
import { normalizePhone as normalize } from "./subscriptions";

import { cronAuthorized } from "./cron-auth";
import {
  incidentChanged,
  incidentToColumns,
  isRowId,
  parseEvidence,
  rowToIncident,
  type AlertRow,
} from "./store";
import {
  defaultSubscription,
  FIELD_KINDS,
  rowToSubscription,
  validateSubscription,
  type SubscriptionInput,
} from "./subscriptions";

const ROW: AlertRow = {
  id: "3f2c9d0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
  incidentKey: "machine:m2",
  alertGroup: "machine",
  kind: "machine_suspected_fault",
  severity: "warning",
  status: "open",
  machineId: "m2",
  titleId: null,
  title: "Automat 2 har inte sålt på 6 timmar",
  message: "Normalt 6,2 pack under tiden.",
  evidence: { rule: "Tystnad", figures: [{ key: "x", label: "X", value: 1, unit: "count" }] },
  link: "/automater/m2",
  triggeredAt: new Date("2026-10-20T14:30:00Z"),
  lastSeenAt: new Date("2026-10-20T14:40:00Z"),
  closedAt: null,
  lastNotifiedAt: new Date("2026-10-20T14:30:00Z"),
  notifiedSeverity: "warning",
  notifyCount: 1,
  occurrences: 2,
  reopenCount: 0,
  oneShot: false,
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedNotifiedAt: null,
  suppressedBy: null,
};

describe("incidenter ↔ rader i alerts", () => {
  it("rad → incident → kolumner ger samma värden tillbaka", () => {
    const i = rowToIncident(ROW)!;
    expect(i).toMatchObject({
      id: ROW.id,
      key: "machine:m2",
      group: "machine",
      status: "open",
      openedAt: "2026-10-20T14:30:00.000Z",
      lastSeenAt: "2026-10-20T14:40:00.000Z",
      detail: "Normalt 6,2 pack under tiden.",
    });
    expect(i.evidence.orderIds).toEqual([]);
    const cols = incidentToColumns(i);
    expect(cols.incidentKey).toBe("machine:m2");
    expect(cols.message).toBe(ROW.message);
    expect(cols.triggeredAt.toISOString()).toBe(ROW.triggeredAt.toISOString());
    expect(incidentChanged(i, { ...i })).toBe(false);
    expect(incidentChanged(i, { ...i, occurrences: 3 })).toBe(true);
  });

  it("rader utan nyckel eller med okänd typ hoppas över", () => {
    expect(rowToIncident({ ...ROW, incidentKey: null })).toBeNull();
    expect(rowToIncident({ ...ROW, kind: "okänd" })).toBeNull();
  });

  it("länkar som inte är lokala sökvägar ersätts", () => {
    const i = rowToIncident(ROW) as AlertIncident;
    expect(incidentToColumns({ ...i, link: "https://evil.example" }).link).toBe("/drift");
    expect(incidentToColumns({ ...i, link: "//evil.example" }).link).toBe("/drift");
  });

  it("radens id känns igen, analytics-id:t inte", () => {
    expect(isRowId(ROW.id)).toBe(true);
    expect(isRowId("machine:m2@2026-10-20T14:30:00.000Z")).toBe(false);
    expect(parseEvidence(null).rule).toBe("");
  });
});

const INPUT: SubscriptionInput = {
  kinds: [],
  allKinds: true,
  machineIds: [],
  allMachines: true,
  minSeverity: "warning",
  channels: ["push", "email"],
  phone: "",
  quiet: true,
  quietStart: "22:00",
  quietEnd: "07:00",
  window: false,
  windowDays: [1, 2, 3, 4, 5],
  windowStart: "07:00",
  windowEnd: "18:00",
  criticalDuringQuiet: true,
  notifyResolved: false,
  reminders: true,
  active: true,
};

describe("prenumerationer", () => {
  it("påfyllaren får bara larm om automater och lager, även när alla valts", () => {
    const r = validateSubscription(INPUT, { userId: "u", role: "refiller", machineIds: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.kinds).toEqual([...FIELD_KINDS]);
    const own = validateSubscription(
      { ...INPUT, allKinds: false, kinds: ["import_failed"] },
      { userId: "u", role: "refiller", machineIds: [] },
    );
    expect(own.ok).toBe(false);
  });

  it("sms kräver ett giltigt nummer och nummer skrivs om till E.164", () => {
    const missing = validateSubscription(
      { ...INPUT, channels: ["sms"] },
      { userId: "u", role: "owner", machineIds: [] },
    );
    expect(missing.ok).toBe(false);
    const ok = validateSubscription(
      { ...INPUT, channels: ["sms"], phone: "070-123 45 67" },
      { userId: "u", role: "owner", machineIds: [] },
    );
    expect(ok.ok && ok.row.phone).toBe("+46701234567");
    expect(normalize("0046 70 123 45 67")).toBe("+46701234567");
  });

  it("okända automater, tomma kanaler och ogiltiga tider avvisas", () => {
    const ctx = { userId: "u", role: "owner", machineIds: ["m1"] };
    expect(validateSubscription({ ...INPUT, allMachines: false, machineIds: ["m9"] }, ctx).ok).toBe(
      false,
    );
    expect(validateSubscription({ ...INPUT, channels: [] }, ctx).ok).toBe(false);
    expect(validateSubscription({ ...INPUT, quietStart: "25:00" }, ctx).ok).toBe(false);
    expect(validateSubscription({ ...INPUT, window: true, windowDays: [] }, ctx).ok).toBe(false);
  });

  it("raden blir en prenumeration för @/analytics/alerts", () => {
    const sub = rowToSubscription({
      ...defaultSubscription("u", "owner"),
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    expect(sub).toMatchObject({
      userId: "u",
      kinds: "all",
      machineIds: "all",
      quietHours: { start: "22:00", end: "07:00" },
    });
    expect(rowToSubscription(defaultSubscription("p", "refiller")).kinds).toEqual([...FIELD_KINDS]);
  });
});

describe("CRON_SECRET", () => {
  it("kräver exakt Bearer-hemligheten och minst 16 tecken", () => {
    const secret = "a".repeat(32);
    expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(cronAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(cronAuthorized(secret, secret)).toBe(false);
    expect(cronAuthorized(null, secret)).toBe(false);
    expect(cronAuthorized("Bearer kort", "kort")).toBe(false);
    expect(cronAuthorized("Bearer ", undefined)).toBe(false);
  });
});

const DELIVERY: AlertDelivery = {
  userId: "u",
  sendAt: "2026-10-20T14:30:00.000Z",
  deferred: false,
  subject: "Automat 2 är ur drift",
  items: [
    {
      incidentId: "a",
      key: "machine:m2",
      kind: "machine_offline",
      severity: "critical",
      reason: "new",
      machineId: "m2",
      titleId: null,
      title: "Automat 2 är ur drift",
      detail: "Ingen försäljning sedan mån 19 okt. 10:15. <script>",
      at: "2026-10-20T14:30:00.000Z",
      evidence: {
        rule: "Larm när tystnaden är osannolik.",
        period: null,
        orderIds: [],
        dates: [],
        titleIds: [],
        machineIds: [],
        storeIds: [],
        recipientIds: [],
        figures: [],
      },
      link: "/drift/automat/m2",
    },
  ],
};

describe("innehållet i ett larm", () => {
  it("push: titel, text, länk till underlaget och samma tagg som incidenten", () => {
    const p = pushPayload(DELIVERY);
    expect(p).toMatchObject({
      title: "Automat 2 är ur drift",
      url: "/drift/automat/m2",
      tag: "machine:m2",
      severity: "critical",
    });
  });

  it("e-post: ljus, utan klasser, bilder eller svg, med escapad text och länk", () => {
    const m = alertEmail(DELIVERY, {
      baseUrl: "https://app.binderlab.se/",
      timeZone: "Europe/Stockholm",
      organizationName: "Test",
    });
    expect(m.subject).toBe("Larm: Automat 2 är ur drift");
    expect(m.html).not.toMatch(/class=|<svg|<img|<link/);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("https://app.binderlab.se/drift/automat/m2");
    expect(m.html).toContain("Kräver åtgärd");
    expect(m.html.length).toBeLessThan(100_000);
    expect(m.text).toContain("! Kritisk · Nytt");
    expect(m.text).toContain("Underlag: Larm när tystnaden är osannolik.");
  });

  it("sms: högst tre delar och absolut länk", () => {
    const t = smsText(
      { ...DELIVERY, items: [{ ...DELIVERY.items[0]!, detail: "x".repeat(1000) }] },
      "https://a.se",
    );
    expect(t.length).toBeLessThanOrEqual(459);
    expect(smsText(DELIVERY, "https://a.se")).toContain("https://a.se/drift/automat/m2");
    expect(absoluteLink("https://a.se/", "//evil")).toBe("https://a.se/drift");
  });
});
