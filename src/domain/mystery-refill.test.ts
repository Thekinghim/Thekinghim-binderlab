import { describe, expect, it } from "vitest";

import {
  mysteryBatch,
  mysteryBatchesToPack,
  mysteryCapacityShort,
  mysteryEmptyText,
  mysteryNeedsRefill,
  mysteryRefillProblem,
  mysteryRefillQty,
  wholeBatches,
} from "./index";

describe("mystery packs: fylls bara på när facket är tomt, med en hel omgång", () => {
  it("omgången finns bara för giltiga storlekar", () => {
    expect(mysteryBatch(14)).toBe(14);
    expect(mysteryBatch(null)).toBeNull();
    expect(mysteryBatch(undefined)).toBeNull();
    expect(mysteryBatch(0)).toBeNull();
    expect(mysteryBatch(2.5)).toBeNull();
  });

  it("förslaget är 0 medan facket har pack och en hel omgång när det är tomt", () => {
    expect(mysteryRefillQty(3, 14)).toBe(0);
    expect(mysteryRefillQty(1, 14)).toBe(0);
    expect(mysteryRefillQty(0, 14)).toBe(14);
    expect(mysteryRefillQty(-2, 14)).toBe(14);
    expect(mysteryNeedsRefill(1)).toBe(false);
    expect(mysteryNeedsRefill(0)).toBe(true);
  });

  it("varnar när en hel omgång inte får plats", () => {
    expect(mysteryCapacityShort(10, 14)).toBe(true);
    expect(mysteryCapacityShort(14, 14)).toBe(false);
    expect(mysteryCapacityShort(null, 14)).toBe(false);
    expect(mysteryCapacityShort(0, 14)).toBe(false);
  });

  it("avrundar uppåt till hela omgångar", () => {
    expect(wholeBatches(0, 14)).toBe(0);
    expect(wholeBatches(1, 14)).toBe(14);
    expect(wholeBatches(14, 14)).toBe(14);
    expect(wholeBatches(15, 14)).toBe(28);
  });

  it("texten när facket är tomt", () => {
    expect(mysteryEmptyText("Mystery Pack Plus", 14)).toBe(
      "Mystery Pack Plus är slut – fyll på en hel omgång (14 st)",
    );
  });

  it("en påfyllning som bryter regeln får en förklaring", () => {
    expect(mysteryRefillProblem(0, 14, 14)).toBeNull();
    expect(mysteryRefillProblem(3, 14, 14)).toBe("not_empty");
    expect(mysteryRefillProblem(0, 10, 14)).toBe("not_one_batch");
    expect(mysteryRefillProblem(3, 0, 14)).toBeNull();
  });
});

describe("omgångar att packa: planens antal i hela omgångar", () => {
  it("planens pack blir hela omgångar, avrundat uppåt", () => {
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 56 })).toEqual({
      batches: 4,
      packs: 56,
      batchSize: 14,
      readyBatches: 0,
      before: null,
    });
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 5 })?.batches).toBe(1);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 5 })?.packs).toBe(14);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 15 })?.batches).toBe(2);
  });

  it("samma antal som Inköp visar i dag (wholeBatches)", () => {
    for (const batchSize of [1, 6, 14, 20]) {
      for (let planPacks = 0; planPacks <= 90; planPacks++) {
        const plan = mysteryBatchesToPack({ batchSize, planPacks });
        expect(plan?.packs).toBe(wholeBatches(planPacks, batchSize));
        expect(plan!.batches * batchSize).toBe(plan!.packs);
      }
    }
  });

  it("inget att packa: 0 omgångar, inte null", () => {
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 0 })?.batches).toBe(0);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: -14 })?.batches).toBe(0);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: Number.NaN })?.batches).toBe(0);
  });

  it("färdiga pack hemma räknas i hela omgångar, minus räknas som 0", () => {
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 14, packedAtHome: 14 })?.readyBatches,
    ).toBe(1);
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 14, packedAtHome: 27 })?.readyBatches,
    ).toBe(1);
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 14, packedAtHome: -1 })?.readyBatches,
    ).toBe(0);
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 14, packedAtHome: null })?.readyBatches,
    ).toBe(0);
  });

  it("en titel som inte är ett mystery pack ger null", () => {
    expect(mysteryBatchesToPack({ batchSize: null, planPacks: 9 })).toBeNull();
    expect(mysteryBatchesToPack({ batchSize: undefined, planPacks: 9 })).toBeNull();
    expect(mysteryBatchesToPack({ batchSize: 0, planPacks: 9 })).toBeNull();
  });
});

