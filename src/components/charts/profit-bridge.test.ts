import { describe, expect, it } from "vitest";

import { profitBarRows, profitBridgeModel } from "./profit-bridge";

const format = (v: number) => `${v} kr`;

describe("profitBarRows (liggande brygga på telefon)", () => {
  it("utan avgifter och andel: tre rader, intäkt, inköp och vinst", () => {
    const rows = profitBarRows({ revenue: 1000, purchases: 600, fees: 0, format });
    expect(rows.map((r) => [r.label, r.value, r.kind])).toEqual([
      ["Intäkt", 1000, "revenue"],
      ["Inköp", -600, "cost"],
      ["Vinst", 400, "result"],
    ]);
    expect(rows.map((r) => r.share)).toEqual([1, 0.6, 0.4]);
  });

  it("samma steg och samma vinst som vattenfallet, med butikernas andel och egna etiketter", () => {
    const props = {
      revenue: 1000,
      purchases: 500,
      fees: 15,
      storeCompensation: 200,
      labels: { profit: "Vår del", storeCompensation: "Till butikerna" },
      format,
    };
    const rows = profitBarRows(props);
    expect(rows.map((r) => r.label)).toEqual(profitBridgeModel(props).steps.map((s) => s.label));
    expect(rows.at(-1)).toMatchObject({ label: "Vår del", value: 285, kind: "result" });
    expect(rows.slice(0, -1).reduce((sum, r) => sum + r.value, 0)).toBe(285);
  });

  it("förlust: sista raden heter Förlust, och staplarna håller sig inom 0–1", () => {
    const rows = profitBarRows({ revenue: 100, purchases: 180, fees: 0, format });
    expect(rows.at(-1)).toMatchObject({ label: "Förlust", value: -80, kind: "loss" });
    for (const r of rows) {
      expect(r.share).toBeGreaterThan(0);
      expect(r.share).toBeLessThanOrEqual(1);
    }
    // Inköpen är störst: de sätter skalan.
    expect(rows[1]!.share).toBe(1);
  });

  it("utan intäkt ritas inga staplar", () => {
    expect(
      profitBarRows({ revenue: 0, purchases: 0, fees: 0, format }).map((r) => r.share),
    ).toEqual([0, 0, 0]);
  });
});
