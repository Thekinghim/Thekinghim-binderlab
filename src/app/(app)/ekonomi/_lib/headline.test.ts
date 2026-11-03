import { describe, expect, it } from "vitest";

import type { CashflowResult } from "@/analytics/cashflow";

import { economyHeadline, NO_PAYOUT_SOURCE_TEXT } from "./headline";

const PERIOD = { start: "2026-10-04", end: "2026-11-02" };
const TODAY = "2026-11-03";

/** Ett kassaflöde med en försenad, väntad utbetalning (som prognosen ger utan inlästa). */
const cash = {
  items: [
    {
      key: "payout-forecast:2026-10-01",
      kind: "payout",
      direction: "in",
      date: "2026-11-04",
      dueDate: "2026-10-31",
      phase: "forecast",
      amountOre: 7_599_000,
      overdue: true,
      label: "Utbetalning för 1–31 okt. väntades 31 okt. men saknas",
    },
  ],
} as unknown as CashflowResult;

describe("economyHeadline utan utbetalningar", () => {
  it("utan källa: en neutral rad, ingen saknad utbetalning", () => {
    const h = economyHeadline(null, cash, PERIOD, TODAY, false);
    expect(h.title).toBe("Inga utbetalningar är inlästa.");
    expect(h.aside).toBe(NO_PAYOUT_SOURCE_TEXT);
    expect(`${h.title} ${h.aside}`).not.toMatch(/väntades|har inte kommit|75/);
  });

  it("med källa: den försenade utbetalningen visas", () => {
    const h = economyHeadline(null, cash, PERIOD, TODAY, true);
    expect(h.aside).toMatch(/som väntades 31\sokt\. har inte kommit\.$/);
  });
});
