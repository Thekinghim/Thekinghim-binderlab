/**
 * Dagliga kontrollen och mystery packs: ingen falsk larm när pushen med flit inte fyller ett
 * mystery-fack som inte är tomt, men en varning om facket fylldes på för tidigt, har mer än en
 * omgång eller fick något annat än en hel omgång.
 */
import { describe, expect, it } from "vitest";

import { awishStockCheck, refillPushCheck, type RefillRow } from "./index";

const NOW = new Date("2026-11-07T04:37:00Z");
const READ = new Date(NOW.getTime() - 5 * 60_000).toISOString();

const title = (
  p: Partial<Parameters<typeof awishStockCheck>[0]["machines"][number]["titles"][number]> = {},
) => ({
  titleId: "mp",
  titleName: "Mystery Pack Plus",
  awishUnits: 3,
  appUnits: 17,
  changedSince: 0,
  countedSince: false,
  mysteryBatchSize: 14,
  ...p,
});

const machine = (t = title()) => ({ machineId: "m1", label: "BL-001", readAt: READ, titles: [t] });

const refill = (p: Partial<RefillRow> = {}): RefillRow => ({
  eventId: "e1",
  machineId: "m1",
  machineLabel: "BL-001",
  titleName: "Mystery Pack Plus",
  quantity: 14,
  at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
  pushEnabled: true,
  undone: false,
  mysteryBatchSize: 14,
  before: 3,
  ...p,
});

describe("Awish = appen: mystery packs", () => {
  it("appen har fler pack än Awish efter en påfyllning före 0: varning, inget fel", () => {
    const r = awishStockCheck({ machines: [machine()], now: NOW });
    expect(r.status).toBe("warn");
    expect(r.findings[0]?.text).toContain("fylldes på innan det var tomt");
    // En vanlig titel med samma skillnad är ett fel.
    expect(
      awishStockCheck({ machines: [machine(title({ mysteryBatchSize: null }))], now: NOW }).status,
    ).toBe("fail");
  });

  it("färre pack i appen än i Awish är fortfarande ett fel", () => {
    expect(awishStockCheck({ machines: [machine(title({ appUnits: 1 }))], now: NOW }).status).toBe(
      "fail",
    );
  });

  it("mer än en omgång i facket: varning", () => {
    const r = awishStockCheck({
      machines: [machine(title({ awishUnits: 20, appUnits: 20 }))],
      now: NOW,
    });
    expect(r.status).toBe("warn");
    expect(r.findings[0]?.text).toContain("mer än en omgång (14)");
  });

  it("en omgång och samma antal: godkänd", () => {
    const r = awishStockCheck({
      machines: [machine(title({ awishUnits: 14, appUnits: 14 }))],
      now: NOW,
    });
    expect(r.status).toBe("pass");
  });
});

describe("Påfyllningar nådde Awish: mystery packs", () => {
  const run = (rows: RefillRow[]) =>
    refillPushCheck({ refills: rows, pushes: [], now: NOW, pushConfigured: true });

  it("påfylld före 0 och inte skickad: varning, inget larm", () => {
    const r = run([refill()]);
    expect(r.status).toBe("warn");
    expect(r.findings[0]?.text).toContain("Mystery-facket fylls bara på när det är tomt");
    expect(run([refill({ mysteryBatchSize: null })]).status).toBe("fail");
  });

  it("tomt fack, en hel omgång, skickad: godkänd", () => {
    const r = refillPushCheck({
      refills: [refill({ before: 0 })],
      pushes: [{ machineId: "m1", at: NOW.toISOString() }],
      now: NOW,
      pushConfigured: true,
    });
    expect(r.status).toBe("pass");
  });

  it("tomt fack men inte en hel omgång: varning", () => {
    const r = refillPushCheck({
      refills: [refill({ before: 0, quantity: 10 })],
      pushes: [{ machineId: "m1", at: NOW.toISOString() }],
      now: NOW,
      pushConfigured: true,
    });
    expect(r.status).toBe("warn");
    expect(r.findings[0]?.text).toBe(
      "BL-001 Mystery Pack Plus: fylldes på med 10 pack, en omgång är 14.",
    );
  });

  it("tomt fack som inte nådde Awish är fortfarande ett fel", () => {
    expect(run([refill({ before: 0 })]).status).toBe("fail");
  });
});
