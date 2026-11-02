import { describe, expect, it } from "vitest";
import {
  analyzeSilence,
  buildHourCalendar,
  historyStartMs,
  machineHealth,
  vendorState,
  type HealthInput,
  type MachineSignal,
} from "./index";
import {
  halfHourly,
  localIso,
  localMs,
  machineRef,
  scheduleOrders,
  timedOrder,
} from "./test-helpers";

const TZ = "Europe/Stockholm";
const HISTORY_START = "2026-09-01";
const OPEN = halfHourly(10, 20); // 20 order per dag, 2 per timme 10–20

/** Automat som säljer 2 pack i timmen 10–20 varje dag, fram till `until`. */
function sellingUntil(machineId: string, until: number, opts: { skipWeekdays?: number[] } = {}) {
  return scheduleOrders(machineId, HISTORY_START, 70, OPEN, { ...opts, until });
}

/** Hårda mellanslag → vanliga, så att texterna kan jämföras läsbart. */
const txt = (s: string | undefined) => (s ?? "").replace(/\u00a0/g, " ");

function health(input: Partial<HealthInput> & Pick<HealthInput, "orders">, now: string) {
  return machineHealth({ machines: [machineRef("m1", "Automat 1")], ...input }, now);
}

function signal(p: Partial<MachineSignal> & Pick<MachineSignal, "kind" | "at">): MachineSignal {
  return { id: `s-${p.kind}-${p.at}`, machineId: "m1", source: "awish_grpc", ...p };
}

// Måndag 2 nov. 2026, svensk vintertid (UTC+1).
const MON_1830 = localIso("2026-11-02", "18:30");

