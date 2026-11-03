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
vi.mock("../actions", () => ({ addPurchasePrice: vi.fn(), correctPurchasePrice: vi.fn() }));

const { PriceForm } = await import("./price-form");

function serverHtml(): string {
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
    expect(html).toContain("Nytt inköpspris från idag");
    expect(html).toContain("Äldre försäljning behåller sitt pris");
    expect(html).toContain("Annat datum…");
    expect(html).not.toMatch(/name="validFrom"/);
  });
});
