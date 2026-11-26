/**
 * "Rätta priset" får inte gå att trycka på innan sidans skript har laddats. Då skickade
 * webbläsaren formuläret som en vanlig sidladdning (GET utan server action): sidan laddades
 * om, priset försvann och inget fel visades. Serverns HTML ska därför ha knappen avstängd;
 * den slås på när formuläret hydrerats.
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("../actions", () => ({
  addPurchasePrice: vi.fn(),
  correctPurchasePrice: vi.fn(),
  previewPriceSplit: vi.fn(),
  setCustomerPrice: vi.fn(),
}));

const { PriceForm } = await import("./price-form");

function serverHtml(extra: { currentCostOre?: number | null } = {}): string {
  return renderToString(
    createElement(
      ToastProvider,
      null,
      createElement(PriceForm, {
        titleId: "t-1",
        titleName: "Perfect Order",
        prices: [{ unitCostOre: 1250, validFrom: "2026-10-01" }],
        orderDays: [{ date: "2026-10-15", orders: 3 }],
        closedMonths: [],
        today: "2026-11-03",
        ...extra,
      }),
    ),
  );
}

describe("PriceForm före hydrering", () => {
  it("renderar Rätta priset avstängd, så att ett tidigt klick inte laddar om sidan", () => {
    const html = serverHtml();
    const button = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toMatch(/\sdisabled=""/);
  });

  it("har prisfältet som redigeraren sätter markören i", () => {
    expect(serverHtml()).toMatch(/<input[^>]*name="unitCost"/);
  });

  it("har två tydliga val, och inget datumfält förrän Annat datum… öppnas", () => {
    const html = serverHtml();
    expect(html).toContain("Rätta priset");
    expect(html).toContain("Gäller all försäljning");
    expect(html).toContain("Nytt inköpspris från i dag");
    expect(html).toContain("Äldre försäljning behåller sitt pris");
    expect(html).toContain("Annat datum…");
    expect(html).not.toMatch(/name="validFrom"/);
  });
});

describe("PriceForm: Retur rättar aldrig historiken", () => {
  /** Knappen som formuläret skickas med (Retur) och dess text. */
  const submitButton = (html: string) =>
    html.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

  it("titel med pris: 'Nytt inköpspris från i dag' är framhävd och först, Rätta priset är ett eget tryck", () => {
    const html = serverHtml({ currentCostOre: 1250 });
    const submit = submitButton(html);
    expect(submit).toContain("Nytt inköpspris från i dag");
    expect(submit).not.toContain("Rätta priset");
    expect(html.indexOf("Nytt inköpspris från i dag")).toBeLessThan(html.indexOf("Rätta priset"));
    expect(html.match(/type="submit"/g)).toHaveLength(1);
  });

  it("titel utan pris: att lägga in priset för all försäljning är valet (ingen historik skrivs om)", () => {
    expect(submitButton(serverHtml({ currentCostOre: null }))).toContain("Rätta priset");
  });
});
