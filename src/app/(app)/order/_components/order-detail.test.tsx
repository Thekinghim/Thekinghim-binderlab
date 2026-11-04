/**
 * Ordern-dialogen: "Markera som testköp" tar bort en riktig försäljning ur alla siffror,
 * så knappen står inte överst och kräver ett andra tryck ("Säker? …").
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CONFIRM_TEXT, MARK_LABEL, pressTestPurchase, UNDO_LABEL } from "../_lib/test-purchase";
import type { OrderDetail } from "../_lib/types";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: unknown; href: string }) =>
    createElement("a", { href }, children as never),
}));

const { OrderDetailView } = await import("./order-detail");

const detail: OrderDetail = {
  id: "o1",
  externalId: "29113",
  orderedAt: "2026-11-03T12:00:00.000Z",
  businessDate: "2026-11-03",
  amountOre: 17_000,
  paymentMethod: "card",
  rawTitle: "Mystery Pack",
  title: { id: "t1", name: "Mystery Pack", series: null },
  machine: { id: "m1", code: "BL-001", name: "BL-001" },
  store: { id: "s1", name: "Sega gubben" },
  sourceMachine: null,
  dataSource: { id: "d1", name: "Awish API", provider: "awish_grpc" },
  import: null,
  lateInClosedPeriod: false,
  createdAt: "2026-11-03T12:01:00.000Z",
  testPurchase: null,
};

const html = (d: OrderDetail) =>
  renderToString(
    createElement(OrderDetailView, {
      detail: d,
      timeZone: "Europe/Stockholm",
      canOpenImport: false,
      testPurchase: { saving: false, error: null, onChange: () => {} },
    }),
  );

describe("Ordern-dialogen: testköp", () => {
  it("knappen står efter orderns uppgifter, inte överst", () => {
    const out = html(detail);
    expect(out.indexOf(MARK_LABEL)).toBeGreaterThan(out.indexOf("Ordernummer"));
    expect(out.indexOf(MARK_LABEL)).toBeGreaterThan(out.indexOf("Datakälla"));
    // Ingen bekräftelse förrän man tryckt.
    expect(out).not.toContain(CONFIRM_TEXT);
  });

  it("att markera kräver två tryck; att ångra gör det direkt", () => {
    expect(pressTestPurchase("idle", false)).toEqual({ step: "confirm", commit: false });
    expect(pressTestPurchase("confirm", false)).toEqual({ step: "idle", commit: true });
    expect(pressTestPurchase("idle", true)).toEqual({ step: "idle", commit: true });
    expect(CONFIRM_TEXT).toBe("Säker? Ordern räknas inte i vinsten.");
  });

  it("ett testköp visar etiketten överst och Ångra längst ner", () => {
    const out = html({ ...detail, testPurchase: { at: "2026-11-03T13:00:00.000Z", by: "Kim" } });
    expect(out.indexOf("Räknas inte i försäljningen")).toBeLessThan(out.indexOf("Ordernummer"));
    expect(out.indexOf(UNDO_LABEL)).toBeGreaterThan(out.indexOf("Ordernummer"));
  });
});
