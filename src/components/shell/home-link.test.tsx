/**
 * Loggan (till startsidan) bär period, filter och "Visa butikernas andel" som menyns andra
 * länkar, så att Hem öppnas i samma vy och inte med standardperioden.
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/lonsamhet",
  useRouter: () => ({ push: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams("period=30d&andel=1&butik=s-1&titel=x"),
}));

const { Sidebar } = await import("./side-nav");

describe("loggan i sidomenyn", () => {
  it("länkar till Hem med period, butik och andel (inte sidans egna parametrar)", () => {
    const html = renderToString(createElement(Sidebar, { role: "owner" }));
    const logo = html.match(/<a[^>]*aria-label="Binderlab, till startsidan"[^>]*>/)?.[0] ?? "";
    expect(logo).toContain('href="/?period=30d&amp;butik=s-1&amp;andel=1"');
  });
});
