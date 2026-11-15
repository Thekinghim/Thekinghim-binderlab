/**
 * Pris mot kund på Inköpspriser: texterna, skillnaden mot vårt pris, fältets tolkning,
 * raderna, prishistoriken och ändringsloggen. Bara visning: se
 * customer-price-isolation.test.ts för att inget annat läser kolumnen.
 */

import { describe, expect, it } from "vitest";

import { priceHistory } from "@/domain";
import { MINUS, NBSP } from "@/lib/format";

import {
  CUSTOMER_PRICE_TEXT,
  PRICE_MESSAGES,
  costLabel,
  parseCustomerPriceInput,
  priceGap,
  priceGapText,
  priceInputText,
  priceLog,
  priceTimeline,
  withCustomerPrices,
  type PriceAuditEvent,
  type TitleRow,
} from "./model";

describe("texterna", () => {
  it("vårt pris, pris mot kund och skillnad, med en rad om vad vinsten räknas på", () => {
    expect(CUSTOMER_PRICE_TEXT.ours).toBe("Vårt pris");
    expect(CUSTOMER_PRICE_TEXT.customer).toBe("Pris mot kund");
    expect(CUSTOMER_PRICE_TEXT.gap).toBe("Skillnad");
    expect(CUSTOMER_PRICE_TEXT.helper).toBe(
      "Vinsten räknas på vårt pris. Pris mot kund visas bara här.",
    );
    expect(CUSTOMER_PRICE_TEXT.hint).toBe("Valfritt. Vinsten räknas på vårt pris.");
    expect(costLabel(false)).toBe("Vårt pris per pack");
    expect(CUSTOMER_PRICE_TEXT.field).toBe("Pris mot kund per pack");
  });
});

describe("priceGap", () => {
  it("ägarens exempel: 110 kr hos oss, 145 kr mot kund ger +35 kr och +32 %", () => {
    const gap = priceGap(11_000, 14_500);
    expect(gap).toEqual({ ore: 3_500, share: 3_500 / 11_000 });
    expect(priceGapText(gap)).toBe(`+35,00${NBSP}kr · +32${NBSP}%`);
  });

  it("saknas något av priserna finns ingen skillnad: ett streck, aldrig 0 kr", () => {
    expect(priceGap(11_000, null)).toBeNull();
    expect(priceGap(null, 14_500)).toBeNull();
    expect(priceGap(undefined, undefined)).toBeNull();
    expect(priceGapText(null)).toBe("–");
  });

  it("pris mot kund 0 kr är ett pris (inte tomt), och lägre än vårt pris blir minus", () => {
    expect(priceGap(11_000, 0)).toEqual({ ore: -11_000, share: -1 });
    expect(priceGapText(priceGap(11_000, 10_000))).toBe(
      `${MINUS}10,00${NBSP}kr · ${MINUS}9${NBSP}%`,
    );
  });

  it("vårt pris 0 kr: kronor utan procent", () => {
    expect(priceGap(0, 14_500)).toEqual({ ore: 14_500, share: null });
    expect(priceGapText(priceGap(0, 14_500))).toBe(`+145,00${NBSP}kr`);
  });
});

describe("fältet Pris mot kund", () => {
  it("tomt fält är inget pris, inte ett fel och inte 0 kr", () => {
    expect(parseCustomerPriceInput("")).toEqual({ ok: true, ore: null });
    expect(parseCustomerPriceInput("   ")).toEqual({ ok: true, ore: null });
  });

  it("kronor med komma eller utan, som vårt pris", () => {
    expect(parseCustomerPriceInput("145")).toEqual({ ok: true, ore: 14_500 });
    expect(parseCustomerPriceInput("145,50")).toEqual({ ok: true, ore: 14_550 });
    expect(parseCustomerPriceInput("0")).toEqual({ ok: true, ore: 0 });
  });

  it("skräp, minus och för stora belopp nekas med ett eget fel", () => {
    expect(parseCustomerPriceInput("abc")).toEqual({
      ok: false,
      message: PRICE_MESSAGES.customerInvalid,
    });
    expect(parseCustomerPriceInput("-5").ok).toBe(false);
    const tooHigh = parseCustomerPriceInput("100001");
    expect(tooHigh.ok).toBe(false);
    expect(tooHigh.ok ? "" : tooHigh.message).toMatch(/^Högst /);
  });

  it("det sparade priset skrivs tillbaka i fältet som det skrevs", () => {
    expect(priceInputText(14_500)).toBe("145");
    expect(priceInputText(14_550)).toBe("145,50");
    expect(priceInputText(5)).toBe("0,05");
    expect(priceInputText(0)).toBe("0");
    expect(priceInputText(null)).toBe("");
    for (const ore of [0, 5, 14_500, 14_550, 9_999_999]) {
      expect(parseCustomerPriceInput(priceInputText(ore))).toEqual({ ok: true, ore });
    }
  });
});

const ROW: TitleRow = {
  id: "t-1",
  name: "30th Celebration",
  series: null,
  archived: false,
  currentCostOre: 11_000,
  currentFrom: "2026-10-27",
  averagePriceOre: 17_000,
  averageCostOre: 11_000,
  leftBeforeOre: 6_000,
  storeShareOre: 0,
  leftOre: 6_000,
  marginBeforeBp: 3_529,
  marginBeforeShare: 0.3529,
  marginBp: 3_529,
  rentOre: 0,
  leftBeforeAfterRentOre: 6_000,
  leftAfterRentOre: 6_000,
  orders: 10,
  unpricedOrders: 0,
  unpricedRevenueOre: 0,
  unpricedFirstDate: null,
  status: "ok",
  own: false,
};

