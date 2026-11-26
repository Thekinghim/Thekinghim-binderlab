/**
 * Rutts första skärm före hydrering (serverns HTML): utan stopp EN rad som säger varför (inte
 * rubriken, ett tomt stoppkort och en tom packlista), en tom packlista som en rad, och ett
 * offline-stopp med checklistan. Inga kronor när servern inte skickar några (påfyllaren).
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DayRoute, RouteStop } from "@/server/data/v2/types";

vi.mock("../actions", () => ({
  changeRoute: vi.fn(),
  undoRouteChange: vi.fn(),
  saveRouteLimits: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  unstable_rethrow: () => {},
}));

const { RouteView } = await import("./route-view");

const stop = (machineId: string, over: Partial<RouteStop> = {}): RouteStop =>
  ({
    machineId,
    code: `NA-${machineId}`,
    name: `Automat ${machineId}`,
    sequence: 1,
    store: { name: "Butik A", address: "Gatan 1", city: "Stad", phone: null },
    status: "fyll",
    statusLabel: null,
    packs: 0,
    lines: [],
    reasons: [],
    done: false,
    lossProfitPerDayOre: null,
    kind: "fill",
    emptySlots: 0,
    daysLeft: null,
    late: false,
    added: false,
    power: null,
    ...over,
  }) as RouteStop;

const base: DayRoute = {
  date: "2026-11-26",
  stops: [],
  cities: [],
  groups: [],
  totalPacks: 0,
  totalMeters: null,
  km: null,
  minutes: null,
  routeMethod: "urgency",
  load: [],
  short: [],
  substitutes: [],
  savesProfitPerDayOre: null,
  removed: [],
  added: [],
  upcoming: [],
  depot: null,
  limits: { maxStops: 6, maxPacks: 350, weekdays: [1, 2, 3, 4, 5] },
  routeDay: true,
  nextRouteDay: null,
  needing: 0,
  overflow: [],
} as unknown as DayRoute;

function html(route: DayRoute): string {
  return renderToString(
    <RouteView route={route} scope="org:user" canEdit canRefill canEditLimits={false} />,
  )
    .replace(/<!-- -->/g, "")
    .replace(/ /g, " ");
}

describe("RouteView", () => {
  it("utan stopp: ett tomt läge, inget tomt stoppkort och ingen tom packlista", () => {
    const out = html(base);
    expect(out).toContain("Ingen påfyllning behövs i dag");
    expect(out.match(/Ingen påfyllning behövs i dag/g)).toHaveLength(1);
    expect(out).not.toContain("Inga stopp att visa");
    expect(out).not.toContain("Packlista");
    expect(out).not.toContain("Starta rutt");
    // Kommande dagar står kvar.
    expect(out).toContain("Kommande dagar");
  });

  it("offline-stopp utan packlista: en rad för packlistan, checklistan och Starta rutt", () => {
    const s = stop("07", { kind: "check", status: "offline" });
    const out = html({
      ...base,
      stops: [s],
      groups: [{ city: "Stad", machineIds: ["07"], packs: 0 }],
      cities: ["Stad"],
      needing: 1,
    });
    expect(out).toContain("Inget att packa i dag.");
    expect(out).toContain('class="col pack-empty"');
    expect(out).not.toContain("Allt är fullt");
    expect(out).toContain("Offline · kolla på plats");
    expect(out).toContain("Har automaten ström?");
    expect(out).toContain("Starta rutt · 1 stopp");
    expect(out).toContain('href="/fyll-pa/07?rutt=1"');
    expect(out).not.toMatch(/\d\s?kr\b/);
  });
});
