import { describe, expect, it } from "vitest";

import { decodeCp437, type AccountantReport, type LedgerAccount } from "@/reports";

import { buildSieFile, monthVouchers, type PayoutForBooking } from "./vouchers";

const ACCOUNTS: LedgerAccount[] = [
  { key: "settlement", account: "1580", name: "Fordran på kortinlösen" },
  { key: "bank", account: "1930", name: "Företagskonto" },
  { key: "vat_out", account: "2611", name: "Utgående moms" },
  { key: "sales", account: "3004", name: "Försäljning" },
  { key: "card_fees", account: "6040", name: "Kontokortsavgifter" },
];
const FY = { start: "2026-01-01", end: "2026-12-31" };

/** En minimal rapport: två dagar med försäljning och uppskattad avgift. */
function report(feesPerDay: number): AccountantReport {
  const day = (date: string, gross: number) => ({
    date,
    orders: 1,
    grossOre: gross,
    netOre: gross,
    vatOre: 0,
    feesOre: feesPerDay,
    evidence: {} as never,
  });
  return {
    kind: "accountant",
    period: { start: "2026-10-01", end: "2026-10-31" },
    vatRateBp: 0,
    cardFeeBp: 100,
    days: [day("2026-10-14", 17_000), day("2026-10-20", 34_000)],
    stores: [],
    totals: { costOre: 0 } as never,
  } as unknown as AccountantReport;
}

const PAYOUT: PayoutForBooking = {
  reference: "AW-10",
  period: { start: "2026-10-01", end: "2026-10-15" },
  paidOn: "2026-10-20",
  amountOre: 16_000,
  feesOre: 373,
  refundsOre: 627,
};

describe("monthVouchers", () => {
  it("bokför utbetalningen: bank + faktiska avgifter + återbetalningar mot avräkningen", () => {
    const r = monthVouchers({
      report: report(0),
      payouts: [PAYOUT],
      accounts: ACCOUNTS,
      fiscalYear: FY,
      series: "BL",
      firstNumber: 41,
    });
    const payout = r.verifications.find((v) => v.text.startsWith("Utbetalning AW-10"))!;
    expect(payout.date).toBe("2026-10-20");
    expect(payout.transactions).toEqual([
      { account: "1930", amountOre: 16_000 },
      { account: "6040", amountOre: 373 },
      { account: "3004", amountOre: 627 },
      { account: "1580", amountOre: -17_000 },
    ]);
    // Fortlöpande nummer från firstNumber, i datumordning (dagskassan före utbetalningen samma dag).
    expect(r.verifications.map((v) => [v.number, v.date])).toEqual([
      [41, "2026-10-14"],
      [42, "2026-10-20"],
      [43, "2026-10-20"],
    ]);
    expect(r.bankFallback).toBe(false);
  });

  it("dagar som utbetalningen täcker får ingen uppskattad avgift (ingen dubbelbokning)", () => {
    const r = monthVouchers({
      report: report(170),
      payouts: [PAYOUT],
      accounts: ACCOUNTS,
      fiscalYear: FY,
      series: "BL",
      firstNumber: 1,
    });
    const day14 = r.verifications.find((v) => v.date === "2026-10-14")!;
    const day20 = r.verifications.find((v) => v.text.startsWith("Försäljning 20"))!;
    expect(day14.transactions.some((t) => t.account === "6040")).toBe(false);
    expect(day20.transactions).toContainEqual({ account: "6040", amountOre: 170 });
    expect(r.daysWithActualFees).toBe(1);
  });

  it("utan bankkonto i kontoplanen används BAS 1930 och det flaggas", () => {
    const r = monthVouchers({
      report: report(0),
      payouts: [PAYOUT],
      accounts: ACCOUNTS.filter((a) => a.key !== "bank"),
      fiscalYear: FY,
      series: "BL",
      firstNumber: 1,
    });
    expect(r.bankFallback).toBe(true);
    expect(r.accounts.map((a) => a.account)).toContain("1930");
  });

  it("alla verifikationer balanserar, och SIE-filen har #GEN och fortlöpande nummer", () => {
    const r = monthVouchers({
      report: report(170),
      payouts: [PAYOUT],
      accounts: ACCOUNTS,
      fiscalYear: FY,
      series: "BL",
      firstNumber: 7,
    });
    for (const v of r.verifications) {
      expect(v.transactions.reduce((s, t) => s + t.amountOre, 0)).toBe(0);
    }
    const text = decodeCp437(
      Buffer.from(
        buildSieFile({
          company: "Binderlab AB",
          fiscalYear: FY,
          generatedOn: "2026-11-02",
          accounts: r.accounts,
          verifications: r.verifications,
        }),
      ),
    );
    expect(text).toContain("#GEN 20261102");
    expect(text).toContain('#VER "BL" "7" 20261014');
    expect(text).toContain('#VER "BL" "9" 20261020 "Utbetalning AW-10');
    expect(text).toContain("#KONTO 1930");
  });
});
