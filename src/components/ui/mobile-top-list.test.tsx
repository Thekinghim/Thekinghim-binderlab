/**
 * Tabellen per titel på Lönsamhet visar på iPhone de fem första raderna och "Visa alla N";
 * från md (dator) visas allt och knappen syns inte.
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MobileTopRows } from "./mobile-top-list";

function html(total: number, defaultOpen = false): string {
  return renderToString(
    <MobileTopRows total={total} noun="titlar" defaultOpen={defaultOpen}>
      <table>
        <tbody />
      </table>
    </MobileTopRows>,
  );
}

describe("MobileTopRows", () => {
  it("över fem rader: döljer rad 6 och framåt under md och visar Visa alla N bara under md", () => {
    const out = html(12);
    expect(out).toContain("max-md:[&amp;_tbody&gt;tr:nth-child(n+6)]:hidden");
    expect(out).toContain("Visa alla 12 titlar");
    expect(out).toMatch(/<button[^>]*aria-expanded="false"[^>]*md:hidden/);
  });

  it("fem rader eller färre: inget fälls ihop och ingen knapp", () => {
    const out = html(5);
    expect(out).not.toContain("nth-child");
    expect(out).not.toContain("<button");
  });

  it("öppen från början (vald titel): alla rader och Visa färre", () => {
    const out = html(12, true);
    expect(out).not.toContain("nth-child");
    expect(out).toContain("Visa färre");
  });
});
