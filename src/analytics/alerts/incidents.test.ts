import { describe, expect, it } from "vitest";
import { evidence } from "@/analytics/todos/common";
import {
  acknowledgeIncident,
  reconcileAlerts,
  type AlertCandidate,
  type AlertIncident,
  type AlertKind,
  type AlertSeverity,
} from "./index";

function cand(
  key: string,
  kind: AlertKind = "machine_suspected_fault",
  severity: AlertSeverity = "warning",
  p: Partial<AlertCandidate> = {},
): AlertCandidate {
  return {
    key,
    kind,
    severity,
    machineId: key.startsWith("machine:") ? key.slice(8) : null,
    titleId: null,
    title: `Larm ${key}`,
    detail: "",
    evidence: evidence({ rule: "test" }),
    link: "/",
    ...p,
  };
}

const T0 = Date.parse("2026-11-02T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** Kör en serie utvärderingar och samlar alla aviseringar. */
function run(steps: { minutes: number; candidates: AlertCandidate[] }[]) {
  let incidents: AlertIncident[] = [];
  const sent: { minutes: number; reason: string; key: string; severity: string }[] = [];
  for (const s of steps) {
    const r = reconcileAlerts(s.candidates, incidents, at(s.minutes));
    incidents = r.incidents;
    for (const n of r.notifications)
      sent.push({ minutes: s.minutes, reason: n.reason, key: n.key, severity: n.severity });
  }
  return { incidents, sent };
}

/** Samma kandidat var 10:e minut i `minutes` minuter. */
function every10(minutes: number, c: AlertCandidate[], from = 0) {
  const out: { minutes: number; candidates: AlertCandidate[] }[] = [];
  for (let m = from; m < from + minutes; m += 10) out.push({ minutes: m, candidates: c });
  return out;
}

describe("reconcileAlerts: deduplicering", () => {
  it("samma problem var 10:e minut i 3 timmar larmar en gång", () => {
    const { incidents, sent } = run(every10(180, [cand("machine:m1")]));
    expect(sent).toEqual([{ minutes: 0, reason: "new", key: "machine:m1", severity: "warning" }]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.occurrences).toBe(18);
    expect(incidents[0]?.status).toBe("open");
    expect(incidents[0]?.notifyCount).toBe(1);
  });

  it("dubbletter i samma körning blir en incident", () => {
    const r = reconcileAlerts(
      [cand("machine:m1"), cand("machine:m1", "machine_offline", "critical")],
      [],
      at(0),
    );
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]?.kind).toBe("machine_offline");
    expect(r.notifications).toHaveLength(1);
  });

  it("påminner efter återlarmstiden (critical 4 h)", () => {
    const { sent } = run(every10(9 * 60, [cand("machine:m1", "machine_offline", "critical")]));
    expect(sent.map((s) => [s.minutes, s.reason])).toEqual([
      [0, "new"],
      [240, "reminder"],
      [480, "reminder"],
    ]);
  });

  it("kvitterad incident påminner inte", () => {
    const first = reconcileAlerts([cand("machine:m1", "machine_offline", "critical")], [], at(0));
    const acked = first.incidents.map((i) => acknowledgeIncident(i, "u1", at(5)));
    const later = reconcileAlerts(
      [cand("machine:m1", "machine_offline", "critical")],
      acked,
      at(300),
    );
    expect(later.notifications).toEqual([]);
    expect(later.incidents[0]?.acknowledgedBy).toBe("u1");
  });

  it("skärpning aviseras direkt (misstänkt fel → offline), även kvitterad", () => {
    const first = reconcileAlerts([cand("machine:m1")], [], at(0));
    const acked = first.incidents.map((i) => acknowledgeIncident(i, "u1", at(5)));
    const r = reconcileAlerts([cand("machine:m1", "machine_offline", "critical")], acked, at(20));
    expect(r.notifications.map((n) => [n.reason, n.kind])).toEqual([
      ["escalated", "machine_offline"],
    ]);
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]?.id).toBe(first.incidents[0]?.id);
  });

  it("nedgradering aviseras inte", () => {
    const { sent } = run([
      { minutes: 0, candidates: [cand("machine:m1", "machine_offline", "critical")] },
      { minutes: 10, candidates: [cand("machine:m1")] },
    ]);
    expect(sent.map((s) => s.reason)).toEqual(["new"]);
  });
});

