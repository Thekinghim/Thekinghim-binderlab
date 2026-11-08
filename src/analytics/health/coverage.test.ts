/**
 * Försäljningens täckning: tystnaden räknas bara fram till dit försäljningen är importerad.
 * Awish CSV laddas upp en gång per dag; fram till nästa fil är försäljningen okänd, inte noll.
 */
import { describe, expect, it } from "vitest";

import { machineHealth } from "./index";
import { halfHourly, localIso, localMs, machineRef, scheduleOrders } from "./test-helpers";

const OPEN = halfHourly(10, 20);
const machines = [machineRef("m1", "Automat 1"), machineRef("m2", "Automat 2")];
const txt = (s: string | undefined) => (s ?? "").replace(/ /g, " ");

function orders(until: number, stopM2?: number) {
  return [
    ...scheduleOrders("m1", "2026-09-01", 70, OPEN, { until }),
    ...scheduleOrders("m2", "2026-09-01", 70, OPEN, { until: stopM2 ?? until }),
  ];
}

describe("machineHealth: försäljning som inte importerats än", () => {
  // Filen laddades upp måndag kväll (försäljning t.o.m. mån 19:45). Nu tisdag 14:00.
  const lastFile = localMs("2026-11-02", "20:00");
  const now = localIso("2026-11-03", "14:00");

  it("utan täckning larmar båda automaterna (tystnaden räknas till nu)", () => {
    const h = machineHealth({ orders: orders(lastFile), machines }, now);
    expect(h.map((x) => x.status)).toEqual(["suspected_fault", "suspected_fault"]);
  });

  it("med täckning t.o.m. senaste filen är båda i drift, och texten säger varför", () => {
    const until = localIso("2026-11-02", "19:45");
    const h = machineHealth(
      {
        orders: orders(lastFile),
        machines,
        salesCoverage: [
          { machineId: "m1", until, sourceName: "Awish CSV" },
          { machineId: "m2", until, sourceName: "Awish CSV" },
        ],
      },
      now,
    );
    expect(h.map((x) => x.status)).toEqual(["ok", "ok"]);
    expect(h[0]?.dataUntil).toBe(new Date(until).toISOString());
    expect(txt(h[0]?.detail)).toContain("Vi har försäljningen från Awish CSV fram till");
    expect(h[0]?.silence?.to).toBe(new Date(until).toISOString());
  });

  it("en automat som tystnat medan den andra sålde i samma fil larmar fortfarande", () => {
    const until = localIso("2026-11-02", "19:45");
    const h = machineHealth(
      {
        orders: orders(lastFile, localMs("2026-11-02", "11:00")),
        machines,
        salesCoverage: [
          { machineId: "m1", until },
          { machineId: "m2", until },
        ],
      },
      now,
    );
    const m2 = h.find((x) => x.machineId === "m2");
    expect(m2?.status).toBe("suspected_fault");
    expect(m2?.silence?.to).toBe(new Date(until).toISOString());
    expect(h.find((x) => x.machineId === "m1")?.status).toBe("ok");
  });

  it("täckning efter nu ändrar ingenting", () => {
    const later = localIso("2026-11-04", "00:00");
    const a = machineHealth({ orders: orders(lastFile), machines }, now);
    const b = machineHealth(
      { orders: orders(lastFile), machines, salesCoverage: [{ machineId: "m1", until: later }] },
      now,
    );
    expect(b[0]?.status).toBe(a[0]?.status);
    expect(b[0]?.dataUntil ?? null).toBeNull();
  });
});

describe("machineHealth: order utan matchad titel", () => {
  it("en senare order utan försäljningshändelse avslutar tystnaden", () => {
    const o = scheduleOrders("m1", "2026-09-01", 70, OPEN, {
      until: localMs("2026-11-03", "11:00"),
    });
    const now = localIso("2026-11-03", "16:00");
    const [silent] = machineHealth({ orders: o, machines: [machineRef("m1", "Automat 1")] }, now);
    expect(silent?.status).toBe("suspected_fault");
    const [h] = machineHealth(
      {
        orders: o,
        machines: [machineRef("m1", "Automat 1")],
        salesCoverage: [{ machineId: "m1", lastSaleAt: localIso("2026-11-03", "15:50") }],
      },
      now,
    );
    expect(h?.status).toBe("ok");
    expect(txt(h?.detail)).toContain("titeln är inte matchad");
  });
});
