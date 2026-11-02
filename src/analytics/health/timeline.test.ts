import { describe, expect, it } from "vitest";
import { machineTimeline, type TimelineInput } from "./index";
import { localIso, timedOrder } from "./test-helpers";

const t = (s: string) => s.replace(/ /g, " ");

function input(p: Partial<TimelineInput> = {}): TimelineInput {
  return {
    machineId: "m1",
    titles: [
      { id: "t1", name: "30th Celebration" },
      { id: "t2", name: "Surging Sparks" },
    ],
    orders: [
      timedOrder("m1", "2026-11-02", "14:05", "t1"),
      timedOrder("m1", "2026-11-02", "14:40", "t1"),
      timedOrder("m1", "2026-11-02", "14:50", "t2"),
      timedOrder("m1", "2026-11-02", "16:10", "t2"),
      timedOrder("m2", "2026-11-02", "14:10", "t2"), // annan automat
    ],
    stockEvents: [
      {
        id: "e1",
        machineId: "m1",
        titleId: "t1",
        kind: "refill",
        quantity: 12,
        occurredAt: localIso("2026-11-02", "09:00"),
      },
      {
        id: "e2",
        machineId: "m1",
        titleId: "t1",
        kind: "sale",
        quantity: -1,
        occurredAt: localIso("2026-11-02", "14:05"),
      },
      {
        id: "e3",
        machineId: "m1",
        titleId: "t2",
        kind: "waste",
        quantity: -1,
        occurredAt: localIso("2026-11-02", "15:00"),
        note: "Trasig förpackning",
      },
    ],
    signals: [
      {
        id: "s1",
        machineId: "m1",
        at: localIso("2026-11-02", "15:30"),
        kind: "fault",
        code: "E21",
        message: "Spiral 4 fastnar",
        source: "awish_grpc",
      },
      {
        id: "s2",
        machineId: "m1",
        at: localIso("2026-11-02", "15:31"),
        kind: "heartbeat",
        source: "awish_grpc",
      },
    ],
    incidents: [
      {
        id: "i1",
        machineId: "m1",
        kind: "jam",
        startedAt: localIso("2026-11-02", "15:35"),
        endedAt: localIso("2026-11-02", "16:05"),
        description: "Spiral 4",
        actionTaken: "Spiralen rättad",
      },
    ],
    ...p,
  };
}

const range = { from: localIso("2026-11-02", "00:00"), to: localIso("2026-11-03", "00:00") };

describe("machineTimeline", () => {
  it("slår ihop försäljning per timme, lager, maskinhändelser och ärenden", () => {
    const rows = machineTimeline(input(), { ...range, order: "asc" });
    expect(rows.map((r) => [r.time, r.kind, t(r.title)])).toEqual([
      ["09:00", "refill", "Påfyllning: 12 × 30th Celebration"],
      ["14:00", "sales", "Försäljning 14–15: 3 pack"],
      ["15:00", "waste", "Svinn: 1 × Surging Sparks"],
      ["15:30", "signal", "Fel"],
      ["15:35", "incident_opened", "Ärende öppnat: Spiral 4"],
      ["16:00", "sales", "Försäljning 16–17: 1 pack"],
      ["16:05", "incident_closed", "Ärende stängt: Spiral 4"],
    ]);
    const sales = rows.find((r) => r.kind === "sales");
    expect(sales?.detail).toBe("2 × 30th Celebration, 1 × Surging Sparks");
    expect(sales?.packs).toBe(-3);
    expect(sales?.evidence.orderIds).toHaveLength(3);
    expect(rows.find((r) => r.kind === "signal")?.detail).toBe(
      "Spiral 4 fastnar (E21). Källa: awish_grpc.",
    );
    expect(rows.find((r) => r.kind === "incident_closed")?.detail).toBe(
      "Åtgärd: Spiralen rättad. Varade 30 min.",
    );
  });

  it("senaste först som standard", () => {
    const rows = machineTimeline(input(), range);
    expect(rows[0]?.kind).toBe("incident_closed");
    expect(rows[rows.length - 1]?.kind).toBe("refill");
  });

  it("per order och per dag", () => {
    const perOrder = machineTimeline(input(), { ...range, salesGrouping: "order" });
    expect(perOrder.filter((r) => r.kind === "sales")).toHaveLength(4);
    const perDay = machineTimeline(input(), { ...range, salesGrouping: "day" });
    const day = perDay.filter((r) => r.kind === "sales");
    expect(day).toHaveLength(1);
    expect(t(day[0]?.title ?? "")).toBe("Försäljning under dagen: 4 pack");
    expect(day[0]?.time).toBe("00:00");
  });

  it("filtrerar på intervallet [from, to)", () => {
    const rows = machineTimeline(input(), {
      from: localIso("2026-11-02", "14:00"),
      to: localIso("2026-11-02", "15:00"),
    });
    expect(rows.map((r) => r.kind)).toEqual(["sales"]);
  });

  it("pågående ärende är kritiskt", () => {
    const rows = machineTimeline(
      input({
        incidents: [
          {
            id: "i2",
            machineId: "m1",
            kind: "power",
            startedAt: localIso("2026-11-02", "10:00"),
            endedAt: null,
          },
        ],
      }),
      range,
    );
    const open = rows.find((r) => r.kind === "incident_opened");
    expect(open?.severity).toBe("critical");
    expect(open?.title).toBe("Ärende öppnat: power");
    expect(open?.detail).toBe("Pågår.");
  });

  it("underlaget bär id för maskinhändelse, lagerhändelse och ärende", () => {
    const rows = machineTimeline(input(), { ...range, order: "asc" });
    const ev = (kind: string) => rows.find((r) => r.kind === kind)?.evidence;
    expect(ev("signal")?.signalIds).toEqual(["s1"]);
    expect(ev("refill")?.stockEventIds).toEqual(["e1"]);
    expect(ev("waste")?.stockEventIds).toEqual(["e3"]);
    expect(ev("incident_opened")?.incidentIds).toEqual(["i1"]);
    expect(ev("incident_closed")?.incidentIds).toEqual(["i1"]);
    expect(ev("sales")?.signalIds).toBeUndefined();
  });
});
