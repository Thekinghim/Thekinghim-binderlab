import { describe, expect, it } from "vitest";
import { addDays } from "@/domain";
import { daily, machine, many } from "@/analytics/todos/test-helpers";
import { machineHealth } from "@/analytics/health";
import { halfHourly, localIso, localMs, scheduleOrders } from "@/analytics/health/test-helpers";
import {
  dayAnomalyAlerts,
  healthAlerts,
  importAlerts,
  lowStockAlerts,
  reconcileAlerts,
  type DataSourceRef,
  type ImportRunRef,
} from "./index";

const t = (s: string | undefined) => (s ?? "").replace(/ /g, " ");
const NOW = "2026-11-02T09:00:00Z"; // måndag 10:00 svensk tid

describe("healthAlerts", () => {
  it("misstänkt fel ur maskinhälsan blir ett larm med samma underlag, och dedupliceras över tid", () => {
    const orders = scheduleOrders("m1", "2026-09-01", 70, halfHourly(10, 20), {
      until: localMs("2026-11-02", "13:50"),
    });
    const machines = [machine("m1", "Automat 1")];
    const evaluate = (time: string) =>
      healthAlerts(machineHealth({ machines, orders }, localIso("2026-11-02", time)));
    const first = evaluate("18:30");
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("machine_suspected_fault");
    expect(first[0]?.severity).toBe("warning");
    expect(first[0]?.key).toBe("machine:m1");
    expect(first[0]?.evidence.machineIds).toEqual(["m1"]);

    let incidents = reconcileAlerts(first, [], localIso("2026-11-02", "18:30")).incidents;
    let notes = 0;
    for (const time of ["18:40", "18:50", "19:00", "19:10", "19:20"]) {
      const r = reconcileAlerts(evaluate(time), incidents, localIso("2026-11-02", time));
      incidents = r.incidents;
      notes += r.notifications.length;
    }
    expect(notes).toBe(0);
    expect(incidents).toHaveLength(1);
  });

  it("ingen larm när automaten säljer som vanligt eller det är natt", () => {
    const orders = scheduleOrders("m1", "2026-09-01", 70, halfHourly(10, 20), {
      until: localMs("2026-11-02", "20:00"),
    });
    const res = machineHealth(
      { machines: [machine("m1", "Automat 1")], orders },
      localIso("2026-11-03", "06:00"),
    );
    expect(healthAlerts(res)).toEqual([]);
  });
});

describe("lowStockAlerts", () => {
  const machines = [machine("m1", "Automat 3")];
  const titles = [
    { id: "t1", name: "30th Celebration" },
    { id: "t2", name: "Surging Sparks" },
  ];
  // 2 pack per dag de senaste 14 dagarna (19 okt.–1 nov.) + 2 i dag.
  const orders = [
    ...daily("t1", "m1", "2026-10-19", 15, 2),
    ...daily("t2", "m1", "2026-10-19", 15, 1),
  ];

  it("varnar när lagret räcker högst 2 dagar", () => {
    const res = lowStockAlerts(
      { orders, machines, titles, stock: [{ machineId: "m1", titleId: "t1", onHand: 5 }] },
      NOW,
    );
    expect(res).toHaveLength(1);
    const a = res[0];
    expect(a?.severity).toBe("warning");
    expect(a?.key).toBe("low_stock:m1:t1");
    expect(t(a?.title)).toBe("30th Celebration i Automat 3 tar slut om 2 dagar");
    expect(t(a?.detail)).toBe(
      "5 pack kvar, säljer 2,0 pack/dag (28 pack på 14 dagar). Beräknat slut tor 5 nov.",
    );
    expect(a?.evidence.orderIds).toHaveLength(28);
  });

  it("kritiskt när titeln är slut, inget larm med gott om lager eller utan försäljning", () => {
    const res = lowStockAlerts(
      {
        orders,
        machines,
        titles,
        stock: [
          { machineId: "m1", titleId: "t1", onHand: 0 },
          { machineId: "m1", titleId: "t2", onHand: 30 },
          { machineId: "m1", titleId: "t3", onHand: 1 },
        ],
      },
      NOW,
    );
    expect(res.map((r) => [r.key, r.severity])).toEqual([["low_stock:m1:t1", "critical"]]);
    expect(t(res[0]?.title)).toBe("30th Celebration är slut i Automat 3");
  });
});

