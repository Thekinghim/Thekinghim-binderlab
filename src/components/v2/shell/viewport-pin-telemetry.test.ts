import { describe, expect, it } from "vitest";

import { clampClientError } from "@/lib/client-error";

import {
  REPORT_EVERY_MS,
  reportDue,
  RING_SIZE,
  snapshotRow,
  SnapshotRing,
  VP_COLS,
  VP_MAX_JSON,
  vpReport,
  type VpSnapshot,
} from "./viewport-pin-telemetry";

const snap: VpSnapshot = {
  ev: "visible",
  inner: 793,
  vvH: 793.4,
  vvTop: 0,
  fixedBottom: 793,
  healthy: 852,
  shift: 0,
  gap: 59,
  scrollY: 120.6,
  msResume: 3400.2,
  drawerOpen: false,
};

describe("ViewportPins fältdata", () => {
  it("en rad är bara tal och ett kort händelsenamn", () => {
    expect(snapshotRow(snap)).toBe("visible,793,793,0,793,852,0,59,121,3400,0");
    expect(snapshotRow({ ...snap, ev: "<b>x</b>!", drawerOpen: true, inner: NaN })).toBe(
      "bxb,-1,793,0,793,852,0,59,121,3400,1",
    );
    expect(VP_COLS.split(",")).toHaveLength(snapshotRow(snap).split(",").length);
  });

  it("ringen håller de senaste, och en scroll med samma mått ersätter förra raden", () => {
    const ring = new SnapshotRing();
    ring.push(snap);
    ring.push({ ...snap, scrollY: 300 });
    expect(ring.rows()).toHaveLength(1);
    for (let i = 0; i < 30; i++) ring.push({ ...snap, ev: `e${i}`, inner: 700 + i });
    expect(ring.rows()).toHaveLength(RING_SIZE);
    expect(ring.rows().at(-1)).toMatch(/^e29,729,/);
  });

  it("rapporten ryms i databasens gräns och klarar serverns kontroll", () => {
    const ring = new SnapshotRing();
    for (let i = 0; i < 30; i++) {
      ring.push({ ...snap, ev: "vvresize", inner: 10_000 + i, msResume: 9_999_999 });
    }
    const vp = vpReport(ring.rows(), 852);
    expect(JSON.stringify(vp).length).toBeLessThanOrEqual(VP_MAX_JSON);
    expect(vp.rows.length).toBeGreaterThan(5);
    const saved = clampClientError({
      message: "ViewportPin: shift",
      stack: vp.rows.join("\n"),
      extra: { source: "viewport", standalone: true, vp },
    });
    expect(saved?.extra).toEqual({ source: "viewport", standalone: true, vp });
  });

  it("högst en rapport per tio minuter", () => {
    expect(reportDue(null, 1000)).toBe(true);
    expect(reportDue(1000, 1000 + REPORT_EVERY_MS - 1)).toBe(false);
    expect(reportDue(1000, 1000 + REPORT_EVERY_MS)).toBe(true);
    expect(reportDue(NaN, 1000)).toBe(true);
    // Klockan har ställts bakåt: skicka hellre än att tiga för alltid.
    expect(reportDue(5000, 1000)).toBe(true);
  });
});
