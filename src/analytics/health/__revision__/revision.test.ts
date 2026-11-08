/**
 * Oberoende revision av fas 8 (drift): maskinhälsa, larm och besöksplan.
 *
 * Alla förväntade värden är uträknade för hand (Poisson med e^−λ och summor av λ^i/i!,
 * haversine för avstånd) och står i kommentarerna, inte framräknade med koden som testas.
 * Tidpunkter skrivs med uttrycklig offset (+02:00 sommartid t.o.m. 25 okt. 2026, därefter
 * +01:00), så att testerna inte beror på hjälpfunktionerna i health/test-helpers.
 */

import { describe, expect, it } from "vitest";
import { addDays, dayOfWeek, type IsoDate } from "@/domain";
import { evidence } from "@/analytics/todos/common";
import type { AnalyticsOrder, MachineRef } from "@/analytics/todos/types";
import { machineHealth, machineTimeline, type HealthInput, type MachineSignal } from "../index";
import {
  acknowledgeIncident,
  dayAnomalyAlerts,
  healthAlerts,
  importAlerts,
  lowStockAlerts,
  reconcileAlerts,
  routeNotifications,
  suppressRelated,
  type AlertCandidate,
  type AlertIncident,
  type AlertKind,
  type AlertSeverity,
  type AlertSubscription,
} from "@/analytics/alerts";
import { planVisits, type VisitMachine } from "@/analytics/visits";

// ---------------------------------------------------------------------------
// Byggare (oberoende av områdets egna testhjälpare)
// ---------------------------------------------------------------------------

/** Svensk offset: sommartid slutar 25 okt. 2026 kl. 03:00. */
function offset(date: IsoDate): string {
  return date < "2026-10-25" ? "+02:00" : "+01:00";
}

/** Lokal Stockholmstid → ISO med offset. Undviker natten 25 okt. (används inte). */
function sthlm(date: IsoDate, time: string): string {
  return `${date}T${time}:00${offset(date)}`;
}

let seq = 0;
function order(
  machineId: string,
  date: IsoDate,
  time: string | null,
  titleId = "t1",
): AnalyticsOrder {
  seq++;
  const id = `r${String(seq).padStart(6, "0")}`;
  return {
    id,
    externalId: id,
    titleId,
    machineId,
    businessDate: date,
    amountOre: 4_900,
    ...(time === null ? {} : { orderedAt: sthlm(date, time) }),
  };
}

/** 1 pack i timmen kl. 10:30, 11:30 … 17:30 (8 per dag), från `from` t.o.m. `lastIso`. */
const HOURLY = ["10:30", "11:30", "12:30", "13:30", "14:30", "15:30", "16:30", "17:30"];
function hourlyUntil(
  machineId: string,
  from: IsoDate,
  lastDate: IsoDate,
  lastTime: string,
  skipWeekdays: readonly number[] = [],
): AnalyticsOrder[] {
  const out: AnalyticsOrder[] = [];
  for (let d = from; d <= lastDate; d = addDays(d, 1)) {
    if (skipWeekdays.includes(dayOfWeek(d))) continue;
    for (const t of HOURLY) {
      if (d === lastDate && t > lastTime) continue;
      out.push(order(machineId, d, t));
    }
  }
  return out;
}

const M1: MachineRef = { id: "m1", name: "Automat 1", activeFrom: null, activeTo: null };
const nbsp = (s: string | undefined) => (s ?? "").replace(/ /g, " ");

function health(orders: AnalyticsOrder[], now: string, p: Partial<HealthInput> = {}) {
  const [h] = machineHealth({ orders, machines: [M1], ...p }, now);
  if (!h) throw new Error("ingen hälsa");
  return h;
}

function sig(kind: MachineSignal["kind"], at: string, p: Partial<MachineSignal> = {}) {
  return { id: `sig-${kind}-${at}`, machineId: "m1", source: "awish_grpc", kind, at, ...p };
}

// ---------------------------------------------------------------------------
// 1. Misstänkt fel: Poisson mot samma veckodag och timme
// ---------------------------------------------------------------------------