describe("importAlerts", () => {
  const src: DataSourceRef = {
    id: "s1",
    name: "Awish CSV",
    provider: "awish_csv",
    status: "active",
    lastSyncedAt: "2026-11-02T08:00:00Z",
  };
  const run = (
    id: string,
    status: ImportRunRef["status"],
    finishedAt: string,
    p: Partial<ImportRunRef> = {},
  ): ImportRunRef => ({
    id,
    dataSourceId: "s1",
    status,
    startedAt: finishedAt,
    finishedAt,
    createdAt: finishedAt,
    rowsTotal: 100,
    rowsError: 0,
    rowsConflict: 0,
    ...p,
  });

  it("misslyckad import larmar kritiskt och räknar misslyckanden i rad", () => {
    const res = importAlerts(
      {
        sources: [src],
        imports: [
          run("i1", "succeeded", "2026-11-01T08:00:00Z"),
          run("i2", "failed", "2026-11-02T07:00:00Z"),
          run("i3", "failed", "2026-11-02T08:30:00Z", { message: "Kolumnen Order No. saknas" }),
        ],
      },
      NOW,
    );
    expect(res).toHaveLength(1);
    expect(res[0]?.severity).toBe("critical");
    expect(res[0]?.key).toBe("import:s1");
    expect(t(res[0]?.detail)).toBe(
      "2 misslyckade importer i rad, senast mån 2 nov. 09:30. Fel: Kolumnen Order No. saknas. Order efter senaste lyckade import saknas i siffrorna.",
    );
    expect(res[0]?.evidence.importIds).toEqual(["i2", "i3"]);
  });

  it("lyckad import efter misslyckad ger inget larm; fel på rader varnar", () => {
    const ok = importAlerts(
      {
        sources: [src],
        imports: [
          run("i1", "failed", "2026-11-02T07:00:00Z"),
          run("i2", "succeeded", "2026-11-02T08:00:00Z"),
        ],
      },
      NOW,
    );
    expect(ok).toEqual([]);
    const rows = importAlerts(
      {
        sources: [src],
        imports: [run("i2", "succeeded", "2026-11-02T08:00:00Z", { rowsError: 3 })],
      },
      NOW,
    );
    expect(t(rows[0]?.title)).toBe("3 rader kunde inte läsas från Awish CSV");
    expect(rows[0]?.severity).toBe("warning");
  });

  it("hängd import, källa med fel, pausad källa och schemalagd källa utan hämtning", () => {
    const stuck = importAlerts(
      {
        sources: [src],
        imports: [run("i1", "running", "2026-11-02T07:30:00Z", { finishedAt: null })],
      },
      NOW,
    );
    expect(t(stuck[0]?.title)).toBe("Import från Awish CSV har hängt sig");
    expect(
      importAlerts({ sources: [{ ...src, status: "error" }], imports: [] }, NOW)[0]?.severity,
    ).toBe("critical");
    expect(
      importAlerts(
        {
          sources: [{ ...src, status: "paused" }],
          imports: [run("x", "failed", "2026-11-02T08:00:00Z")],
        },
        NOW,
      ),
    ).toEqual([]);
    const grpc: DataSourceRef = {
      ...src,
      provider: "awish_grpc",
      expectedIntervalMinutes: 10,
      lastSyncedAt: "2026-11-02T08:15:00Z",
    };
    expect(importAlerts({ sources: [grpc], imports: [] }, NOW)).toEqual([]); // 45 min < 60
    const stale = importAlerts(
      { sources: [{ ...grpc, lastSyncedAt: "2026-11-02T06:00:00Z" }], imports: [] },
      NOW,
    );
    expect(t(stale[0]?.title)).toBe("Ingen hämtning från Awish CSV på 3 timmar");
  });
});

describe("dayAnomalyAlerts", () => {
  const machines = [machine("m1", "Automat 1"), machine("m2", "Automat 2")];
  // 10 pack per dag och automat i 8 veckor före söndag 1 nov.
  const history = [
    ...daily("t1", "m1", "2026-09-06", 56, 10),
    ...daily("t1", "m2", "2026-09-06", 56, 10),
  ];

  it("ovanligt låg dag för en automat (men inte för totalen)", () => {
    const orders = [
      ...history,
      ...many(2, { titleId: "t1", machineId: "m1", businessDate: "2026-11-01" }),
      ...many(10, { titleId: "t1", machineId: "m2", businessDate: "2026-11-01" }),
    ];
    const res = dayAnomalyAlerts({ orders, machines }, NOW);
    expect(res.map((r) => [r.key, r.severity])).toEqual([["day_anomaly:m1:2026-11-01", "warning"]]);
    expect(t(res[0]?.title)).toBe(
      "Ovanligt låg försäljning i Automat 1 sön 1 nov.: 2 pack, normalt 10,0",
    );
    expect(t(res[0]?.detail)).toBe(
      "Jämfört med söndagar de senaste 8 veckorna (10–10 pack, snitt 10,0): −80 %. Sannolikheten för så få är 0,28 %.",
    );
    expect(res[0]?.oneShot).toBe(true);
    expect(res[0]?.evidence.dates).toHaveLength(9);
    expect(res[0]?.evidence.orderIds).toHaveLength(2);
  });

  it("ovanligt hög dag är info; normal variation larmar inte", () => {
    const orders = [
      ...history,
      ...many(22, { titleId: "t1", machineId: "m2", businessDate: "2026-11-01" }),
      ...many(7, { titleId: "t1", machineId: "m1", businessDate: "2026-11-01" }),
    ];
    const res = dayAnomalyAlerts({ orders, machines, options: { perMachine: true } }, NOW);
    expect(res.map((r) => [r.key, r.severity])).toEqual([["day_anomaly:m2:2026-11-01", "info"]]);
  });

  it("prognos ersätter historiken; för lite historik bedöms inte", () => {
    const orders = many(12, { titleId: "t1", machineId: "m1", businessDate: "2026-11-01" });
    expect(dayAnomalyAlerts({ orders, machines }, NOW)).toEqual([]);
    const res = dayAnomalyAlerts(
      { orders, machines, forecasts: [{ scope: "all", date: "2026-11-01", expectedTenths: 300 }] },
      NOW,
    );
    expect(res).toHaveLength(1);
    expect(t(res[0]?.detail)).toContain("Jämfört med prognosen: −60 %");
  });

  it("automat i drift sedan nyligen jämförs bara med veckor i drift", () => {
    const ms = [machine("m1", "Automat 1", { activeFrom: addDays("2026-11-01", -14) })];
    const orders = [...daily("t1", "m1", "2026-10-18", 14, 10)];
    expect(dayAnomalyAlerts({ orders, machines: ms }, NOW)).toEqual([]); // 2 veckor < 4
  });

  it("vägrar bedöma en dag som inte är slut", () => {
    expect(() => dayAnomalyAlerts({ orders: [], machines, date: "2026-11-02" }, NOW)).toThrow();
  });
});