describe("reconcileAlerts: stängning och fladder", () => {
  it("stänger efter 30 minuter utan kandidat och aviserar 'resolved'", () => {
    const { incidents, sent } = run([
      ...every10(30, [cand("machine:m1")]),
      { minutes: 30, candidates: [] },
      { minutes: 40, candidates: [] },
      { minutes: 50, candidates: [] },
    ]);
    expect(sent.map((s) => [s.minutes, s.reason])).toEqual([
      [0, "new"],
      [50, "resolved"],
    ]);
    expect(incidents[0]?.status).toBe("closed");
    expect(incidents[0]?.closedAt).toBe(at(50));
  });

  it("fladder: tillbaka inom 2 h öppnar samma incident utan ny avisering", () => {
    const { incidents, sent } = run([
      { minutes: 0, candidates: [cand("machine:m1")] },
      { minutes: 40, candidates: [] }, // stängs (sedd för 40 min sedan)
      { minutes: 60, candidates: [cand("machine:m1")] }, // tillbaka
      { minutes: 120, candidates: [] },
      { minutes: 150, candidates: [cand("machine:m1")] },
    ]);
    expect(sent.map((s) => s.reason)).toEqual(["new", "resolved"]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.reopenCount).toBe(2);
    expect(incidents[0]?.status).toBe("open");
  });

  it("tillbaka efter mer än 2 h blir ny incident med ny avisering", () => {
    const { incidents, sent } = run([
      { minutes: 0, candidates: [cand("machine:m1")] },
      { minutes: 40, candidates: [] },
      { minutes: 200, candidates: [cand("machine:m1")] },
    ]);
    expect(sent.map((s) => s.reason)).toEqual(["new", "resolved", "new"]);
    expect(incidents.map((i) => i.status)).toEqual(["open", "closed"]);
  });

  it("öppnad igen med högre allvar aviseras som 'reopened'", () => {
    const { sent } = run([
      { minutes: 0, candidates: [cand("machine:m1")] },
      { minutes: 40, candidates: [] },
      { minutes: 60, candidates: [cand("machine:m1", "machine_offline", "critical")] },
    ]);
    expect(sent.map((s) => s.reason)).toEqual(["new", "resolved", "reopened"]);
  });

  it("familjer som inte utvärderades lämnas orörda", () => {
    const first = reconcileAlerts([cand("import:s1", "import_failed", "critical")], [], at(0));
    const r = reconcileAlerts([], first.incidents, at(60), { evaluatedGroups: ["machine"] });
    expect(r.incidents[0]?.status).toBe("open");
    expect(r.notifications).toEqual([]);
    expect(() =>
      reconcileAlerts([cand("import:s1", "import_failed", "critical")], [], at(0), {
        evaluatedGroups: ["machine"],
      }),
    ).toThrow();
  });

  it("engångslarm larmar en gång per nyckel och stängs direkt", () => {
    const c = cand("day_anomaly:all:2026-11-01", "day_anomaly", "warning", { oneShot: true });
    const { incidents, sent } = run([
      { minutes: 0, candidates: [c] },
      { minutes: 60, candidates: [c] },
      { minutes: 600, candidates: [c] },
    ]);
    expect(sent.map((s) => s.reason)).toEqual(["new"]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.status).toBe("closed");
  });

  it("flera öppna incidenter med samma nyckel: äldre stängs", () => {
    const first = reconcileAlerts([cand("machine:m1")], [], at(0)).incidents[0] as AlertIncident;
    const dup: AlertIncident = { ...first, id: "machine:m1@äldre", openedAt: at(-60) };
    const r = reconcileAlerts([cand("machine:m1")], [dup, first], at(10));
    expect(r.incidents.filter((i) => i.status === "open").map((i) => i.id)).toEqual([first.id]);
    expect(r.notifications).toEqual([]);
  });
});

describe("reconcileAlerts: gruppering", () => {
  it("låg dag för en automat med driftlarm larmar inte separat", () => {
    const r = reconcileAlerts(
      [
        cand("machine:m1", "machine_offline", "critical"),
        cand("day_anomaly:m1:2026-11-01", "day_anomaly", "warning", {
          machineId: "m1",
          oneShot: true,
        }),
        cand("day_anomaly:all:2026-11-01", "day_anomaly", "warning", { oneShot: true }),
        cand("day_anomaly:m2:2026-11-01", "day_anomaly", "info", {
          machineId: "m2",
          oneShot: true,
        }),
      ],
      [],
      at(0),
    );
    expect(r.notifications.map((n) => n.key)).toEqual(["machine:m1", "day_anomaly:m2:2026-11-01"]);
  });
});
