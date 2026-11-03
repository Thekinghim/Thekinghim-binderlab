import { describe, expect, it } from "vitest";

import { CONTRACT_PAYOUT_DAY } from "@/reports/contract-pdf";
import { buildStoreReport } from "@/reports/store-report";
import { agreement, ord, sources } from "@/reports/testing/fixtures";

import {
  parseStatement,
  payoutDueDate,
  settlementFileName,
  settlementHtml,
  settlementMonthFor,
  settlementState,
  statementFromReport,
} from "./model";

const plain = (s: string) => s.replace(/ /g, " ");

function report() {
  const src = sources({
    orders: [ord("2026-10-03"), ord("2026-10-04", { amountOre: 5900 })],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
    ],
  });
  return buildStoreReport(src, "s-1", "2026-10");
}

describe("statementFromReport", () => {
  it("beloppet är rapportens ersättning och stegen summerar till det", () => {
    const r = report();
    const st = statementFromReport(r);
    expect(st.totalOre).toBe(r.compensation.totalOre);
    expect(st.steps.reduce((n, s) => n + s.amountOre, 0)).toBe(r.compensation.totalOre);
    expect(st.steps.some((s) => s.label === "")).toBe(false);
    expect(st.month).toBe("2026-10");
    expect(st.orders).toBe(2);
    expect(st.salesInclVatOre).toBe(r.sales.grossOre);
  });

  it("sparar bara uträkningen: inga titlar, automater eller veckor", () => {
    const json = JSON.stringify(statementFromReport(report()));
    expect(json).not.toMatch(/topTitles|machines|weeks|titleId|machineId/);
  });

  it("läses tillbaka; fel form ger null", () => {
    const st = statementFromReport(report());
    expect(parseStatement(JSON.parse(JSON.stringify(st)))).toEqual(st);
    expect(parseStatement({ ...st, version: 2 })).toBeNull();
    expect(parseStatement({ ...st, totalOre: 1.5 })).toBeNull();
    expect(parseStatement(null)).toBeNull();
  });
});

describe("status och datum", () => {
  it("betald, obetald eller inget att betala", () => {
    expect(settlementState(100, null)).toBe("unpaid");
    expect(settlementState(100, "2026-11-05")).toBe("paid");
    expect(settlementState(0, null)).toBe("nothing");
    expect(settlementState(-500, null)).toBe("owed");
  });

  it("sista dag = avtalets utbetalningsdag månaden efter", () => {
    expect(payoutDueDate("2026-10")).toBe(`2026-11-${CONTRACT_PAYOUT_DAY}`);
    expect(payoutDueDate("2026-12")).toBe(`2027-01-${CONTRACT_PAYOUT_DAY}`);
  });

  it("avräkningsmånaden är förra månaden, även över årsskiftet", () => {
    expect(settlementMonthFor("2026-11-01")).toBe("2026-10");
    expect(settlementMonthFor("2027-01-31")).toBe("2026-12");
  });

  it("filnamnet är ASCII", () => {
    expect(settlementFileName("Kafé Åkersberga & Co", "2026-10")).toBe(
      "avrakning-kafe-akersberga-co-2026-10.pdf",
    );
    expect(settlementFileName("???", "2026-10")).toBe("avrakning-butik-2026-10.pdf");
  });
});

describe("settlementHtml", () => {
  const st = statementFromReport(report());

  it("visar beloppet och status", () => {
    const html = plain(
      settlementHtml({
        organizationName: "Binderlab AB",
        statement: st,
        amountOre: st.totalOre,
        paidOn: null,
        reference: "abcd1234",
      }),
    );
    expect(html).toContain("Betalas senast 15 november 2026");
    expect(html).toContain("Att betala ut");
    const paid = plain(
      settlementHtml({
        organizationName: "Binderlab AB",
        statement: st,
        amountOre: st.totalOre,
        paidOn: "2026-11-05",
        reference: "abcd1234",
      }),
    );
    expect(paid).toContain("Betald 5 november 2026");
  });

  it("escapar namn och har inga skript eller externa resurser", () => {
    const html = settlementHtml({
      organizationName: "<script>x</script>",
      statement: { ...st, storeName: '"><img src=x>' },
      amountOre: 0,
      paidOn: null,
      reference: "abcd1234",
    });
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/https?:\/\//);
    expect(plain(html)).toContain("Inget att betala ut");
  });
});
