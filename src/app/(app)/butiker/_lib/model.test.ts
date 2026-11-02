import { describe, expect, it } from "vitest";

import { profitability, storeCompensation, type ProfitabilityInput } from "@/domain";

import {
  agreementState,
  buildStoreRows,
  changeText,
  compensationHeadline,
  dataCoverage,
  ENDING_SOON_DAYS,
  listHeadline,
  listKpis,
  monthCompensation,
  percentBp,
  placeText,
  spanText,
  storeHeadline,
  storeIssues,
  termsLabel,
  toAgreementView,
} from "./model";

const NB = " ";

/** Två butiker: S1 provision 10 %, S2 hyra 300 kr/mån från 1 nov. Order 1–2 nov. */
function input(): ProfitabilityInput {
  return {
    period: { start: "2026-11-01", end: "2026-11-02" },
    orders: [
      {
        id: "o1",
        externalId: "1",
        titleId: "t",
        machineId: "m1",
        businessDate: "2026-11-01",
        amountOre: 10_000,
      },
      {
        id: "o2",
        externalId: "2",
        titleId: "t",
        machineId: "m1",
        businessDate: "2026-11-02",
        amountOre: 5_000,
      },
      {
        id: "o3",
        externalId: "3",
        titleId: "t",
        machineId: "m2",
        businessDate: "2026-11-02",
        amountOre: 7_000,
      },
    ],
    prices: [{ titleId: "t", unitCostOre: 2_000, validFrom: "2026-01-01" }],
    agreements: [
      {
        storeId: "s1",
        validFrom: "2026-10-01",
        validTo: null,
        commissionBp: 1_000,
        monthlyRentOre: null,
      },
      {
        storeId: "s2",
        validFrom: "2026-11-01",
        validTo: null,
        commissionBp: null,
        monthlyRentOre: 30_000,
      },
    ],
    placements: [
      { machineId: "m1", storeId: "s1", from: "2026-10-01", to: null },
      { machineId: "m2", storeId: "s2", from: "2026-10-01", to: null },
    ],
    settings: { vatRateBp: 0, cardFeeBp: 0 },
  };
}

const agreements = [
  {
    id: "a1",
    storeId: "s1",
    contractId: null,
    validFrom: "2026-10-01",
    validTo: null,
    commissionBp: 1_000,
    monthlyRentOre: null,
    note: null,
  },
  {
    id: "a2",
    storeId: "s2",
    contractId: null,
    validFrom: "2026-11-01",
    validTo: null,
    commissionBp: null,
    monthlyRentOre: 30_000,
    note: null,
  },
].map((a) => toAgreementView(a, "2026-11-02"));

describe("texter", () => {
  it("villkor och procent", () => {
    expect(termsLabel(1_200, null)).toBe(`Provision 12${NB}%`);
    expect(termsLabel(800, 75_000)).toBe(`Provision 8${NB}% · hyra 750${NB}kr/mån`);
    expect(termsLabel(null, 150_000)).toBe(`Hyra 1${NB}500${NB}kr/mån`);
    expect(percentBp(1_250)).toBe(`12,5${NB}%`);
    expect(percentBp(1_225)).toBe(`12,25${NB}%`);
  });
  it("adress utan upprepad ort", () => {
    expect(placeText("Storgatan 1, 222 22 Lund", "Lund")).toBe("Storgatan 1, 222 22 Lund");
    expect(placeText("Storgatan 1", "Lund")).toBe("Storgatan 1, Lund");
    expect(placeText(null, null)).toBeNull();
  });
  it("förändring i ord", () => {
    expect(changeText(11_200, 10_000)).toBe(`12${NB}% mer än`);
    expect(changeText(9_500, 10_000)).toBe(`5,0${NB}% mindre än`);
    expect(changeText(1, 0)).toBeNull();
  });
});

describe("avtalens läge", () => {
  it("gäller, kommande och avslutat", () => {
    expect(agreementState({ validFrom: "2026-10-01", validTo: null }, "2026-11-02")).toBe(
      "current",
    );
    expect(agreementState({ validFrom: "2026-12-01", validTo: null }, "2026-11-02")).toBe(
      "upcoming",
    );
    expect(agreementState({ validFrom: "2026-01-01", validTo: "2026-11-01" }, "2026-11-02")).toBe(
      "ended",
    );
  });
});