describe("revision 1: misstänkt fel härlett ur tystnad", () => {
  // Automaten säljer 1 pack/timme 10–18 varje dag sedan 1 sep. Sista order ons 4 nov. 11:30.
  // Historik: lokal midnatt 9 sep. (ons) t.o.m. tystnadens början 11:30 = 8 onsdagar.
  // Takt onsdag 11, 12, … 17 = 8/8 = 1 pack/timme; övriga timmar 0.
  const orders = hourlyUntil("m1", "2026-09-01", "2026-11-04", "11:30");
  const last = orders[orders.length - 1] as AnalyticsOrder;

  it("16:30: λ = 0,5 + 4 + 0,5 = 5,0 ⇒ P(0) = e^−5 = 0,674 % < 1 % ⇒ misstänkt fel", () => {
    const h = health(orders, sthlm("2026-11-04", "16:30"));
    expect(h.status).toBe("suspected_fault");
    expect(h.source).toBe("sales");
    expect(h.since).toBe("2026-11-04T10:30:00.000Z");
    expect(h.silence?.minutes).toBe(300);
    expect(h.silence?.expectedMilli).toBe(5_000);
    expect(h.silence?.zeroProbabilityBp).toBe(67);
    // 56 dagar × 8 order + ons 10:30 (timmen 11–12 är påbörjad och räknas inte) = 449.
    expect(h.silence?.historyOrders).toBe(449);
    // 56 × 24 timmar + 1 extra timme 25 okt. (sommartid slutar) + 00–11 i dag (11) = 1 356.
    expect(h.silence?.historyHours).toBe(1_356);
    // Mest bidrag: onsdag 12, 13, 14 (1,0 pack var).
    expect(h.silence?.topSlots.map((s) => [s.weekday, s.hour, s.expectedMilli])).toEqual([
      [3, 12, 1_000],
      [3, 13, 1_000],
      [3, 14, 1_000],
    ]);
    expect(nbsp(h.detail)).toContain("Ingen försäljning sedan ons 4 nov. 11:30 (5 timmar)");
    expect(nbsp(h.detail)).toContain("brukar sälja ca 5,0 pack");
    // Sannolikheten (0,67 %) står i Underlag, texten säger det med vanliga ord.
    expect(nbsp(h.detail)).toContain("Så lång tystnad är mycket ovanlig.");
    expect(h.evidence.figures.find((f) => f.key === "zeroProbabilityBp")?.value).toBe(67);
    // Underlag: sista ordern + 8 onsdagar × 6 veckotimmar (11–16) = 49 order.
    expect(h.evidence.orderIds).toHaveLength(49);
    expect(h.evidence.orderIds).toContain(last.id);
    expect(h.evidence.dates).toEqual(["2026-11-04"]);
    expect(h.evidence.machineIds).toEqual(["m1"]);
    const fig = Object.fromEntries(h.evidence.figures.map((f) => [f.key, f.value]));
    expect(fig).toMatchObject({
      silenceMinutes: 300,
      expectedTenths: 50,
      zeroProbabilityBp: 67,
      alarmProbabilityBp: 100,
    });
    expect(h.link).toBe("/automater/m1");
  });

  it("16:00: λ = 4,5 ⇒ P(0) = 1,11 % ≥ 1 % ⇒ i drift (gränsen är strikt)", () => {
    const h = health(orders, sthlm("2026-11-04", "16:00"));
    expect(h.status).toBe("ok");
    expect(h.silence?.expectedMilli).toBe(4_500);
    expect(h.silence?.zeroProbabilityBp).toBe(111);
    expect(h.silence?.anomalous).toBe(false);
  });

  it("natt: sista order ons 17:30, nu tor 07:00 ⇒ λ = 0,5 ⇒ P(0) = 60,65 % ⇒ i drift", () => {
    const night = hourlyUntil("m1", "2026-09-01", "2026-11-04", "17:30");
    const h = health(night, sthlm("2026-11-05", "07:00"));
    expect(h.status).toBe("ok");
    expect(h.silence?.minutes).toBe(13 * 60 + 30);
    expect(h.silence?.expectedMilli).toBe(500);
    expect(h.silence?.zeroProbabilityBp).toBe(6_065);
    // Tor 10:45: λ = 0,5 + 0,75 = 1,25 ⇒ e^−1,25 = 28,65 %.
    const morning = health(night, sthlm("2026-11-05", "10:45"));
    expect(morning.status).toBe("ok");
    expect(morning.silence?.zeroProbabilityBp).toBe(2_865);
  });

  it("stängd söndag: sista order lör 17:30, nu mån 09:30 ⇒ λ = 0,5 ⇒ i drift", () => {
    const closedSun = hourlyUntil("m1", "2026-09-01", "2026-11-07", "17:30", [7]);
    const h = health(closedSun, sthlm("2026-11-09", "09:30"));
    expect(h.status).toBe("ok");
    expect(h.silence?.expectedMilli).toBe(500);
    expect(h.silence?.zeroProbabilityBp).toBe(6_065);
  });

  it("härlett offline: tyst tis 17:30 → ons 18:00 (24,5 h), λ = 8,5 ⇒ 2 bp, utan maskindata", () => {
    const o = hourlyUntil("m1", "2026-09-01", "2026-11-03", "17:30");
    const h = health(o, sthlm("2026-11-04", "18:00"));
    expect(h.status).toBe("offline");
    expect(h.source).toBe("sales");
    expect(h.silence?.expectedMilli).toBe(8_500);
    expect(h.silence?.zeroProbabilityBp).toBe(2);
    expect(h.title).toBe("Automat 1 är troligen ur drift");
    // 23,5 h (ons 17:00): λ = 7,5 ⇒ e^−7,5 = 0,055 % ⇒ fortfarande bara misstänkt fel.
    const before = health(o, sthlm("2026-11-04", "17:00"));
    expect(before.status).toBe("suspected_fault");
    expect(before.silence?.zeroProbabilityBp).toBe(6);
    // Med anslutningsdata (heartbeat 17:55) är automaten online ⇒ misstänkt fel, inte offline.
    const withVendor = health(o, sthlm("2026-11-04", "18:00"), {
      signals: [sig("heartbeat", sthlm("2026-11-04", "17:55"))],
    });
    expect(withVendor.status).toBe("suspected_fault");
  });

  it("ny automat (driftstart mån 2 nov.): 17 order < 20 i historiken ⇒ okänt, inget larm", () => {
    const o = hourlyUntil("m1", "2026-11-02", "2026-11-04", "11:30");
    const [h] = machineHealth(
      { orders: o, machines: [{ ...M1, activeFrom: "2026-11-02" }] },
      sthlm("2026-11-04", "16:30"),
    );
    expect(h?.status).toBe("unknown");
    expect(h?.silence?.historyOrders).toBe(17);
    // Onsdagstimmarna 11–16 har aldrig förekommit efter driftstart ⇒ λ = 0.
    expect(h?.silence?.expectedMilli).toBe(0);
    expect(healthAlerts(h ? [h] : [])).toEqual([]);
  });

  it("ordning: leverantörens offline > fel > tom > tystnad", () => {
    const now = sthlm("2026-11-04", "16:30");
    const empty = [{ machineId: "m1", titleId: "t1", onHand: 0 }];
    const offline = health(orders, now, {
      stock: empty,
      signals: [
        sig("offline", sthlm("2026-11-04", "12:00")),
        sig("fault", sthlm("2026-11-04", "11:45"), { code: "E21" }),
      ],
    });
    expect([offline.status, offline.source, offline.since]).toEqual([
      "offline",
      "vendor",
      "2026-11-04T11:00:00.000Z",
    ]);
    const fault = health(orders, now, {
      stock: empty,
      signals: [
        sig("fault", sthlm("2026-11-04", "11:45"), { code: "E21", message: "Spiral 4 fastnar" }),
      ],
    });
    expect([fault.status, fault.title]).toEqual(["fault", "Automat 1 har fel: Spiral 4 fastnar"]);
    expect(health(orders, now, { stock: empty }).status).toBe("empty");
    // Åtgärdat fel ⇒ tillbaka till härledningen ur tystnaden.
    const cleared = health(orders, now, {
      signals: [
        sig("fault", sthlm("2026-11-04", "11:45")),
        sig("fault_cleared", sthlm("2026-11-04", "12:15")),
      ],
    });
    expect(cleared.status).toBe("suspected_fault");
  });
});