describe("withCustomerPrices", () => {
  const prices = [
    { titleId: "t-1", validFrom: "2026-10-01", customerPriceOre: 13_900 },
    { titleId: "t-1", validFrom: "2026-10-27", customerPriceOre: 14_500 },
    { titleId: "t-2", validFrom: "2026-10-27", customerPriceOre: 9_900 },
  ];

  it("lägger priset från samma prisperiod som radens inköpspris på raden", () => {
    const [row] = withCustomerPrices([ROW], prices);
    expect(row!.customerPriceOre).toBe(14_500);
  });

  it("rör inget annat på raden: alla räknade fält är desamma", () => {
    const [row] = withCustomerPrices([ROW], prices);
    expect({ ...row!, customerPriceOre: undefined }).toEqual(ROW);
  });

  it("utan pris mot kund, eller utan inköpspris, blir det null (streck)", () => {
    expect(
      withCustomerPrices(
        [ROW],
        [{ titleId: "t-1", validFrom: "2026-10-27", customerPriceOre: null }],
      )[0]!.customerPriceOre,
    ).toBeNull();
    expect(withCustomerPrices([ROW], [])[0]!.customerPriceOre).toBeNull();
    expect(
      withCustomerPrices([{ ...ROW, currentCostOre: null, currentFrom: null }], prices)[0]!
        .customerPriceOre,
    ).toBeNull();
  });
});

describe("prishistoriken", () => {
  it("varje period har sitt eget pris mot kund", () => {
    const history = priceHistory(
      [
        { titleId: "t-1", unitCostOre: 10_500, validFrom: "2026-10-01" },
        { titleId: "t-1", unitCostOre: 11_000, validFrom: "2026-10-27" },
      ],
      "t-1",
    );
    const timeline = priceTimeline(
      history,
      [],
      "2026-11-02",
      new Map(),
      new Map([
        ["2026-10-01", null],
        ["2026-10-27", 14_500],
      ]),
    );
    expect(timeline.map((e) => [e.validFrom, e.unitCostOre, e.customerPriceOre])).toEqual([
      ["2026-10-27", 11_000, 14_500],
      ["2026-10-01", 10_500, null],
    ]);
    // Utan kartan (äldre anrop) är allt null.
    expect(priceTimeline(history, [], "2026-11-02").every((e) => e.customerPriceOre === null)).toBe(
      true,
    );
  });
});

describe("ändringsloggen", () => {
  const base = { actorId: "u-1", rowId: "r-1" };
  const at = (n: number) => `2026-11-0${n}T10:00:00.000Z`;

  it("bara pris mot kund ändrat blir en egen rad med kundpriset före och efter", () => {
    const events: PriceAuditEvent[] = [
      {
        ...base,
        id: "1",
        action: "insert",
        occurredAt: at(1),
        before: null,
        after: { unitCostOre: 11_000, validFrom: "2026-10-27", note: null },
      },
      {
        ...base,
        id: "2",
        action: "update",
        occurredAt: at(2),
        before: { unitCostOre: 11_000, validFrom: "2026-10-27", note: null },
        after: {
          unitCostOre: 11_000,
          customerPriceOre: 14_500,
          validFrom: "2026-10-27",
          note: null,
        },
      },
    ];
    const log = priceLog(events, { "u-1": "Ägaren" });
    expect(log[0]).toMatchObject({
      kind: "Pris mot kund",
      beforeOre: null,
      afterOre: 14_500,
      customer: { beforeOre: null, afterOre: 14_500 },
    });
    // Den första raden (utan pris mot kund) är som förut.
    expect(log[1]).toMatchObject({ kind: "Nytt pris", afterOre: 11_000 });
    expect(log[1]!.customer).toBeUndefined();
  });

  it("nytt inköpspris med nytt pris mot kund: inköpspriset i kolumnerna, kundpriset bredvid", () => {
    const events: PriceAuditEvent[] = [
      {
        ...base,
        id: "1",
        action: "insert",
        occurredAt: at(1),
        before: null,
        after: {
          unitCostOre: 11_000,
          customerPriceOre: 14_500,
          validFrom: "2026-10-27",
          note: null,
        },
      },
      {
        ...base,
        id: "2",
        action: "update",
        occurredAt: at(2),
        before: {
          unitCostOre: 11_000,
          customerPriceOre: 14_500,
          validFrom: "2026-10-27",
          note: null,
        },
        after: {
          unitCostOre: 11_500,
          customerPriceOre: 14_900,
          validFrom: "2026-10-27",
          note: null,
        },
      },
      {
        ...base,
        id: "3",
        action: "update",
        occurredAt: at(3),
        before: {
          unitCostOre: 11_500,
          customerPriceOre: 14_900,
          validFrom: "2026-10-27",
          note: null,
        },
        after: {
          unitCostOre: 12_000,
          customerPriceOre: 14_900,
          validFrom: "2026-10-27",
          note: null,
        },
      },
    ];
    const log = priceLog(events, {});
    expect(log[2]).toMatchObject({
      kind: "Nytt pris",
      afterOre: 11_000,
      customer: { beforeOre: null, afterOre: 14_500 },
    });
    expect(log[1]).toMatchObject({
      kind: "Ändrat pris",
      beforeOre: 11_000,
      afterOre: 11_500,
      customer: { beforeOre: 14_500, afterOre: 14_900 },
    });
    // Bara inköpspriset ändrat: inget om pris mot kund.
    expect(log[0]).toMatchObject({ kind: "Ändrat pris", beforeOre: 11_500, afterOre: 12_000 });
    expect(log[0]!.customer).toBeUndefined();
  });
});