describe("listan", () => {
  const result = profitability(input(), "store");
  const comp = storeCompensation(input());
  const rows = buildStoreRows({
    stores: [
      { id: "s1", name: "Kiosken", address: null, city: "Lund", isExample: true, archived: false },
      { id: "s2", name: "Gallerian", address: null, city: null, isExample: false, archived: false },
      { id: "s3", name: "Ny butik", address: null, city: null, isExample: false, archived: false },
    ],
    placements: [
      ...input().placements,
      { machineId: "m3", storeId: "s3", from: "2026-11-01", to: null },
    ],
    machineCodes: new Map([
      ["m1", "BL-001"],
      ["m2", "BL-002"],
      ["m3", "BL-003"],
    ]),
    agreements,
    current: result,
    previous: null,
    earnedMonth: new Map(comp.stores.map((c) => [c.storeId, c.totalOre])),
    recipients: new Map([
      ["s1", [{ id: "r1", name: "A", email: "a@b.se", active: true, lastSentAt: null }]],
    ]),
    today: "2026-11-02",
    query: "?period=30d",
  });

  it("intäkt och ersättning kommer ur beräkningslagret", () => {
    const s1 = rows.find((r) => r.id === "s1")!;
    const s2 = rows.find((r) => r.id === "s2")!;
    expect(s1.revenueOre).toBe(15_000);
    expect(s1.compensationOre).toBe(1_500);
    expect(s1.earnedMonthOre).toBe(1_500);
    // Hyra 300 kr för 2 av 30 dagar = 2 000 öre.
    expect(s2.compensationOre).toBe(2_000);
    expect(s2.earnedMonthOre).toBe(2_000);
    const total = rows.reduce((n, r) => n + r.compensationOre, 0);
    expect(total).toBe(storeCompensation(input()).totalOre);
  });
  it("sorterar på intäkt och flaggar det som kräver åtgärd, som butikens sida", () => {
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
    expect(rows[2]!.issue).toMatchObject({ short: "Inget avtal i dag", level: "critical" });
    expect(rows[2]!.machineCodes).toEqual(["BL-003"]);
    // Gallerian har avtal men ingen tar emot rapporten.
    expect(rows[1]!.issue?.short).toBe("Ingen mottagare");
    expect(rows[0]!.issue).toBeNull();
    expect(rows[0]!.href).toBe("/butiker/s1?period=30d");
    expect(rows[0]!.current?.termsLabel).toBe(`Provision 10${NB}%`);
  });
  it("rubriken bär intäkten och andelen till butikerna", () => {
    const h = listHeadline(rows, `på 2${NB}dagar`);
    expect(h.title).toBe(`3${NB}butiker gav 220${NB}kr på 2${NB}dagar.`);
    expect(h.aside).toContain(`35${NB}kr (15,9${NB}%) till butikerna och vinst`);
    expect(h.aside).toContain("mest från Kiosken (68");
    // En mening i rubrikens andra del.
    expect(h.aside.match(/\.(\s|$)/g)).toHaveLength(1);
    expect(listHeadline([rows[0]!], "i dag").aside).toContain("till butiken och vinst");
    expect(listHeadline([], "i dag").title).toBe("Inga butiker ännu.");
  });

  it("nyckeltalen jämför bara de visade butikerna, och ersättningen är en kostnad", () => {
    const prev = rows.map((r, i) => ({
      ...r,
      previousRevenueOre: r.revenueOre * 2,
      previousCompensationOre: i === 0 ? 3_000 : 99_999,
    }));
    const k = listKpis([prev[0]!], "november");
    const comp = k.find((x) => x.id === "compensation")!;
    // 1 500 mot 3 000 öre = −50 %, inte mot alla butikers ersättning.
    expect(comp.delta).toEqual({ kind: "relative", value: -0.5 });
    expect(comp.invert).toBe(true);
    expect(listKpis(rows, "november").find((x) => x.id === "compensation")!.delta).toBeNull();
    const empty = listKpis([{ ...rows[2]!, revenueOre: 0, compensationOre: 0 }], "november");
    expect(empty.find((x) => x.id === "share")!.value).toBeNull();
  });
});

