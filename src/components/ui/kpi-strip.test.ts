import { describe, expect, it } from "vitest";

import { kpiStripLayout } from "./kpi-strip";

describe("kpiStripLayout", () => {
  it("Hem: fem nyckeltal med vinsten som andra cell", () => {
    const l = kpiStripLayout([{}, { primary: true }, {}, {}, {}]);
    expect(l.total).toBe(6);
    expect(l.sm).toBe(4);
    // Mellanläget: vinsten först på egen rad, sedan fyra i en rad. Ingen ofull rad.
    expect(l.cells.map((c) => c.smSpan)).toEqual([1, 4, 1, 1, 1]);
    expect(l.cells.map((c) => c.smStart)).toEqual([true, true, false, false, false]);
    // 2-kolumnsläget: udda antal, sista cellen fyller raden.
    expect(l.cells.map((c) => c.baseSpan)).toEqual([1, 1, 1, 1, 2]);
    expect(l.cells.map((c) => c.baseStart)).toEqual([true, false, true, false, true]);
    // En rad: bara första cellen saknar vänsterluft.
    expect(l.cells.map((c) => c.lgStart)).toEqual([true, false, false, false, false]);
  });

  it("fem övriga i fyra kolumner: sista cellen fyller den ofulla raden", () => {
    const l = kpiStripLayout([{ primary: true }, {}, {}, {}, {}, {}]);
    expect(l.sm).toBe(4);
    expect(l.cells.map((c) => c.smSpan)).toEqual([4, 1, 1, 1, 1, 4]);
    expect(l.cells.map((c) => c.smStart)).toEqual([true, true, false, false, false, true]);
  });

  it("utan huvudperson: två kolumner i mellanläget, sista fyller raden vid udda antal", () => {
    const l = kpiStripLayout([{}, {}, {}]);
    expect(l.sm).toBe(2);
    expect(l.total).toBe(3);
    expect(l.cells.map((c) => c.smSpan)).toEqual([1, 1, 2]);
    expect(l.cells.map((c) => c.smStart)).toEqual([true, false, true]);
  });

  it("Lönsamhet: vinsten först och fyra övriga", () => {
    const l = kpiStripLayout([{ primary: true }, {}, {}, {}, {}]);
    expect(l.cells.map((c) => c.smSpan)).toEqual([4, 1, 1, 1, 1]);
    expect(l.cells.map((c) => c.baseSpan)).toEqual([1, 1, 1, 1, 2]);
  });
});
