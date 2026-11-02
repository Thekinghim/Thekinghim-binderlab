import { describe, expect, it } from "vitest";

import { profitability, storeCompensation, type ProfitabilityInput } from "@/domain";

import {
  agreementState,
  buildStoreRows,
  changeText,
  compensationHeadline,
  listHeadline,
  monthCompensation,
  percentBp,
  placeText,
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
      { id: "o1", externalId: "1", titleId: "t", machineId: "m1", businessDate: "2026-11-01", amountOre: 10_000 },
      { id: "o2", externalId: "2", titleId: "t", machineId: "m1", businessDate: "2026-11-02", amountOre: 5_000 },
      { id: "o3", externalId: "3", titleId: "t", machineId: "m2", businessDate: "2026-11-02", amountOre: 7_000 },
    ],
    prices: [{ titleId: "t", unitCostOre: 2_000, validFrom: "2026-01-01" }],
    agreements: [
      { storeId: "s1", validFrom: "2026-10-01", validTo: null, commissionBp: 1_000, monthlyRentOre: null },
      { storeId: "s2", validFrom: "2026-11-01", validTo: null, commissionBp: null, monthlyRentOre: 30_000 },
    ],
    placements: [
      { machineId: "m1", storeId: "s1", from: "2026-10-01", to: null },
      { machineId: "m2", storeId: "s2", from: "2026-10-01", to: null },
    ],
    settings: { vatRateBp: 0, cardFeeBp: 0 },
  };
}

const agreements = [
  { id: "a1", storeId: "s1", contractId: null, validFrom: "2026-10-01", validTo: null, commissionBp: 1_000, monthlyRentOre: null, note: null },
  { id: "a2", storeId: "s2", contractId: null, validFrom: "2026-11-01", validTo: null, commissionBp: null, monthlyRentOre: 30_000, note: null },
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
    expect(agreementState({ validFrom: "2026-10-01", validTo: null }, "2026-11-02")).toBe("current");
    expect(agreementState({ validFrom: "2026-12-01", validTo: null }, "2026-11-02")).toBe("upcoming");
    expect(agreementState({ validFrom: "2026-01-01", validTo: "2026-11-01" }, "2026-11-02")).toBe("ended");
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
  it("sorterar på intäkt och flaggar butik med automat men utan avtal", () => {
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
    expect(rows[2]!.flag).toBe("Inget avtal i dag");
    expect(rows[2]!.machineCodes).toEqual(["BL-003"]);
    expect(rows[0]!.flag).toBeNull();
    expect(rows[0]!.href).toBe("/butiker/s1?period=30d");
    expect(rows[0]!.current?.termsLabel).toBe(`Provision 10${NB}%`);
  });
  it("rubriken bär intäkten och andelen till butikerna", () => {
    const h = listHeadline(rows, 2);
    expect(h.title).toBe(`3${NB}butiker gav 220${NB}kr på 2${NB}dagar.`);
    expect(h.aside).toContain(`35${NB}kr till butikerna`);
    expect(h.aside).toContain("Kiosken står för 68");
    expect(listHeadline([], 30).title).toBe("Inga butiker ännu.");
  });
});

describe("en butik", () => {
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
    expect(compensationHeadline({ ...m, totalOre: 0 }, null).title).toBe("Inget avtal gäller i dag.");
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
    const ending = toAgreementView(
      { ...agreements[0]!, validTo: "2026-11-20" },
      "2026-11-02",
    );
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
      storeIssues({ agreements: [], machineCodes: ["BL-1"], recipients: [], archived: true, today: "2026-11-02" }),
    ).toEqual([]);
  });
});