describe("dagar med data", () => {
  const period = { start: "2026-10-04", end: "2026-11-02" };
  it("från första ordern och till i går när dagens order inte kommit (som Hem)", () => {
    const c = dataCoverage(period, "2026-10-13", "2026-11-02", false);
    expect(c).toEqual({ start: "2026-10-13", end: "2026-11-01" });
    expect(spanText(c, "2026-11-02")).toEqual({ days: 20, text: `på 20${NB}dagar` });
    expect(dataCoverage(period, "2026-10-13", "2026-11-02", true)?.end).toBe("2026-11-02");
    expect(dataCoverage(period, null, "2026-11-02", false)).toBeNull();
    expect(spanText({ start: "2026-11-01", end: "2026-11-01" }, "2026-11-02").text).toBe("i går");
  });
  it("avtal som slutar snart: samma gräns som Avtal", () => {
    expect(ENDING_SOON_DAYS).toBe(90);
  });
});

describe("en butik", () => {
  it("rubriken säger vad vi tjänade och vad butiken fått, utan att blanda ihop dem", () => {
    const h = storeHeadline({
      name: "Kiosken",
      revenueOre: 15_000,
      previousRevenueOre: 10_000,
      profitOre: 9_000,
      span: `på 2${NB}dagar`,
      month: {
        monthLabel: "november",
        start: "2026-11-01",
        end: "2026-11-02",
        days: 2,
        daysInMonth: 30,
        revenueOre: 15_000,
        orders: 2,
        commissionOre: 1_500,
        rentOre: 0,
        totalOre: 1_500,
      },
    });
    expect(h.title).toBe(`Kiosken gav 150${NB}kr på 2${NB}dagar.`);
    expect(h.aside).toBe(
      `50${NB}% mer än perioden innan. Vinst för oss 90${NB}kr efter inköp och ersättning. Butikens ersättning hittills i november är 15${NB}kr.`,
    );
  });

  it("intjänat denna månad och rubriken", () => {
    const comp = storeCompensation(input());
    const m = monthCompensation({
      today: "2026-11-02",
      storeId: "s2",
      result: profitability(input(), "store"),
      compensation: new Map(comp.stores.map((c) => [c.storeId, c])),
    });
    expect(m).toMatchObject({
      monthLabel: "november",
      days: 2,
      daysInMonth: 30,
      revenueOre: 7_000,
      rentOre: 2_000,
      commissionOre: 0,
      totalOre: 2_000,
    });
    const h = compensationHeadline(m, agreements[1]!);
    expect(h.title).toBe(`20${NB}kr intjänat hittills i november.`);
    expect(h.aside).toBe(`Hyra 20${NB}kr för 2 av 30${NB}dagar.`);
    expect(compensationHeadline({ ...m, totalOre: 0 }, null).title).toBe(
      "Inget avtal gäller i dag.",
    );
  });

  it("att göra: inget avtal, slutar snart, kommande, ingen mottagare", () => {
    const none = storeIssues({
      agreements: [],
      machineCodes: ["BL-001"],
      recipients: [],
      archived: false,
      today: "2026-11-02",
    });
    expect(none.map((i) => [i.id, i.level])).toEqual([
      ["no-agreement", "critical"],
      ["no-recipient", "neutral"],
    ]);
    const ending = toAgreementView({ ...agreements[0]!, validTo: "2026-11-20" }, "2026-11-02");
    const soon = storeIssues({
      agreements: [ending],
      machineCodes: ["BL-001"],
      recipients: [{ id: "r", name: "A", email: "a@b.se", active: true, lastSentAt: null }],
      archived: false,
      today: "2026-11-02",
    });
    expect(soon.map((i) => i.id)).toEqual(["ending"]);
    expect(soon[0]!.text).toContain(`18${NB}dagar`);
    const next = toAgreementView(
      { ...agreements[1]!, id: "a3", validFrom: "2026-11-21" },
      "2026-11-02",
    );
    expect(
      storeIssues({
        agreements: [ending, next],
        machineCodes: [],
        recipients: [],
        archived: false,
        today: "2026-11-02",
      }).map((i) => i.id),
    ).toEqual(["upcoming"]);
    expect(
      storeIssues({
        agreements: [],
        machineCodes: ["BL-1"],
        recipients: [],
        archived: true,
        today: "2026-11-02",
      }),
    ).toEqual([]);
  });
});
