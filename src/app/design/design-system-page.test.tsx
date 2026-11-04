/**
 * /design renderas på servern (UTC i drift på Vercel) och hydreras i webbläsaren (svensk
 * tid). Sidan måste därför ge samma HTML oavsett processens tidszon. Annars kastar React
 * fel #418 (text skiljer) vid hydrering. Rapportexemplets "Genererad 2 nov. 2026 09:14"
 * var skapat i lokal tid och blev 10:14 på servern men 09:14 i webbläsaren.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => "/design",
  useSearchParams: () => new URLSearchParams(),
}));

const ORIGINAL_TZ = process.env.TZ;

/** Läser in sidan på nytt i tidszonen, så att modulernas konstanter skapas där. */
async function renderIn(timeZone: string): Promise<string> {
  process.env.TZ = timeZone;
  vi.resetModules();
  const [{ DesignSystemPage }, { parseThemeTokens }, { ToastProvider }] = await Promise.all([
    import("./design-system-page"),
    import("./tokens"),
    import("@/components/ui/toast"),
  ]);
  const tokens = parseThemeTokens(readFileSync("src/styles/tokens.css", "utf8"));
  return renderToString(
    createElement(
      ToastProvider,
      null,
      createElement(DesignSystemPage, { tokens, counts: { components: 30 } }),
    ),
  );
}

function texts(html: string): string[] {
  return html
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
}

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("/design i serverns och webbläsarens tidszon", () => {
  it("ger samma text i UTC som i Europe/Stockholm (ingen hydreringsmiss)", async () => {
    const server = texts(await renderIn("UTC"));
    const browser = texts(await renderIn("Europe/Stockholm"));
    expect(server.length).toBeGreaterThan(1000);
    expect(server).toEqual(browser);
    expect(browser).toContain("2 nov. 2026 09:14");
  }, 60_000);
});
