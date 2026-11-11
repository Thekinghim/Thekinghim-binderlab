/**
 * Inventeringen före hydrering (serverns HTML): lagerväljaren med "Senast inventerat", och
 * räkneskärmen för lagret i länken (?lager=) med "Appen tror", på svenska och engelska.
 * Utkastet läses ur telefonens lagring först i webbläsaren (e2e/14 testar det).
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import { LocaleProvider } from "@/i18n/client";
import type { Locale } from "@/i18n";

import type { CountPlace, CountRow } from "../_lib/model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("../actions", () => ({ saveStockCount: vi.fn() }));

const { CountFlow } = await import("./count-flow");

const HEMMA = "11111111-1111-4111-8111-111111111111";
const KONTORET = "22222222-2222-4222-8222-222222222222";
const places: CountPlace[] = [
  { id: HEMMA, name: "Hemma", lastCountedAt: "2026-10-01T10:00:00Z", daysSince: 40, overdue: true },
  { id: KONTORET, name: "Kontoret", lastCountedAt: null, daysSince: null, overdue: false },
];
const rows: CountRow[] = [
  {
    titleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Paldea",
    byPlace: { [HEMMA]: 162, [KONTORET]: 0 },
  },
  {
    titleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Surging Sparks",
    byPlace: { [HEMMA]: 1234 },
  },
];

function html(locale: Locale, initialPlaceId: string | null): string {
  return renderToString(
    <LocaleProvider locale={locale}>
      <ToastProvider locale={locale}>
        <CountFlow
          places={places}
          rows={rows}
          scope="org:user"
          initialPlaceId={initialPlaceId}
          stockHref="/vart-lager"
        />
      </ToastProvider>
    </LocaleProvider>,
  )
    .replace(/<!-- -->/g, "")
    .replace(/\u00a0/g, " ");
}

describe("CountFlow", () => {
  it("lagerväljaren: båda lagren, senast inventerat och dags att räkna", () => {
    const out = html("sv", null);
    expect(out).toContain("Vilket lager räknar du?");
    expect(out).toContain("Hemma");
    expect(out).toContain("Kontoret");
    expect(out).toMatch(/Senast inventerat 1 okt\.? · 40 dagar sedan/);
    expect(out).toContain("Dags att räkna");
    expect(out).toContain("Inte inventerat än");
  });

  it("lagret i länken öppnar räkningen: en produkt i taget med Appen tror", () => {
    const out = html("sv", HEMMA);
    expect(out).toContain("Räkna hemma.");
    expect(out).toContain("0 av 2 räknade");
    expect(out).toContain("Produkt 1 av 2");
    expect(out).toContain("Paldea");
    expect(out).toContain("Appen tror: 162");
    expect(out).toMatch(/<button[^>]*>.*?Stämmer<\/button>/);
    expect(out).toContain("Hoppa över");
    // Inget räknat än: Visa skillnader går inte att trycka på.
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Räkna minst en produkt\.<\/button>/);
  });

  it("ett okänt lager i länken ger lagerväljaren", () => {
    expect(html("sv", "33333333-3333-4333-8333-333333333333")).toContain("Vilket lager räknar du?");
  });

  it("på engelska för delägaren", () => {
    const pick = html("en", null);
    expect(pick).toContain("Which place are you counting?");
    expect(pick).toContain("Home");
    expect(pick).toMatch(/Last counted 1 Oct · 40 days ago/);
    expect(pick).toContain("Not counted yet");
    const count = html("en", HEMMA);
    expect(count).toContain("Count at home.");
    expect(count).toContain("The app thinks: 162");
    expect(count).toContain("Product 1 of 2");
    expect(count).not.toMatch(/Räkna|Appen|Lager|Hoppa/);
  });
});