describe("machineHealth: misstänkt fel ur tystnad", () => {
  it("larmar när automaten är tyst mitt på dagen då den normalt säljer", () => {
    const orders = sellingUntil("m1", localMs("2026-11-02", "13:50"));
    const [h] = health({ orders }, MON_1830);
    expect(h?.status).toBe("suspected_fault");
    expect(h?.source).toBe("sales");
    expect(h?.label).toBe("Misstänkt fel");
    // 13:45–18:30: 0,25 h + 4 h + 0,5 h à 2 pack = 9,5 pack.
    expect(h?.silence?.expectedMilli).toBe(9_500);
    expect(h?.silence?.zeroProbabilityBp).toBe(1); // e^−9,5 ≈ 0,0075 %
    expect(h?.silence?.anomalous).toBe(true);
    expect(h?.since).toBe(localIso("2026-11-02", "13:45"));
    expect(h?.title).toBe("Automat 1: misstänkt fel");
    expect(txt(h?.detail)).toContain("Ingen försäljning sedan mån 2 nov. 13:45 (4 timmar)");
    expect(txt(h?.detail)).toContain("brukar ge 9,5 pack");
    expect(txt(h?.detail)).toContain("0,01 %");
    expect(h?.evidence.machineIds).toEqual(["m1"]);
    expect(h?.evidence.orderIds.length).toBeGreaterThan(0);
    expect(h?.evidence.figures.find((f) => f.key === "expectedTenths")?.value).toBe(95);
  });

  it("larmar inte på natten när automaten aldrig säljer då", () => {
    // Senaste försäljning måndag 19:45, nu tisdag 07:30: bara 15 min av öppettiden har passerat.
    const orders = sellingUntil("m1", localMs("2026-11-02", "20:00"));
    const [h] = health({ orders }, localIso("2026-11-03", "07:30"));
    expect(h?.status).toBe("ok");
    expect(h?.silence?.expectedMilli).toBe(500);
    expect(h?.silence?.zeroProbabilityBp).toBe(6_065);
    expect(h?.silence?.anomalous).toBe(false);
  });

  it("larmar inte en stängd söndag", () => {
    const orders = sellingUntil("m1", localMs("2026-11-01", "00:00"), { skipWeekdays: [7] });
    const [h] = health({ orders }, localIso("2026-11-01", "16:00"));
    expect(h?.status).toBe("ok");
    expect(h?.silence?.expectedMilli).toBe(500); // bara lördag 19:45–20:00
  });

  it("larmar inte vid kort tystnad (under minSilenceMinutes)", () => {
    const orders = sellingUntil("m1", localMs("2026-11-02", "17:50"));
    const [h] = health({ orders }, MON_1830);
    expect(h?.silence?.minutes).toBe(45);
    expect(h?.status).toBe("ok");
  });

  it("larmar inte när noll försäljning är rimligt (sannolikhet över gränsen)", () => {
    // 16:45–18:30 = 1,75 h → 3,5 pack, e^−3,5 ≈ 3 % > 1 %.
    const orders = sellingUntil("m1", localMs("2026-11-02", "16:50"));
    const [h] = health({ orders }, MON_1830);
    expect(h?.silence?.zeroProbabilityBp).toBe(302);
    expect(h?.status).toBe("ok");
    expect(txt(h?.detail)).toContain("sannolikheten för noll är 3,02 %");
  });

  it("gränsen kan ändras: 5 % larmar vid samma tystnad", () => {
    const orders = sellingUntil("m1", localMs("2026-11-02", "16:50"));
    const [h] = health({ orders, options: { alarmProbabilityBp: 500 } }, MON_1830);
    expect(h?.status).toBe("suspected_fault");
  });

  it("räknar lång tystnad utan maskindata som offline (härlett)", () => {
    const orders = sellingUntil("m1", localMs("2026-10-31", "20:00"));
    const [h] = health({ orders }, MON_1830);
    expect(h?.status).toBe("offline");
    expect(h?.source).toBe("sales");
    expect(h?.title).toBe("Automat 1 är troligen ur drift");
    expect(txt(h?.detail)).toContain("Maskindata saknas");
  });

  it("räknar lång tystnad som misstänkt fel när leverantören säger online", () => {
    const orders = sellingUntil("m1", localMs("2026-10-31", "20:00"));
    const signals = [signal({ kind: "online", at: localIso("2026-10-30", "08:00") })];
    const [h] = health({ orders, signals }, MON_1830);
    expect(h?.status).toBe("suspected_fault");
  });

  it("kräver tillräcklig historik", () => {
    const orders = scheduleOrders("m1", "2026-11-01", 1, ["12:00", "13:00", "14:00"]);
    const [h] = health({ orders }, MON_1830);
    expect(h?.status).toBe("unknown");
    expect(txt(h?.detail)).toContain("2 order de senaste 8 veckorna; minst 20 behövs");
  });

  it("räknar tystnaden från driftstart för en automat som aldrig sålt", () => {
    const machines = [machineRef("m1", "Automat 1", { activeFrom: "2026-11-02" })];
    const [h] = machineHealth({ machines, orders: [] }, MON_1830);
    expect(h?.status).toBe("unknown");
    expect(h?.silence?.from).toBe(localIso("2026-11-02", "00:00"));
  });

  it("räknar order med bara affärsdatum som försäljning sent den dagen", () => {
    const orders = [
      ...sellingUntil("m1", localMs("2026-11-01", "00:00")),
      { ...timedOrder("m1", "2026-11-02", "12:00"), orderedAt: undefined },
    ];
    const [h] = health({ orders }, MON_1830);
    expect(h?.silence?.minutes).toBe(0);
    expect(h?.status).toBe("ok");
  });

  it("automat som varit tyst i flera år ger 'unknown' utan att kalendern spricker", () => {
    const orders = scheduleOrders("m1", "2023-01-02", 30, ["12:00", "13:00"]);
    const [h] = health({ orders }, MON_1830);
    expect(h?.status).toBe("unknown");
    expect(h?.silence?.minutes).toBeGreaterThan(3 * 365 * 24 * 60 - 100 * 24 * 60);
  });

  it("ignorerar order efter `now`", () => {
    const orders = [
      ...sellingUntil("m1", localMs("2026-11-02", "13:50")),
      timedOrder("m1", "2026-11-02", "19:00"),
    ];
    const [h] = health({ orders }, MON_1830);
    expect(h?.status).toBe("suspected_fault");
  });
});

