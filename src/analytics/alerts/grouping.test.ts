import { describe, expect, it } from "vitest";
import { evidence } from "@/analytics/todos/common";
import {
  acknowledgeIncident,
  dayAnomalyDate,
  reconcileAlerts,
  suppressRelated,
  type AlertCandidate,
  type AlertIncident,
  type AlertKind,
  type AlertSeverity,
} from "./index";

function cand(
  key: string,
  kind: AlertKind,
  severity: AlertSeverity,
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

/** Avvikande dag med utfall och förväntat (tiondelar) i underlaget. */
function day(scope: string, date: string, actual: number, expectedTenths: number): AlertCandidate {
  return cand(
    `day_anomaly:${scope}:${date}`,
    "day_anomaly",
    actual * 10 < expectedTenths ? "warning" : "info",
    {
      machineId: scope === "all" ? null : scope,
      oneShot: true,
      evidence: evidence({
        rule: "test",
        figures: [
          { key: "actual", label: "Sålda pack", value: actual, unit: "packs" },
          { key: "expectedTenths", label: "Förväntat", value: expectedTenths, unit: "tenths" },
        ],
      }),
    },
  );
}

const down = (m: string, severity: AlertSeverity = "critical") =>
  cand(
    `machine:${m}`,
    severity === "critical" ? "machine_offline" : "machine_suspected_fault",
    severity,
  );
const importFail = cand("import:ds1", "import_failed", "critical");

const keys = (cs: readonly AlertCandidate[]) => cs.map((c) => c.key);

describe("suppressRelated: samma orsak larmar en gång", () => {
  it("misslyckad import stryker låga dagar både för automater och hela organisationen", () => {
    const { kept, suppressed } = suppressRelated([
      day("m1", "2026-11-02", 8, 200),
      day("all", "2026-11-02", 30, 600),
      importFail,
    ]);
    expect(keys(kept)).toEqual(["import:ds1"]);
    expect(suppressed.map((s) => s.by)).toEqual(["import:ds1", "import:ds1"]);
  });

  it("hög dag stryks inte av import eller driftlarm", () => {
    const { kept } = suppressRelated([day("m1", "2026-11-02", 40, 200), importFail, down("m1")]);
    expect(keys(kept)).toEqual(["day_anomaly:m1:2026-11-02", "import:ds1", "machine:m1"]);
  });

  it("hela organisationen stryks när automaternas låga dagar står för minst halva avvikelsen", () => {
    // Totalen −30 pack (30 av 60); m1 −12 och m2 −6 = −18 ≥ 15 ⇒ totalen stryks, m1 förklarar mest.
    const r = suppressRelated([
      day("all", "2026-11-02", 30, 600),
      day("m1", "2026-11-02", 8, 200),
      day("m2", "2026-11-02", 4, 100),
    ]);
    expect(keys(r.kept)).toEqual(["day_anomaly:m1:2026-11-02", "day_anomaly:m2:2026-11-02"]);
    expect(r.suppressed).toEqual([
      { candidate: day("all", "2026-11-02", 30, 600), by: "day_anomaly:m1:2026-11-02" },
    ]);
  });

  it("hela organisationen behålls när automaternas avvikelse är mindre än halva totalen", () => {
    // Totalen −30 pack; m1 −12 < 15 ⇒ båda larmar (bredare orsak än en automat).
    const r = suppressRelated([day("all", "2026-11-02", 30, 600), day("m1", "2026-11-02", 8, 200)]);
    expect(r.kept).toHaveLength(2);
  });

  it("andra dagar och motsatt håll räknas inte; hög dag grupperas likadant", () => {
    const other = suppressRelated([
      day("all", "2026-11-02", 8, 200),
      day("m1", "2026-11-01", 8, 200),
    ]);
    expect(other.kept).toHaveLength(2);
    const high = suppressRelated([
      day("all", "2026-11-02", 33, 200),
      day("m1", "2026-11-02", 33, 200),
    ]);
    expect(keys(high.kept)).toEqual(["day_anomaly:m1:2026-11-02"]);
  });

  it("dayAnomalyDate läser datumet ur nyckeln", () => {
    expect(dayAnomalyDate(day("all", "2026-11-02", 8, 200))).toBe("2026-11-02");
    expect(dayAnomalyDate(importFail)).toBeNull();
  });
});

const T0 = Date.parse("2026-11-02T08:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

function series(steps: [number, AlertCandidate[]][], start: AlertIncident[] = []) {
  let incidents = start;
  const sent: [number, string, string, AlertSeverity][] = [];
  for (const [m, c] of steps) {
    const r = reconcileAlerts(c, incidents, at(m));
    incidents = r.incidents;
    for (const n of r.notifications) sent.push([m, n.key, n.reason, n.severity]);
  }
  return { incidents, sent };
}

describe("reconcileAlerts: fladder i allvar", () => {
  it("misstänkt fel ↔ offline var 10:e minut: ny och en skärpning, sedan inget", () => {
    const steps: [number, AlertCandidate[]][] = [];
    for (let m = 0; m <= 180; m += 10)
      steps.push([m, [down("m1", m % 20 === 0 ? "warning" : "critical")]]);
    const { sent, incidents } = series(steps);
    expect(sent).toEqual([
      [0, "machine:m1", "new", "warning"],
      [10, "machine:m1", "escalated", "critical"],
    ]);
    // Incidenten visar nuvarande allvar men minns det aviserade.
    expect(incidents[0]?.severity).toBe("warning"); // 180 min: misstänkt fel
    expect(incidents[0]?.notifiedSeverity).toBe("critical");
  });

  it("fladder i allvar påminner ändå efter 4 h räknat från senaste aviseringen", () => {
    const steps: [number, AlertCandidate[]][] = [];
    for (let m = 0; m <= 260; m += 10)
      steps.push([m, [down("m1", m % 20 === 0 ? "warning" : "critical")]]);
    const { sent } = series(steps);
    // 10 min skärpning; 250 min = 4 h efter 10 min, critical ⇒ påminnelse.
    expect(sent.map(([m, , r]) => [m, r])).toEqual([
      [0, "new"],
      [10, "escalated"],
      [250, "reminder"],
    ]);
  });

  it("kvitterad incident som fladdrar efter påminnelsetiden aviseras inte vid återöppning", () => {
    const first = series([[0, [down("m1")]]]);
    const acked = first.incidents.map((i) => acknowledgeIncident(i, "u1", at(1)));
    // Öppen till 300 min (5 h > 4 h), stängs 330, tillbaka 360 (inom 2 h).
    const steps: [number, AlertCandidate[]][] = [];
    for (let m = 10; m <= 300; m += 10) steps.push([m, [down("m1")]]);
    steps.push([330, []], [360, [down("m1")]]);
    const { sent, incidents } = series(steps, acked);
    expect(sent.map(([m, , r]) => [m, r])).toEqual([[330, "resolved"]]);
    expect(incidents.find((i) => i.status === "open")?.reopenCount).toBe(1);
  });
});

describe("reconcileAlerts: låg dag som förklaras av tidigare incidenter", () => {
  // Mån 2 nov. bedöms tis 3 nov. 07:00 (06:00Z); automaten var offline mån 02:00–05:00 lokal tid.
  const offlineIncident = (): AlertIncident[] => {
    let inc = reconcileAlerts([down("m1")], [], "2026-11-02T01:00:00Z").incidents;
    inc = reconcileAlerts([down("m1")], inc, "2026-11-02T03:30:00Z").incidents;
    inc = reconcileAlerts([], inc, "2026-11-02T04:00:00Z").incidents;
    return inc;
  };

  it("driftincident under dagen stryker automatens låga dag, även om den redan stängts", () => {
    const prev = offlineIncident();
    expect(prev[0]?.status).toBe("closed");
    const r = reconcileAlerts([day("m1", "2026-11-02", 8, 200)], prev, "2026-11-03T06:00:00Z");
    expect(r.notifications).toEqual([]);
    const stored = r.incidents.find((i) => i.key === "day_anomaly:m1:2026-11-02");
    expect(stored).toMatchObject({ status: "closed", suppressedBy: "machine:m1", notifyCount: 0 });
    // Nästa körning: engångslarmet finns redan ⇒ fortfarande inget.
    const again = reconcileAlerts(
      [day("m1", "2026-11-02", 8, 200)],
      r.incidents,
      "2026-11-03T07:00:00Z",
    );
    expect(again.notifications).toEqual([]);
  });

  it("driftincident en annan dag eller för en annan automat stryker inte; totalen stryks av vilken automat som helst", () => {
    const prev = offlineIncident();
    const otherDay = reconcileAlerts(
      [day("m1", "2026-11-03", 8, 200)],
      prev,
      "2026-11-04T06:00:00Z",
    );
    expect(otherDay.notifications.map((n) => n.key)).toEqual(["day_anomaly:m1:2026-11-03"]);
    const otherMachine = reconcileAlerts(
      [day("m2", "2026-11-02", 8, 200), day("all", "2026-11-02", 60, 1_000)],
      prev,
      "2026-11-03T06:00:00Z",
    );
    expect(otherMachine.notifications.map((n) => n.key)).toEqual(["day_anomaly:m2:2026-11-02"]);
  });

  it("hög dag stryks inte av historiken", () => {
    const r = reconcileAlerts(
      [day("m1", "2026-11-02", 40, 200)],
      offlineIncident(),
      "2026-11-03T06:00:00Z",
    );
    expect(r.notifications.map((n) => n.reason)).toEqual(["new"]);
  });

  it("strukna engångslarm i samma körning sparas och larmar inte senare (revisionens fall)", () => {
    const low = day("m1", "2026-11-02", 8, 200);
    const r1 = reconcileAlerts([down("m1"), low], [], "2026-11-03T05:00:00Z");
    expect(r1.notifications.map((n) => n.key)).toEqual(["machine:m1"]);
    const r2 = reconcileAlerts([], r1.incidents, "2026-11-03T05:40:00Z");
    const r3 = reconcileAlerts([low], r2.incidents, "2026-11-03T05:50:00Z");
    expect(r3.notifications).toEqual([]);
  });
});