describe("mysteryBatchesToPack räknat från facken (runda 2)", () => {
  const today = "2026-11-10"; // tisdag
  const slot = (onHand: number, emptyOn: string | null, label = "BL-001", isNew = false) => ({
    label,
    onHand,
    emptyOn,
    isNew,
  });

  it("1 automat, 9 pack i facket, 3 om dagen: 1 omgång före den dagen, aldrig 4", () => {
    const plan = mysteryBatchesToPack({
      batchSize: 14,
      planPacks: 56,
      packedAtHome: 0,
      slots: [slot(9, "2026-11-13")],
      today,
    });
    expect(plan).toMatchObject({
      batches: 1,
      packs: 14,
      readyBatches: 0,
      before: "2026-11-13",
      basis: "slots",
    });
    expect(plan?.first).toMatchObject({ label: "BL-001", daysLeft: 3, emptyNow: false });
  });

  it("en omgång ligger klar hemma: inget att packa, och ingen dag", () => {
    const plan = mysteryBatchesToPack({
      batchSize: 14,
      planPacks: 56,
      packedAtHome: 14,
      slots: [slot(9, "2026-11-13")],
      today,
    });
    expect(plan).toMatchObject({ batches: 0, packs: 0, readyBatches: 1, before: null });
    expect(plan?.due).toHaveLength(1);
    expect(plan?.first).toBeNull();
  });

  it("facket räcker längre än en vecka: inget att packa", () => {
    const plan = mysteryBatchesToPack({
      batchSize: 14,
      planPacks: 56,
      slots: [slot(14, "2026-11-22")],
      today,
    });
    expect(plan).toMatchObject({ batches: 0, readyBatches: 0, before: null, due: [] });
  });

  it("exakt 7 dagar räknas, 8 dagar inte", () => {
    const at = (emptyOn: string) =>
      mysteryBatchesToPack({ batchSize: 14, planPacks: 0, slots: [slot(5, emptyOn)], today })
        ?.batches;
    expect(at("2026-11-17")).toBe(1);
    expect(at("2026-11-18")).toBe(0);
  });

  it("tomt fack: en omgång nu, även utan takt", () => {
    const plan = mysteryBatchesToPack({
      batchSize: 14,
      planPacks: 0,
      slots: [slot(0, null)],
      today,
    });
    expect(plan).toMatchObject({ batches: 1, before: today });
    expect(plan?.first).toMatchObject({ emptyNow: true, daysLeft: 0 });
  });

  it("ny automat utan historik och tomt fack: en omgång, märkt som ny", () => {
    const plan = mysteryBatchesToPack({
      batchSize: 14,
      planPacks: 0,
      slots: [slot(0, null, "BL-004", true)],
      today,
    });
    expect(plan?.batches).toBe(1);
    expect(plan?.first).toMatchObject({ label: "BL-004", isNew: true });
  });

  it("ett fack med pack men utan takt behöver ingen omgång", () => {
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 28, slots: [slot(6, null)], today })
        ?.batches,
    ).toBe(0);
  });

  it("flera automater: en omgång per fack, de färdiga hemma täcker de som blir tomma först", () => {
    const plan = mysteryBatchesToPack({
      batchSize: 14,
      planPacks: 0,
      packedAtHome: 20, // en hel omgång (6 över räknas inte)
      slots: [
        slot(9, "2026-11-13", "BL-001"),
        slot(0, null, "BL-002"),
        slot(4, "2026-11-15", "BL-003"),
        slot(14, "2026-12-01", "BL-004"),
      ],
      today,
    });
    expect(plan?.due?.map((d) => d.label)).toEqual(["BL-002", "BL-001", "BL-003"]);
    expect(plan).toMatchObject({ batches: 2, packs: 28, readyBatches: 1, before: "2026-11-13" });
    expect(plan?.first?.label).toBe("BL-001");
  });

  it("inga fack alls (tom lista): 0 omgångar, inte planens antal", () => {
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 56, slots: [], today })).toMatchObject({
      batches: 0,
      packs: 0,
      basis: "slots",
    });
  });

  it("utan facken eller utan dag: planens antal som förut", () => {
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 56 })).toMatchObject({
      batches: 4,
      packs: 56,
      before: null,
    });
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 56 })?.basis).toBeUndefined();
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 56, slots: [slot(9, "2026-11-13")] }),
    ).toMatchObject({ batches: 4, packs: 56 });
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 56, slots: null, today }),
    ).toMatchObject({ batches: 4, packs: 56 });
  });
});
