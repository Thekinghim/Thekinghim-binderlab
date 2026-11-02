import { describe, expect, it } from "vitest";

import { parsePayoutDate, parsePayoutFile, parsePayoutPeriod, parseSignedOre } from "./payout-csv";

const file = (lines: string[]) => lines.join("\r\n") + "\r\n";

describe("parsePayoutFile: utbetalningar", () => {
  it("tolkar svenska rubriker, belopp med decimalkomma och valfria återbetalningar", () => {
    const r = parsePayoutFile(
      file([
        "Referens;Period från;Period till;Utbetald;Belopp;Avgifter;Återbetalningar",
        "U-1;2026-10-01;2026-10-31;2026-11-05;1 234,50;12,00;",
        'U-2;2026-11-01;2026-11-30;2026-12-05;"-98,00";100,00;49,00',
      ]),
    );
    expect(r.format).toBe("payouts");
    expect(r.errors).toEqual([]);
    expect(r.payouts).toHaveLength(2);
    expect(r.payouts[0]).toMatchObject({
      lineNumber: 2,
      reference: "U-1",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      paidOn: "2026-11-05",
      amountOre: 123_450,
      feesOre: 1200,
      refundsOre: null,
    });
    expect(r.payouts[1]).toMatchObject({ amountOre: -9800, feesOre: 10_000, refundsOre: 4900 });
    expect(r.payouts[0]!.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("känner igen engelska rubriker och en periodkolumn med månad", () => {
    const r = parsePayoutFile(
      file(["Payout ID,Period,Payout date,Amount,Fees", "P-9,2026-02,2026-03-03,100.00,0"]),
    );
    expect(r.payouts[0]).toMatchObject({
      reference: "P-9",
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      amountOre: 10_000,
    });
  });

  it("samma innehåll ger samma hash, annat belopp en annan", () => {
    const a = parsePayoutFile(file(["Referens;Period;Belopp", "X;2026-10;10"])).payouts[0]!;
    const b = parsePayoutFile(file(["Referens;Period;Belopp", "X;2026-10;10,00"])).payouts[0]!;
    const c = parsePayoutFile(file(["Referens;Period;Belopp", "X;2026-10;11"])).payouts[0]!;
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.sourceHash).not.toBe(c.sourceHash);
  });

  it("felrader stoppar inte filen och har radnummer", () => {
    const r = parsePayoutFile(
      file([
        "Referens;Period från;Period till;Belopp",
        ";2026-10-01;2026-10-31;1",
        "U-2;2026-10-31;2026-10-01;1",
        "U-3;2026-13-01;2026-10-01;1",
        "U-4;2026-10-01;2026-10-31;1,234",
        "U-5;2026-10-01;2026-10-31;5",
      ]),
    );
    expect(r.payouts.map((p) => p.reference)).toEqual(["U-5"]);
    expect(r.errors.map((e) => e.lineNumber)).toEqual([2, 3, 4, 5]);
    expect(r.errors[0]!.message).toMatch(/Referens saknas/);
    expect(r.errors[1]!.message).toMatch(/slutar före/);
  });

  it("okänt format och saknade kolumner ger ett tydligt fel", () => {
    expect(() => parsePayoutFile(file(["A;B", "1;2"]))).toThrow(/Rubrikerna känns inte igen/);
    expect(() =>
      parsePayoutFile(file(["Referens;Period från;Period till", "x;2026-10-01;2026-10-02"])),
    ).toThrow(/Kolumn saknas: Belopp/);
    expect(() => parsePayoutFile("Referens;Period;Belopp\r\n")).toThrow(/saknar rader/);
  });
});

describe("parsePayoutFile: specifikation per order", () => {
  it("tolkar ordernummer och belopp och avvisar Excel-avkortade nummer", () => {
    const r = parsePayoutFile(
      file(["Referens;Order No.;Belopp", "U-1;42780;49,00", "U-1;4.27801E+11;49,00", "U-1;;49"]),
    );
    expect(r.format).toBe("lines");
    expect(r.lines).toEqual([
      { lineNumber: 2, reference: "U-1", externalId: "42780", amountOre: 4900 },
    ]);
    expect(r.errors.map((e) => e.lineNumber)).toEqual([3, 4]);
  });
});

describe("hjälpfunktioner", () => {
  it("datum och perioder", () => {
    expect(parsePayoutDate("2026/02/28")).toBe("2026-02-28");
    expect(parsePayoutDate("20260228")).toBe("2026-02-28");
    expect(parsePayoutDate("2026-02-29")).toBeNull();
    expect(parsePayoutPeriod("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(parsePayoutPeriod("2026-10-01–2026-10-15")).toEqual({
      start: "2026-10-01",
      end: "2026-10-15",
    });
    expect(parsePayoutPeriod("2026-10-01 till 2026-10-15")).toEqual({
      start: "2026-10-01",
      end: "2026-10-15",
    });
    expect(parsePayoutPeriod("oktober")).toBeNull();
  });

  it("belopp med tecken", () => {
    expect(parseSignedOre("−12,50")).toEqual({ ok: true, ore: -1250 });
    expect(parseSignedOre("(5,00)")).toEqual({ ok: true, ore: -500 });
    expect(parseSignedOre("170 kr")).toEqual({ ok: true, ore: 17_000 });
    expect(parseSignedOre("abc").ok).toBe(false);
  });
});
