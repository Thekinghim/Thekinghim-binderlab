/**
 * Ruttläget, offline-stopp (serverns HTML): checklistan, Hoppa över och Stoppet klart i
 * stället för facken och "Klar · 0 pack". Inga kronor.
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { FillMachine } from "../_lib/model";

vi.mock("@/app/(app)/rutt/actions", () => ({ changeRoute: vi.fn(), undoRouteChange: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));

const { CheckStopScreen } = await import("./fill-check");

const machine = {
  id: "m1",
  code: "NA-07",
  name: "Automat 07",
  place: "Butik A",
  syncedAt: null,
  fillPct: null,
  emptySlots: 0,
  units: 0,
  capacity: 0,
  suggested: 0,
  empty: 0,
  low: 0,
  needs: false,
  mine: true,
  rows: [],
} as unknown as FillMachine;

describe("CheckStopScreen", () => {
  it("checklistan, Hoppa över och Stoppet klart, stegraden och Offline", () => {
    const out = renderToString(
      <CheckStopScreen
        machine={machine}
        store={null}
        scope="org:user"
        date="2026-11-26"
        link="offline"
        route={{ index: 0, total: 2 }}
        onBack={() => {}}
        onLeave={() => {}}
      />,
    ).replace(/<!-- -->/g, "");
    expect(out).toContain("Offline · kolla på plats");
    expect(out).toContain("Har automaten ström?");
    expect(out).toContain("Syns den i Awish igen?");
    expect(out).toContain("Hoppa över");
    expect(out).toContain("Stoppet klart");
    expect(out).not.toContain("Klar ·");
    expect(out).not.toMatch(/\d\s?kr\b/);
  });
});
