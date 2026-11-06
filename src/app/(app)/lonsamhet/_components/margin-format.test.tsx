/**
 * Vattenfallet och nyckeltalet visar samma marginal för samma tal. Tidigare räknade
 * vattenfallet om procenten ur kronorna (2 374,51 / 10 000 = 23,7 %) medan nyckeltalet
 * visade bp (2 375 = 23,8 %): två olika tal för samma marginal. Nu formaterar båda samma
 * bp med samma funktion (formatMarginBp).
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Uppmätt bredd, så att vattenfallets etiketter ritas även i serverns HTML.
vi.mock("@/lib/hooks/use-measure", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useMeasure: () => [{ current: null }, 720, true],
}));

import { formatMarginBp } from "@/lib/format";

import type { Bridge } from "../_lib/model";
import { LonsamhetBridge } from "./bridge";
import { KPI_FORMAT } from "./kpis";

const plain = (t: string) => t.replace(/&nbsp;|\u00a0|\u202f/g, " ");

const BRIDGE: Bridge = {
  revenueOre: 1_000_000,
  vmbVatOre: null,
  vmbPreliminary: false,
  costOre: 762_549,
  feesOre: 0,
  compensationOre: 0,
  commissionOre: 0,
  rentOre: 0,
  unallocatedRentOre: 0,
  profitOre: 237_451,
  marginBp: 2_375,
  unpricedRevenueOre: 0,
  showStoreShare: false,
  storeShareLabel: "Butikernas andel",
  profitLabel: "Vår vinst",
  profitBeforeShareOre: 237_451,
} as Bridge;

describe("marginalen: samma text i nyckeltalet och vattenfallet", () => {
  it("formatMarginBp avrundar bp en gång, utan flyttalsfel", () => {
    expect(plain(formatMarginBp(2_375))).toBe("23,8 %");
    expect(plain(formatMarginBp(2_374))).toBe("23,7 %");
    expect(plain(formatMarginBp(-2_375))).toBe("−23,8 %");
    expect(plain(formatMarginBp(5))).toBe("0,1 %");
    expect(plain(formatMarginBp(0))).toBe("0,0 %");
  });

  it("nyckeltalet och vattenfallet visar samma procent", () => {
    const kpi = plain(KPI_FORMAT.bp(BRIDGE.marginBp!));
    expect(kpi).toBe("23,8 %");
    const html = plain(renderToString(createElement(LonsamhetBridge, { bridge: BRIDGE })));
    // Etiketten på resultatet ("2,4 tkr · 23,8 %") och skärmläsartexten.
    expect(html).toContain(`· ${kpi}`);
    expect(html).toContain(`marginal ${kpi}`);
    expect(html).not.toContain("23,7 %");
  });
});
