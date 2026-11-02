import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RouteError } from "./route-error";
import { RouteLoading } from "./route-loading";
import { RouteNotFound } from "./route-not-found";

const APP = join(process.cwd(), "src/app");

describe("RouteError", () => {
  it("visar sidans namn, svensk text och åtgärderna, aldrig serverns felmeddelande", () => {
    const error = Object.assign(new Error("Failed query: select secret from public.payouts"), {
      digest: "1234567890",
    });
    const html = renderToStaticMarkup(<RouteError error={error} retry={() => {}} area="Ekonomi" />);
    expect(html).toContain("<h1");
    expect(html).toContain("Ekonomi kunde inte visas.");
    expect(html).toContain("EJ LADDAD");
    expect(html).toContain("Försök igen");
    expect(html).toContain("Till Hem");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Failed query");
    expect(html).not.toContain("payouts");
  });

  it("egen rubrik och egen andra åtgärd (portalen)", () => {
    const html = renderToStaticMarkup(
      <RouteError
        error={null}
        retry={() => {}}
        area="Butiksportalen"
        title="Portalen kunde inte visas."
        home={{ label: "Till översikten", href: "/portal" }}
        inset="inset"
      />,
    );
    expect(html).toContain("Portalen kunde inte visas.");
    expect(html).toContain('href="/portal"');
    expect(html).not.toContain("max-w-[1280px]");
  });
});

describe("RouteLoading", () => {
  it("är markerad som laddning för skärmläsare", () => {
    const html = renderToStaticMarkup(<RouteLoading label="Laddar rapporter" />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Laddar rapporter"');
    expect(html).toContain("Laddar rapporter");
  });
});

describe("sidorna i genomgång C", () => {
  const segments = [
    "(app)/rapporter",
    "rapport/[id]",
    "(app)/drift",
    "(app)/inkorg",
    "(app)/ekonomi",
    "(app)/avtal",
    "(app)/marknad",
    "(app)/expansion",
    "(app)/effekt",
    "(app)/assistent",
    "portal",
  ];

  it.each(segments)("%s har ett eget felläge (error.tsx)", (segment) => {
    expect(existsSync(join(APP, segment, "error.tsx"))).toBe(true);
  });

  it.each([
    "rapport/[id]",
    "(app)/inkorg/[id]",
    "(app)/drift/automat/[id]",
    "portal/rapporter/[id]",
  ])("%s har en svensk sida för okänt id (not-found.tsx) som appens 404", (segment) => {
    const file = join(APP, segment, "not-found.tsx");
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src).toContain("<RouteNotFound");
    expect(src).toMatch(/title="[^"]+ finns inte\."/);
  });
});

describe("RouteNotFound", () => {
  it("tvådelad rubrik som h1, svensk text och en väg tillbaka", () => {
    const html = renderToStaticMarkup(
      <RouteNotFound
        eyebrow="Inkorg · 404"
        title="Ärendet finns inte."
        aside="Länken kan vara fel."
        code="Inget ärende"
        message="Inget ärende i inkorgen har det här id:t."
        action={{ label: "Till Inkorg", href: "/inkorg" }}
      />,
    );
    expect(html).toMatch(/<h1[^>]*>/);
    expect(html).toContain("Ärendet finns inte.");
    expect(html).toContain("Länken kan vara fel.");
    expect(html).toContain('href="/inkorg"');
  });
});