describe("machineHealth: leverantörens maskindata", () => {
  const orders = () => sellingUntil("m1", localMs("2026-11-02", "18:20"));

  it("offline från leverantören vinner", () => {
    const signals = [signal({ kind: "offline", at: localIso("2026-11-02", "15:00") })];
    const [h] = health({ orders: orders(), signals }, MON_1830);
    expect(h?.status).toBe("offline");
    expect(h?.source).toBe("vendor");
    expect(h?.since).toBe(localIso("2026-11-02", "15:00"));
    expect(txt(h?.detail)).toContain(
      "Leverantören rapporterade offline mån 2 nov. 15:00 (för 3 timmar sedan)",
    );
  });

  it("online efter offline är i drift", () => {
    const signals = [
      signal({ kind: "offline", at: localIso("2026-11-02", "15:00") }),
      signal({ kind: "online", at: localIso("2026-11-02", "15:20") }),
    ];
    const [h] = health({ orders: orders(), signals }, MON_1830);
    expect(h?.status).toBe("ok");
  });

  it("fel som inte åtgärdats ger 'fault' med leverantörens text", () => {
    const signals = [
      signal({
        kind: "fault",
        at: localIso("2026-11-02", "16:00"),
        code: "E21",
        message: "Spiral 4 fastnar",
      }),
    ];
    const [h] = health({ orders: orders(), signals }, MON_1830);
    expect(h?.status).toBe("fault");
    expect(h?.title).toBe("Automat 1 har fel: Spiral 4 fastnar");
    expect(txt(h?.detail)).toContain("(kod E21)");
    expect(h?.signal?.code).toBe("E21");
  });

  it("åtgärdat fel ger inte 'fault'", () => {
    const signals = [
      signal({ kind: "fault", at: localIso("2026-11-02", "16:00") }),
      signal({ kind: "fault_cleared", at: localIso("2026-11-02", "16:30") }),
    ];
    const [h] = health({ orders: orders(), signals }, MON_1830);
    expect(h?.status).toBe("ok");
  });

  it("heartbeat som uteblir ger offline när gränsen används", () => {
    const signals = [signal({ kind: "heartbeat", at: localIso("2026-11-02", "17:00") })];
    const [h] = health(
      { orders: orders(), signals, options: { heartbeatTimeoutMinutes: 30 } },
      MON_1830,
    );
    expect(h?.status).toBe("offline");
    expect(h?.since).toBe(localIso("2026-11-02", "17:30"));
    const [h2] = health({ orders: orders(), signals }, MON_1830);
    expect(h2?.status).toBe("ok");
  });

  it("händelser efter `now` ignoreras", () => {
    const signals = [signal({ kind: "offline", at: localIso("2026-11-02", "19:00") })];
    const [h] = health({ orders: orders(), signals }, MON_1830);
    expect(h?.status).toBe("ok");
  });

  it("känd offline-tid räknas inte in i det normala mönstret", () => {
    // Två veckor offline utan försäljning i historiken: utan rensning skulle förväntat sjunka.
    const offFrom = localMs("2026-10-05", "00:00");
    const offTo = localMs("2026-10-19", "00:00");
    const all = sellingUntil("m1", localMs("2026-11-02", "13:50")).filter((o) => {
      const ms = Date.parse(o.orderedAt as string);
      return ms < offFrom || ms >= offTo;
    });
    const signals = [
      signal({ kind: "offline", at: new Date(offFrom).toISOString() }),
      signal({ kind: "online", at: new Date(offTo).toISOString() }),
    ];
    const [withSignals] = health({ orders: all, signals }, MON_1830);
    expect(withSignals?.silence?.expectedMilli).toBe(9_500);
    const [without] = health({ orders: all }, MON_1830);
    expect(without?.silence?.expectedMilli).toBe(7_125); // 9,5 × 6/8
  });
});

