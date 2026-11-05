import { describe, expect, it } from "vitest";

import { invoiceBasis } from "@/analytics/subscriptions/billing";

import {
  basisSpecification,
  formatMoney,
  formatMoneyList,
  invoiceCsv,
  monthLabel,
  parseMonthParam,
} from "./model";

const NB = " ";

describe("format", () => {
  it("belopp i valutan", () => {
    expect(formatMoney(49_900, "SEK")).toBe(`499${NB}kr`);
    expect(formatMoney(49_950, "SEK")).toBe(`499,50${NB}kr`);
    expect(formatMoney(123_456_700, "DKK")).toBe(`1${NB}234${NB}567${NB}DKK`);
    expect(formatMoney(100, "SEK", 2)).toBe(`1,00${NB}kr`);
    expect(formatMoneyList([])).toBe(`0${NB}kr`);
    expect(
      formatMoneyList([
        { currency: "SEK", amountOre: 100 },
        { currency: "EUR", amountOre: 200 },
      ]),
    ).toBe(`1${NB}kr + 2${NB}EUR`);
  });

  it("månad", () => {
    expect(monthLabel("2026-11")).toBe("november 2026");
    expect(parseMonthParam("2026-02", "2026-11")).toBe("2026-02");
    expect(parseMonthParam("2026-13", "2026-11")).toBe("2026-11");
    expect(parseMonthParam(undefined, "2026-11")).toBe("2026-11");
  });
});

describe("CSV", () => {
  const basis = invoiceBasis(
    {
      periods: [
        {
          validFrom: "2026-01-01",
          validTo: null,
          status: "active",
          pricePerMachineOre: 49_950,
          currency: "SEK",
        },
      ],
      machines: [
        { machineId: "a", activeFrom: "2026-01-01", activeTo: null },
        { machineId: "b", activeFrom: "2026-11-16", activeTo: null },
      ],
      customer: { countryCode: "SE", vatNumber: null, trialEndsOn: null },
    },
    "2026-11",
  );

  it("en rad per kund och valuta med moms och specifikation", () => {
    // 45 automatdagar × 499,50 / 30 = 749,25 kr; moms 187,31 (187,3125 → 187,31).
    expect(basis.totals).toEqual([
      { currency: "SEK", netOre: 74_925, vatOre: 18_731, totalOre: 93_656 },
    ]);
    const csv = invoiceCsv("2026-11", [
      { name: "Kund AB", slug: "kund", countryCode: "SE", vatNumber: null, basis },
      {
        name: "=Elak",
        slug: "elak",
        countryCode: "DK",
        vatNumber: "DK1234",
        basis: invoiceBasis(
          {
            periods: [],
            machines: [],
            customer: { countryCode: "DK", vatNumber: "DK1234", trialEndsOn: null },
          },
          "2026-11",
        ),
      },
    ]);
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe(
      "Månad;Kund;Kund-id;Land;Momsnummer;Momsregel;Valuta;Aktiva automater;Debiterade automatdagar;Dagar i månaden;Belopp exkl. moms;Momssats %;Moms;Att fakturera;Specifikation;Notering",
    );
    expect(lines[1]).toContain(
      "2026-11;Kund AB;kund;SE;;Svensk moms 25 %;SEK;2;45;30;749,25;25;187,31;936,56;",
    );
    // Formelinjektion skyddas, och kunden utan belopp får en nollrad.
    expect(lines[2]).toContain(
      "'=Elak;elak;DK;DK1234;Omvänd skattskyldighet;;0;0;30;0,00;0;0,00;0,00",
    );
  });

  it("kolumnnamnen är unika (momsregeln och momsbeloppet heter olika)", () => {
    const header = invoiceCsv("2026-11", [])
      .replace(/^\uFEFF/, "")
      .split("\r\n")[0]!;
    const names = header.split(";");
    expect(new Set(names).size).toBe(names.length);
  });

  it("specifikation", () => {
    expect(basisSpecification(basis)).toBe(`45 automatdagar à 499,50${NB}kr/mån (30 dagar)`);
  });
});
