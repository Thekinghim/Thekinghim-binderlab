import { describe, expect, it } from "vitest";

import type { CashflowResult } from "@/analytics/cashflow";
import { parseAmountOre } from "@/import/amount";
import { NBSP } from "@/lib/format";

import {
  bookkeepingTitle,
  cashflowHeadline,
  cashPhase,
  economyHeadline,
  NO_PAYOUT_SOURCE_TEXT,
  payoutQuestionText,
} from "./headline";
import { amountField } from "./view";

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
    expect(h.title).toBe("Inga utbetalningar inlästa.");
    expect(h.aside).toBe(NO_PAYOUT_SOURCE_TEXT);
    expect(`${h.title} ${h.aside}`).not.toMatch(/väntades|har inte kommit|75/);
  });

  it("med källa: den försenade utbetalningen visas", () => {
    const h = economyHeadline(null, cash, PERIOD, TODAY, true);
    expect(h.aside).toMatch(/väntades 31\sokt\. Har inte kommit\.$/);
    expect(h.title.split(/\s+/).length).toBeLessThanOrEqual(8);
  });
});

describe("bookkeepingTitle", () => {
  it("nästa stängda månad, annars läget", () => {
    expect(bookkeepingTitle([{ status: "open" }, { status: "closed" }], "Oktober 2026")).toBe(
      "Oktober 2026 klar att skicka.",
    );
    expect(bookkeepingTitle([{ status: "open" }, { status: "sent" }], "")).toBe("Allt är skickat.");
    expect(bookkeepingTitle([{ status: "open" }], "")).toBe("Inget att skicka ännu.");
  });
});

describe("economyHeadline med utbetalningar", () => {
  const result = (differenceOre: number, openDeviations: number) =>
    ({
      payouts: [{ period: { start: "2026-10-01", end: "2026-10-31" } }],
      totals: {
        actualOre: 7_400_000,
        expectedOre: 7_400_000 - differenceOre,
        differenceOre,
        openDeviations,
      },
    }) as unknown as Parameters<typeof economyHeadline>[0];

  it("stämmer: kort rubrik, siffrorna i raden under", () => {
    const h = economyHeadline(result(0, 0), null, PERIOD, TODAY);
    expect(h.title).toBe("Utbetalningarna stämmer.");
    expect(h.aside).toMatch(/^Utbetalt 74\s000\skr av 74\s000\skr för oktober 2026\.$/);
  });

  it("avvikelser: antalet i rubriken, skillnaden i raden under", () => {
    const h = economyHeadline(result(-5_000, 2), null, PERIOD, TODAY);
    expect(h.title).toMatch(/^2\savvikelser att utreda\.$/);
    expect(h.aside).toMatch(/Skillnad .*50\skr\.$/);
  });
});

describe("Kassaflöde: egen rubrik och inget falskt 'Faktiskt 0 kr' (utvärderingen 4 nov)", () => {
  const flow = {
    range: { start: "2026-10-01", end: "2026-12-31" },
    totals: {
      total: { netOre: 6_639_800, inOre: 7_598_900, outOre: 959_100 },
      forecast: { netOre: 6_639_800 },
    },
  } as unknown as CashflowResult;

  it("utan inlästa utbetalningar: väntat netto, inte Avstämningens rubrik", () => {
    const h = cashflowHeadline(flow, TODAY, false);
    expect(h.title).toContain("Väntat netto");
    expect(h.title).not.toBe("Inga utbetalningar inlästa.");
    expect(h.aside).toContain("Beräknat ur försäljningen");
  });

  it("med utbetalningar: netto och prognosdelen", () => {
    const h = cashflowHeadline(flow, TODAY, true);
    expect(h.title.startsWith("Netto")).toBe(true);
    expect(h.aside).toContain("Varav prognos");
  });

  it("en avslutad månad utan utbetalningsfil är inte 'Faktiskt'", () => {
    expect(cashPhase("actual", false)).toBe("untracked");
    expect(cashPhase("mixed", false)).toBe("untracked");
    expect(cashPhase("forecast", false)).toBe("forecast");
    expect(cashPhase("actual", true)).toBe("actual");
  });
});

describe("payoutQuestionText (Vad betalade Nayax?)", () => {
  it("hel månad i år: månaden utan årtal", () => {
    expect(
      payoutQuestionText({ start: "2026-10-01", end: "2026-10-31" }, 4_120_000, "2026-11-05"),
    ).toEqual({
      title: `Sålt för 41${NBSP}200${NBSP}kr i oktober efter avgifter.`,
      aside: "Vad betalade Nayax?",
    });
  });

  it("hel månad förra året: med årtal", () => {
    expect(
      payoutQuestionText({ start: "2025-12-01", end: "2025-12-31" }, 150_000, "2026-01-03").title,
    ).toBe(`Sålt för 1${NBSP}500${NBSP}kr i december 2025 efter avgifter.`);
  });

  it("egna dagar: dagarna i klartext", () => {
    const { title } = payoutQuestionText(
      { start: "2026-10-14", end: "2026-10-31" },
      99_950,
      "2026-11-05",
    );
    expect(title.startsWith(`Sålt för 1${NBSP}000${NBSP}kr 14`)).toBe(true);
    expect(title.endsWith("okt. efter avgifter.")).toBe(true);
  });
});

describe("amountField", () => {
  it("hela kronor utan decimaler, ören med komma", () => {
    expect(amountField(4_120_000)).toBe("41200");
    expect(amountField(1_217_160)).toBe("12171,60");
    expect(amountField(5)).toBe("0,05");
  });

  it("går att läsa tillbaka som samma belopp", () => {
    for (const ore of [4_120_000, 1_217_160, 5, 99]) {
      const parsed = parseAmountOre(amountField(ore));
      expect(parsed.ok && parsed.ore).toBe(ore);
    }
  });
});