describe("machineHealth: lager och drift", () => {
  it("tom automat är 'empty', inte fel", () => {
    const orders = sellingUntil("m1", localMs("2026-11-02", "13:50"));
    const stock = [{ machineId: "m1", titleId: "t1", onHand: 0 }];
    const [h] = health({ orders, stock }, MON_1830);
    expect(h?.status).toBe("empty");
    expect(h?.title).toBe("Automat 1 är tom");
  });

  it("automat utanför drift är 'inactive'", () => {
    const machines = [machineRef("m1", "Automat 1", { activeTo: "2026-10-31" })];
    const [h] = machineHealth({ machines, orders: [] }, MON_1830);
    expect(h?.status).toBe("inactive");
    expect(txt(h?.detail)).toBe("Ur drift sedan 1 nov.");
  });

  it("sorterar med allvarligast först", () => {
    const machines = [
      machineRef("a", "A"),
      machineRef("b", "B"),
      machineRef("c", "C", { archived: true }),
    ];
    const orders = [
      ...sellingUntil("a", localMs("2026-11-02", "18:20")),
      ...sellingUntil("b", localMs("2026-11-02", "13:50")),
    ];
    const res = machineHealth({ machines, orders }, MON_1830);
    expect(res.map((r) => [r.machineId, r.status])).toEqual([
      ["b", "suspected_fault"],
      ["a", "ok"],
      ["c", "inactive"],
    ]);
  });

  it("kastar för ogiltiga inställningar", () => {
    expect(() => health({ orders: [], options: { historyWeeks: 0 } }, MON_1830)).toThrow();
    expect(() =>
      health({ orders: [], options: { alarmProbabilityBp: 20_000 } }, MON_1830),
    ).toThrow();
    expect(() => health({ orders: [] }, "2026-11-02T18:30")).toThrow(); // tid utan zon
  });
});

describe("vendorState", () => {
  it("bygger offline-intervall och senaste fel", () => {
    const now = localMs("2026-11-02", "18:00");
    const s = vendorState(
      [
        signal({ kind: "offline", at: localIso("2026-11-02", "10:00") }),
        signal({ kind: "heartbeat", at: localIso("2026-11-02", "11:00") }),
        signal({ kind: "offline", at: localIso("2026-11-02", "17:00") }),
        signal({ kind: "fault", at: localIso("2026-11-02", "12:00") }),
      ],
      now,
    );
    expect(s.offlineIntervals).toEqual([
      [localMs("2026-11-02", "10:00"), localMs("2026-11-02", "11:00")],
      [localMs("2026-11-02", "17:00"), now],
    ]);
    expect(s.offline?.sinceMs).toBe(localMs("2026-11-02", "17:00"));
    expect(s.fault?.signal.kind).toBe("fault");
    expect(s.hasConnectivity).toBe(true);
  });

  it("utan händelser: inget känt", () => {
    const s = vendorState([], 0);
    expect(s).toEqual({ hasConnectivity: false, offline: null, fault: null, offlineIntervals: [] });
  });
});

describe("analyzeSilence", () => {
  it("delar av timmar räknas med sin andel", () => {
    const from = localMs("2026-11-02", "14:30");
    const to = localMs("2026-11-02", "15:00");
    const cal = buildHourCalendar(historyStartMs(from, 8, TZ), to, TZ);
    const sales = scheduleOrders("m1", HISTORY_START, 62, ["14:10", "14:20"]).map((o) => ({
      id: o.id,
      ms: Date.parse(o.orderedAt as string),
    }));
    const s = analyzeSilence({
      calendar: cal,
      sales,
      fromMs: from,
      nowMs: to,
      historyWeeks: 8,
      include: () => true,
      alarmProbabilityBp: 100,
      minHistoryOrders: 0,
      minSilenceMinutes: 0,
    });
    expect(s.expectedMilli).toBe(1_000); // halva timmen × 2 pack
    expect(s.topSlots).toEqual([
      { weekday: 1, hour: 14, expectedMilli: 1_000, historyOrders: 16, historyHours: 8 },
    ]);
    expect(s.orderIds).toHaveLength(16);
    expect(s.dates).toEqual(["2026-11-02"]);
  });
});