// ---------------------------------------------------------------------------
// 2. Incidenter: samma problem larmar inte tio gånger
// ---------------------------------------------------------------------------

function cand(kind: AlertKind, severity: AlertSeverity, key = "machine:m1"): AlertCandidate {
  return {
    key,
    kind,
    severity,
    machineId: "m1",
    titleId: null,
    title: `${kind} m1`,
    detail: "",
    evidence: evidence({ rule: "revision", machineIds: ["m1"] }),
    link: "/automater/m1",
  };
}

const T0 = Date.parse("2026-11-02T08:00:00Z");
const atMin = (m: number) => new Date(T0 + m * 60_000).toISOString();

function runSeries(steps: [number, AlertCandidate[]][]) {
  let incidents: AlertIncident[] = [];
  const sent: [number, string, AlertSeverity][] = [];
  for (const [m, c] of steps) {
    const r = reconcileAlerts(c, incidents, atMin(m));
    incidents = r.incidents;
    for (const n of r.notifications) sent.push([m, n.reason, n.severity]);
  }
  return { incidents, sent };
}

describe("revision 2: deduplicering, stängning, fladder och återlarm", () => {
  const offline = cand("machine_offline", "critical");
  const suspected = cand("machine_suspected_fault", "warning");

  it("stängs efter 30 min, fladder inom 2 h öppnar samma incident tyst, ingen andra 'Löst'", () => {
    const { incidents, sent } = runSeries([
      [0, [offline]], //       ny → avisering
      [10, []], //             10 min utan: fortfarande öppen
      [30, []], //             30 min: stängs, "Löst"
      [90, [offline]], //      60 min efter stängning (< 120): samma incident, ingen avisering
      [100, []],
      [120, [offline]], //     fortfarande samma
      [150, []], //            30 min sedan sedd: stängs, ingen ny "Löst" (inget aviserat sedan sist)
      [280, [offline]], //     130 min efter stängning (> 120): ny incident, ny avisering
    ]);
    expect(sent).toEqual([
      [0, "new", "critical"],
      [30, "resolved", "critical"],
      [280, "new", "critical"],
    ]);
    const first = incidents.find((i) => i.id === "machine:m1@2026-11-02T08:00:00.000Z");
    expect(first?.status).toBe("closed");
    expect(first?.reopenCount).toBe(1);
    expect(first?.closedAt).toBe(atMin(150));
    expect(incidents.filter((i) => i.status === "open")).toHaveLength(1);
  });

  it("påminnelse: critical efter 4 h, inte efter kvittering", () => {
    let incidents: AlertIncident[] = [];
    const reasons: [number, string][] = [];
    for (let m = 0; m <= 9 * 60; m += 10) {
      const r = reconcileAlerts([offline], incidents, atMin(m));
      incidents = r.incidents;
      for (const n of r.notifications) reasons.push([m, n.reason]);
      if (m === 250) incidents = incidents.map((i) => acknowledgeIncident(i, "u1", atMin(m)));
    }
    // 0 ny, 240 påminnelse (exakt 4 h), kvitterad 250 ⇒ ingen vid 480.
    expect(reasons).toEqual([
      [0, "new"],
      [240, "reminder"],
    ]);
  });

  it("warning påminner efter 24 h, inte före", () => {
    const steps: [number, AlertCandidate[]][] = [];
    for (let m = 0; m <= 24 * 60; m += 60) steps.push([m, [suspected]]);
    const { sent } = runSeries(steps);
    expect(sent).toEqual([
      [0, "new", "warning"],
      [1_440, "reminder", "warning"],
    ]);
  });

  it("skärpning misstänkt fel → offline aviseras en gång; fladder offline ↔ misstänkt larmar inte igen", () => {
    // Leverantören rapporterar offline/online om vartannat (instabil uppkoppling) medan
    // automaten är tyst: status växlar offline (critical) ↔ misstänkt fel (warning) var 10:e
    // minut. Användaren har redan fått veta att automaten är offline (critical) vid 10 min;
    // samma problem ska inte larma igen vid 30, 50, 70 … min.
    const steps: [number, AlertCandidate[]][] = [[0, [suspected]]];
    for (let m = 10; m <= 120; m += 10) steps.push([m, [(m / 10) % 2 === 1 ? offline : suspected]]);
    const { sent } = runSeries(steps);
    expect(sent).toEqual([
      [0, "new", "warning"],
      [10, "escalated", "critical"],
    ]);
  });

  it("misstänkt fel och offline för samma automat i samma körning blir en incident", () => {
    const r = reconcileAlerts([suspected, offline], [], atMin(0));
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]?.kind).toBe("machine_offline");
    expect(r.notifications.map((n) => n.reason)).toEqual(["new"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Avvikande dag och gruppering
// ---------------------------------------------------------------------------

/** `perDay` order på dagen (affärsdatum utan tidpunkt). */
function onDate(machineId: string, date: IsoDate, perDay: number): AnalyticsOrder[] {
  return Array.from({ length: perDay }, () => order(machineId, date, null));
}

describe("revision 3: avvikande dag", () => {
  // Måndag 2 nov. bedöms; jämförs med de 8 måndagarna 7 sep. … 26 okt. à 20 pack ⇒ λ = 20.
  const history: AnalyticsOrder[] = [];
  for (let w = 1; w <= 8; w++) history.push(...onDate("m1", addDays("2026-11-02", -7 * w), 20));
  const now = sthlm("2026-11-03", "06:00");
  const run = (actual: number, opts = { perMachine: false }) =>
    dayAnomalyAlerts(
      {
        orders: [...history, ...onDate("m1", "2026-11-02", actual)],
        machines: [M1],
        options: opts,
      },
      now,
    );

  it("8 pack: −60 %, P(X ≤ 8 | 20) = 0,21 % ⇒ låg dag (warning)", () => {
    const [a, ...rest] = run(8);
    expect(rest).toEqual([]);
    expect(a?.key).toBe("day_anomaly:all:2026-11-02");
    expect(a?.severity).toBe("warning");
    expect(a?.oneShot).toBe(true);
    expect(nbsp(a?.title)).toBe("Ovanligt låg försäljning mån 2 nov.: 8 pack, normalt 20,0");
    expect(nbsp(a?.detail)).toContain("−60 %");
    expect(nbsp(a?.detail)).toContain("0,21 %");
    const fig = Object.fromEntries((a?.evidence.figures ?? []).map((f) => [f.key, f.value]));
    expect(fig).toEqual({ actual: 8, expectedTenths: 200, deviationBp: -6_000, probabilityBp: 21 });
    expect(a?.evidence.orderIds).toHaveLength(8);
    expect(a?.evidence.dates).toHaveLength(9);
  });

  it("12 pack: −40 % men P(X ≤ 12 | 20) = 3,90 % ⇒ inget larm", () => {
    expect(run(12)).toEqual([]);
  });

  it("33 pack: +65 %, P(X ≥ 33 | 20) = 0,47 % ⇒ hög dag (info); 30 pack: 2,18 % ⇒ inget", () => {
    const [a] = run(33);
    expect(a?.severity).toBe("info");
    expect(a?.evidence.figures.find((f) => f.key === "probabilityBp")?.value).toBe(47);
    expect(run(30)).toEqual([]);
  });

  it("prognos ersätter historiken: prognos 10,0, utfall 2 ⇒ P(X ≤ 2 | 10) = 0,28 % ⇒ låg", () => {
    // e^−10 (1 + 10 + 50) = 61 × 4,54e−5 = 0,277 % ⇒ 28 bp.
    const r = dayAnomalyAlerts(
      {
        orders: onDate("m1", "2026-11-02", 2),
        machines: [M1],
        forecasts: [{ scope: "all", date: "2026-11-02", expectedTenths: 100 }],
        options: { perMachine: false },
      },
      now,
    );
    expect(r.map((a) => a.evidence.figures.find((f) => f.key === "probabilityBp")?.value)).toEqual([
      28,
    ]);
  });

  it("låg dag för en automat stryks när en import misslyckats (siffrorna är ofullständiga)", () => {
    const low = run(8, { perMachine: true }).find((a) => a.machineId === "m1");
    expect(low).toBeDefined();
    const importFail: AlertCandidate = {
      ...cand("import_failed", "critical", "import:ds1"),
      machineId: null,
    };
    const { kept } = suppressRelated([...(low ? [low] : []), importFail]);
    expect(kept.map((c) => c.key)).toEqual(["import:ds1"]);
  });

  it("med en enda automat ger en låg dag ett larm, inte två (hela org. + automaten)", () => {
    const r = run(8, { perMachine: true });
    const { kept } = suppressRelated(r);
    expect(kept).toHaveLength(1);
  });

  it("låg dag som förklaras av driftlarm larmar inte heller senare samma dag när driftlarmet löst sig", () => {
    // 06:00: automaten är offline och gårdagen var låg ⇒ låg dag stryks (driftlarmet förklarar den).
    // 06:40: automaten fungerar igen (ingen kandidat) ⇒ driftincidenten stängs. 06:50: regeln
    // körs igen för samma dag ⇒ samma låga dag (samma orsak) ska inte larma nu.
    const low = run(8, { perMachine: true }).filter((a) => a.machineId === "m1");
    const down = cand("machine_offline", "critical");
    const t = (hhmm: string) => sthlm("2026-11-03", hhmm);
    const r1 = reconcileAlerts([down, ...low], [], t("06:00"));
    expect(r1.notifications.map((n) => n.key)).toEqual(["machine:m1"]);
    const r2 = reconcileAlerts([], r1.incidents, t("06:40"));
    const r3 = reconcileAlerts(low, r2.incidents, t("06:50"));
    expect(r3.notifications.map((n) => n.key)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Titel nära slut och import
// ---------------------------------------------------------------------------

describe("revision 4: titel nära slut och misslyckad import", () => {
  // 14 hela dagar t.o.m. i går, sön 1 nov. (19 okt. – 1 nov.), 2 pack/dag = 28 pack ⇒ takt
  // 28/14. Takten slutar i går, som påfyllningspunkterna i Att göra; dagens 2 pack räknas inte.
  const orders: AnalyticsOrder[] = [];
  for (let d = 0; d < 15; d++) orders.push(...onDate("m1", addDays("2026-10-19", d), 2));
  const titles = [{ id: "t1", name: "30th Celebration" }];
  const now = sthlm("2026-11-02", "12:00");
  const run = (onHand: number) =>
    lowStockAlerts(
      { orders, stock: [{ machineId: "m1", titleId: "t1", onHand }], machines: [M1], titles },
      now,
    );

  it("5 kvar: golv(5 × 14 / 28) = 2 dagar ≤ 2 ⇒ warning; slut i går + tak(2,5) = 3 dagar ⇒ ons 4 nov.", () => {
    const [a] = run(5);
    expect(a?.severity).toBe("warning");
    expect(a?.key).toBe("low_stock:m1:t1");
    expect(nbsp(a?.title)).toBe("30th Celebration i Automat 1 tar slut ons 4 nov.");
    expect(nbsp(a?.detail)).toBe(
      "5 pack kvar, säljer 2,0 pack/dag (28 pack på 14 dagar). Beräknat slut ons 4 nov.",
    );
    expect(a?.evidence.orderIds).toHaveLength(28);
    expect(a?.evidence.period).toEqual({ start: "2026-10-19", end: "2026-11-01" });
  });

  it("6 kvar: 3 dagar > 2 ⇒ inget larm; 0 kvar ⇒ critical 'slut'", () => {
    expect(run(6)).toEqual([]);
    const [a] = run(0);
    expect(a?.severity).toBe("critical");
    expect(nbsp(a?.title)).toBe("30th Celebration är slut i Automat 1");
  });

  it("två misslyckade importer i rad ⇒ en critical med båda; lyckad import löser", () => {
    const src = {
      id: "ds1",
      name: "Awish",
      provider: "awish",
      status: "active" as const,
      lastSyncedAt: "2026-11-02T08:00:00Z",
      expectedIntervalMinutes: 10,
    };
    const run = (status: "failed" | "succeeded", id: string, at: string) => ({
      id,
      dataSourceId: "ds1",
      status,
      startedAt: at,
      finishedAt: at,
      createdAt: at,
      rowsTotal: 10,
      rowsError: 0,
      rowsConflict: 0,
      message: status === "failed" ? "Timeout" : null,
    });
    const imports = [
      run("succeeded", "i1", "2026-11-02T08:00:00Z"),
      run("failed", "i2", "2026-11-02T08:10:00Z"),
      run("failed", "i3", "2026-11-02T08:20:00Z"),
    ];
    const [a, ...rest] = importAlerts({ sources: [src], imports }, "2026-11-02T08:25:00Z");
    expect(rest).toEqual([]);
    expect(a?.severity).toBe("critical");
    expect(a?.key).toBe("import:ds1");
    expect(nbsp(a?.detail)).toContain("2 misslyckade importer i rad, senast mån 2 nov. 09:20");
    expect(a?.evidence).toMatchObject({ importIds: ["i2", "i3"], dataSourceIds: ["ds1"] });
    const ok = importAlerts(
      {
        sources: [{ ...src, lastSyncedAt: "2026-11-02T08:30:00Z" }],
        imports: [...imports, run("succeeded", "i4", "2026-11-02T08:30:00Z")],
      },
      "2026-11-02T08:35:00Z",
    );
    expect(ok).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Prenumerationer och tysta timmar
// ---------------------------------------------------------------------------

describe("revision 5: prenumerationer", () => {
  // Mån 2 nov. 23:15 i Stockholm = 22:15Z.
  const now = "2026-11-02T22:15:00Z";
  const r = reconcileAlerts(
    [
      cand("machine_offline", "critical"),
      { ...cand("low_stock", "warning", "low_stock:m1:t1"), titleId: "t1" },
      {
        ...cand("day_anomaly", "info", "day_anomaly:all:2026-11-02"),
        machineId: null,
        oneShot: true,
      },
    ],
    [],
    now,
  );

  it("tysta timmar 22–07: warning skjuts till 07:00 (06:00Z), critical går direkt; dubbel prenumeration ger ett exemplar", () => {
    const subs: AlertSubscription[] = [
      {
        userId: "u1",
        kinds: "all",
        machineIds: "all",
        quietHours: { start: "22:00", end: "07:00" },
      },
      { userId: "u1", kinds: ["machine_offline"], machineIds: ["m1"] },
    ];
    const d = routeNotifications(r.notifications, subs, now);
    expect(d.map((x) => [x.sendAt, x.deferred, x.items.map((i) => i.key)])).toEqual([
      ["2026-11-02T22:15:00.000Z", false, ["machine:m1"]],
      ["2026-11-03T06:00:00.000Z", true, ["low_stock:m1:t1"]],
    ]);
  });

  it("tidszon för prenumerationen: 22:15Z = 06:15 i Shanghai ⇒ till 07:00 (23:00Z); 23:15Z = 07:15 ⇒ direkt", () => {
    const sub: AlertSubscription = {
      userId: "u2",
      kinds: ["low_stock"],
      machineIds: "all",
      quietHours: { start: "22:00", end: "07:00" },
      timeZone: "Asia/Shanghai",
    };
    expect(routeNotifications(r.notifications, [sub], now)[0]?.sendAt).toBe(
      "2026-11-02T23:00:00.000Z",
    );
    expect(routeNotifications(r.notifications, [sub], "2026-11-02T23:15:00Z")[0]?.sendAt).toBe(
      "2026-11-02T23:15:00.000Z",
    );
  });

  it("filter: automat m2 och minsta allvar critical ger inget för m1:s varning", () => {
    expect(
      routeNotifications(
        r.notifications,
        [{ userId: "u3", kinds: "all", machineIds: ["m2"] }],
        now,
      ),
    ).toEqual([]);
    const crit = routeNotifications(
      r.notifications,
      [{ userId: "u3", kinds: "all", machineIds: "all", minSeverity: "critical" }],
      now,
    );
    expect(crit.flatMap((x) => x.items.map((i) => i.key))).toEqual(["machine:m1"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Besöksplan
// ---------------------------------------------------------------------------

describe("revision 6: besöksplan", () => {
  // Mån 2 nov. Takt för t1 i alla automater: 28 pack på 14 dagar (2/dag).
  const orders: AnalyticsOrder[] = [];
  for (const m of ["A", "B", "C"])
    for (let d = 0; d < 14; d++) orders.push(...onDate(m, addDays("2026-10-20", d), 2));
  const mk = (id: string, lng: number): VisitMachine => ({
    id,
    name: `Automat ${id}`,
    activeFrom: null,
    activeTo: null,
    location: { lat: 59, lng },
  });
  const plan = planVisits(
    {
      orders,
      machines: [mk("A", 18.05), mk("B", 18.1), mk("C", 18.2)],
      titles: [{ id: "t1", name: "30th Celebration" }],
      stock: [
        { machineId: "A", titleId: "t1", onHand: 7 }, // slut +tak(3,5)=4 ⇒ fre 6/11; senast tor 5/11
        { machineId: "B", titleId: "t1", onHand: 3 }, // slut +tak(1,5)=2 ⇒ ons 4/11; senast tis 3/11
        { machineId: "C", titleId: "t1", onHand: 30 }, // slut +15 ⇒ 17/11; senast 16/11 > 8/11
      ],
      capacities: [{ machineId: "A", titleId: "t1", capacity: 20 }],
      warehouseStock: [{ titleId: "t1", onHand: 20 }],
      depot: { lat: 59, lng: 18 },
    },
    sthlm("2026-11-02", "10:00"),
  );

  it("A (tor, ensam) slås ihop med B:s tisdag; C behövs inte i veckan", () => {
    expect(plan.period).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(plan.days.map((d) => d.date)).toEqual(["2026-11-03"]);
    expect(plan.notNeeded).toEqual([{ machineId: "C", needBy: "2026-11-16" }]);
    expect(plan.overflow).toEqual([]);
  });

  it("packlista: lager vid besök = lager − golv(28 × 1 / 14) = −2; B först ur centrallagret", () => {
    const day = plan.days[0];
    const a = day?.stops.find((s) => s.machineId === "A");
    const b = day?.stops.find((s) => s.machineId === "B");
    // B: 3 − 2 = 1, mål tak(28 × 7 / 14) = 14 ⇒ 13, får alla 13 (mest brådskande).
    expect(b?.packs[0]).toMatchObject({
      projectedAtVisit: 1,
      target: 14,
      quantity: 13,
      shortBy: 0,
    });
    // A: 7 − 2 = 5, mål kapacitet 20 ⇒ 15, centrallagret har 20 − 13 = 7 kvar ⇒ 8 saknas.
    expect(a?.packs[0]).toMatchObject({ projectedAtVisit: 5, target: 20, quantity: 7, shortBy: 8 });
    expect(nbsp(a?.reasons.join(" | "))).toContain(
      "Vårt lager räcker inte: 8 × 30th Celebration saknas",
    );
    expect(a?.late).toBe(false);
    expect(a?.needBy).toBe("2026-11-05");
    expect(day?.load).toEqual([{ titleId: "t1", titleName: "30th Celebration", quantity: 20 }]);
    expect(a?.evidence.orderIds).toHaveLength(28);
  });

  it("rutt: depå → A (2 863 m) → B (2 863 m) → depå (5 727 m) = 11 453 m, trots att B är mest brådskande", () => {
    const day = plan.days[0];
    expect(day?.routeMethod).toBe("distance");
    expect(day?.stops.map((s) => [s.machineId, s.sequence, s.distanceFromPreviousMeters])).toEqual([
      ["A", 1, 2_863],
      ["B", 2, 2_863],
    ]);
    expect(day?.totalMeters).toBe(11_453);
    expect(nbsp(day?.title)).toBe("tis 3 nov.: 2 besök, 20 pack, 11,5 km");
  });
});

// ---------------------------------------------------------------------------
// 7. Tidslinje
// ---------------------------------------------------------------------------

describe("revision 7: tidslinje per automat", () => {
  it("slår ihop försäljning per timme, påfyllning, fel och ärende i tidsordning", () => {
    const o1 = order("m1", "2026-11-02", "14:10");
    const o2 = order("m1", "2026-11-02", "14:40");
    const o3 = order("m1", "2026-11-02", "15:05");
    const other = order("m2", "2026-11-02", "14:15");
    const tl = machineTimeline(
      {
        machineId: "m1",
        orders: [o1, o2, o3, other],
        titles: [{ id: "t1", name: "30th Celebration" }],
        stockEvents: [
          {
            id: "e1",
            machineId: "m1",
            titleId: "t1",
            kind: "refill",
            quantity: 12,
            occurredAt: sthlm("2026-11-02", "14:20"),
          },
          {
            id: "e2",
            machineId: "m1",
            titleId: "t1",
            kind: "sale",
            quantity: -1,
            occurredAt: sthlm("2026-11-02", "14:10"),
          },
        ],
        signals: [
          sig("fault", sthlm("2026-11-02", "14:30"), { code: "E21", message: "Spiral 4 fastnar" }),
          sig("heartbeat", sthlm("2026-11-02", "14:35")),
        ],
        incidents: [
          {
            id: "inc1",
            machineId: "m1",
            kind: "jam",
            startedAt: sthlm("2026-11-02", "14:31"),
            endedAt: sthlm("2026-11-02", "16:00"),
            description: "Spiral 4",
            actionTaken: "Spiral rättad",
          },
        ],
      },
      { from: sthlm("2026-11-02", "00:00"), to: sthlm("2026-11-03", "00:00"), order: "asc" },
    );
    expect(tl.map((e) => [e.time, e.kind, nbsp(e.title), e.packs])).toEqual([
      ["14:00", "sales", "Försäljning 14–15: 2 pack", -2],
      ["14:20", "refill", "Påfyllning: 12 × 30th Celebration", 12],
      ["14:30", "signal", "Fel", 0],
      ["14:31", "incident_opened", "Ärende öppnat: Spiral 4", 0],
      ["15:00", "sales", "Försäljning 15–16: 1 pack", -1],
      ["16:00", "incident_closed", "Ärende stängt: Spiral 4", 0],
    ]);
    expect(tl[0]?.evidence.orderIds).toEqual([o1.id, o2.id].sort());
    expect(nbsp(tl[2]?.detail)).toBe("Spiral 4 fastnar (E21). Källa: awish_grpc.");
    expect(nbsp(tl[5]?.detail)).toBe("Åtgärd: Spiral rättad. Varade 1 timme.");
  });
});
