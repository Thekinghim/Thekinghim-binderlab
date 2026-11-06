/**
 * Kolumnrubriken för vinsten ska följa samma regel som talen: "Vår del" när butikens andel
 * är dragen (vald butik eller vyknappen), även när tabellen har en enda rad och ingen
 * fotrad. Tidigare stod "Vår vinst" över 6 441 kr (Spelbutiken 50 % av vinsten dragen)
 * på /automater?butik=… eftersom rubriken bara läste fotradens summa.
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/automater",
  useSearchParams: () => new URLSearchParams(),
}));

const { MachineTable } = await import("./machine-table");

const row = {
  id: "m1",
  code: "BL-001",
  name: "Automat 1",
  href: "/automater/bl-001",
  lifecycle: "active",
  status: { status: "ok", label: "I drift", flagged: false },
  storeName: "Spelbutiken",
  revenueOre: 3_537_600,
  profitOre: 644_100,
  marginBp: 1_900,
  orders: 205,
  revenueChange: null,
  revenueShare: 1,
  topTitle: null,
  refillNow: 0,
  refillSoon: 0,
  packsOnHand: 0,
  lastOrderAt: null,
} as unknown as Parameters<typeof MachineTable>[0]["rows"][number];

function html(shareDeducted: boolean): string {
  return renderToString(
    createElement(MachineTable, {
      rows: [row],
      others: [],
      totals: null,
      shareDeducted,
      timeZone: "Europe/Stockholm",
      now: "2026-11-06T10:00:00Z",
      caption: "Automater",
    }),
  );
}

describe("MachineTable: rubriken för vinsten", () => {
  it("vald butik eller knappen, en rad utan fotrad: Vår del", () => {
    const out = html(true);
    expect(out).toContain("Vår del");
    expect(out).not.toContain("Vår vinst");
  });

  it("utan andel: Vår vinst", () => {
    const out = html(false);
    expect(out).toContain("Vår vinst");
    expect(out).not.toContain("Vår del");
  });
});
