import { describe, expect, it } from "vitest";

import type { PartnerSegment, SplitInput, SplitSlice } from "@/domain";

import { splitView, type SplitViewInput } from "./split-model";

const slice = (over: Partial<SplitSlice> & Pick<SplitSlice, "storeId">): SplitSlice => ({
  payee: over.storeId ? { kind: "store", id: over.storeId } : null,
  month: "2026-10",
  from: "2026-10-01",
  to: "2026-10-31",
  orders: 10,
  grossOre: 0,
  refundsOre: 0,
  costOre: 0,
  unpricedOrders: 0,
  storeShareOre: 0,
  shareSource: "settlement",
  hasAgreement: true,
  ...over,
});

const segment = (over: Partial<PartnerSegment> = {}): PartnerSegment => ({
  agreementId: "pa-1",
  reimburse: true,
  bp: 5_000,
  from: "2026-10-01",
  to: "2026-10-31",
  costOre: 0,
  packs: 0,
  weightOre: 1,
  ...over,
});

const NAMES: Record<string, string> = {
  s1: "Butik 1",
  s2: "Butik 2",
  s3: "Butik 3",
  o1: "Bolaget AB",
};

function view(
  split: Omit<SplitInput, "amountOre" | "expectedNetOre">,
  over: Partial<SplitViewInput> = {},
) {
  return splitView({
    split: { ...split, amountOre: 0, expectedNetOre: 0 },
    feesOre: 0,
    refundsVia: "outside",
    storeName: (id) => NAMES[id] ?? "Butik",
    ownerName: (id) => NAMES[id] ?? "Bolag",
    partnerName: "Partnern",
    ...over,
  });
}

/*
 * Exemplet: ett bolag (o1) med två butiker och en egen butik (s3). Försäljning 1 800 kr,
 * inköp 720 kr, kortavgift 72 kr, moms på vinsten (VMB). Partnern får inköpet tillbaka och
 * 50 % av vinsten.
 *
 *   från Nayax = 1 800 − 72                     = 1 728
 *   butiker    = 200 + 50 (bolaget) + 30 (s3)   =   280
 *   moms       = 20 % × (1 800 − 720)           =   216
 *   vinst      = 1 728 − 280 − 720 − 216        =   512
 *   partner    = 720 + 50 % × 512               =   976
 *   Min andel  = 1 728 − 280 − 976 − 216        =   256
 *   Σ = 256 + 976 + 250 + 216 + 72 + 30 = 1 800 (försäljningen)
 */
const example = (): Omit<SplitInput, "amountOre" | "expectedNetOre"> => ({
  slices: [
    slice({
      storeId: "s1",
      payee: { kind: "store_owner", id: "o1" },
      grossOre: 100_000,
      costOre: 40_000,
      storeShareOre: 20_000,
    }),
    slice({
      storeId: "s2",
      payee: { kind: "store_owner", id: "o1" },
      grossOre: 50_000,
      costOre: 20_000,
      storeShareOre: 5_000,
    }),
    slice({ storeId: "s3", grossOre: 30_000, costOre: 12_000, storeShareOre: 3_000 }),
  ],
  trueUps: [],
  vat: { mode: "vmb", carryInOre: 0, vatRateBp: 2_500 },
  partner: { segments: [segment({ costOre: 72_000, packs: 18 })], carryInOre: 0 },
});

describe("splitView", () => {
  it("delar försäljningen exakt: Min andel först, sedan störst först", () => {
    const v = view(example(), { feesOre: 7_200 });
    expect(v.basisOre).toBe(180_000);
    expect(v.rows.map((r) => [r.key, r.amountOre])).toEqual([
      ["owner", 25_600],
      ["partner", 97_600],
      ["store_owner:o1", 25_000],
      ["vat", 21_600],
      ["fees", 7_200],
      ["store:s3", 3_000],
    ]);
    expect(v.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(v.basisOre);
    expect(v.profitOre).toBe(51_200);
    const partner = v.rows.find((r) => r.kind === "partner")!;
    expect(partner.label).toBe("Partnern");
    expect(partner.partner).toEqual({
      hasAgreement: true,
      reimbOre: 72_000,
      profitShareOre: 25_600,
      bp: 5_000,
      bps: [5_000],
      lossOre: 0,
    });
    expect(v.rows[0]!.shareBp).toBe(1_422);
  });

  it("ett bolag är en rad med sina butiker, en butik utan bolag är sin egen rad", () => {
    const v = view(example(), { feesOre: 7_200 });
    const co = v.rows.find((r) => r.kind === "store_owner")!;
    expect(co.label).toBe("Bolaget AB");
    expect(co.stores).toEqual([
      { storeId: "s1", name: "Butik 1", amountOre: 20_000, displayOre: 20_000 },
      { storeId: "s2", name: "Butik 2", amountOre: 5_000, displayOre: 5_000 },
    ]);
    const own = v.rows.find((r) => r.kind === "store")!;
    expect(own.label).toBe("Butik 3");
    expect(own.stores).toBeUndefined();
  });

  it("utan partneravtal: partnern får 0 och raden säger det, ingen partner hittas på", () => {
    const v = view({ ...example(), partner: null }, { feesOre: 7_200, partnerName: null });
    const partner = v.rows.find((r) => r.kind === "partner")!;
    expect(partner.label).toBe("Partner");
    expect(partner.amountOre).toBe(0);
    expect(partner.partner?.hasAgreement).toBe(false);
    // Hela vinsten (och inköpet, som ägaren betalat) blir ägarens.
    expect(v.rows[0]).toMatchObject({ key: "owner", amountOre: 180_000 - 7_200 - 28_000 - 21_600 });
    expect(v.rows.at(-1)!.key).toBe("partner");
    expect(v.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(180_000);
  });

  it("förlust: ägarens rad blir negativ, partnerns aldrig", () => {
    const split = {
      slices: [slice({ storeId: "s3", grossOre: 10_000, costOre: 9_000, storeShareOre: 2_000 })],
      trueUps: [],
      vat: { mode: "none" as const, carryInOre: 0, vatRateBp: 2_500 },
      partner: { segments: [segment({ costOre: 9_000 })], carryInOre: 0 },
    };
    const v = view(split, { feesOre: 400 });
    // vinst = 9 600 − 2 000 − 9 000 = −1 400; partnern 9 000 − 700 = 8 300.
    expect(v.profitOre).toBe(-1_400);
    expect(v.rows.find((r) => r.kind === "partner")!.amountOre).toBe(8_300);
    expect(v.rows[0]).toMatchObject({ key: "owner", amountOre: -700, displayOre: -700 });
    expect(v.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(10_000);

    // Utan inköp tillbaka och butiken får mer än det som kom in (vinst −2 400): partnerns
    // del av förlusten (−1 200) dras inte här, raden är 0.
    const noReimb = view(
      {
        ...split,
        slices: [{ ...split.slices[0]!, storeShareOre: 12_000 }],
        partner: { segments: [segment({ reimburse: false })], carryInOre: 0 },
      },
      { feesOre: 400 },
    );
    const partner = noReimb.rows.find((r) => r.kind === "partner")!;
    expect(partner.amountOre).toBe(0);
    expect(partner.partner?.lossOre).toBe(-1_200);
    expect(noReimb.rows[0]).toMatchObject({ key: "owner", amountOre: -2_400 });
    expect(noReimb.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(10_000);
  });

  it("återbetalningar: egen rad, dras från ägaren när ägaren betalar dem själv", () => {
    const base = example();
    const slices = base.slices.map((s, i) => (i === 2 ? { ...s, refundsOre: 3_000 } : s));
    const outside = view({ ...base, slices }, { feesOre: 7_200, refundsVia: "outside" });
    const nayax = view({ ...base, slices }, { feesOre: 7_200, refundsVia: "nayax" });
    for (const v of [outside, nayax]) {
      expect(v.rows.find((r) => r.kind === "refunds")!.amountOre).toBe(3_000);
      expect(v.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(180_000);
    }
    // Samma vinst före partnern i båda fallen, så samma partner och ägare.
    expect(outside.rows[0]!.amountOre).toBe(nayax.rows[0]!.amountOre);
  });

  it("öre exakt, kronor på raderna summerar till försäljningen i kronor", () => {
    const split = {
      slices: [
        slice({ storeId: "s1", grossOre: 33_349, costOre: 10_011, storeShareOre: 6_667 }),
        slice({ storeId: "s2", grossOre: 33_351, costOre: 10_013, storeShareOre: 6_669 }),
        slice({ storeId: "s3", grossOre: 33_399, costOre: 10_017, storeShareOre: 6_651 }),
      ],
      trueUps: [],
      vat: { mode: "vmb" as const, carryInOre: 0, vatRateBp: 2_500 },
      partner: { segments: [segment({ costOre: 30_041, bp: 3_333 })], carryInOre: 0 },
    };
    const v = view(split, { feesOre: 4_005 });
    expect(v.basisOre).toBe(100_099);
    expect(v.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(100_099);
    expect(v.basisDisplayOre).toBe(100_100);
    expect(v.rows.reduce((a, r) => a + r.displayOre, 0)).toBe(v.basisDisplayOre);
    for (const r of v.rows) {
      expect(r.displayOre % 100).toBe(0);
      expect(Math.abs(r.displayOre - r.amountOre)).toBeLessThanOrEqual(150);
    }
  });

  it("varnar för order utan inköpspris och andelar som inte gick att räkna", () => {
    const base = example();
    const slices = base.slices.map((s, i) => (i === 0 ? { ...s, unpricedOrders: 3 } : s));
    const v = view(
      { ...base, slices },
      {
        feesOre: 7_200,
        extraWarnings: [{ code: "SHARE_UNKNOWN", storeId: "s2", message: "Saknar pris" }],
      },
    );
    expect(v.unpricedOrders).toBe(3);
    expect(v.shareUnknownStoreIds).toEqual(["s2"]);
  });

  it("ingen försäljning: tomt, inga butiksrader", () => {
    const v = view({ slices: [], trueUps: [], vat: example().vat, partner: null });
    expect(v.empty).toBe(true);
    expect(v.basisOre).toBe(0);
    expect(v.rows.map((r) => r.key)).toEqual(["owner", "partner"]);
    expect(v.rows.every((r) => r.amountOre === 0 && r.shareBp === null)).toBe(true);
  });

  it("ingen försäljning men hyra: inte tomt, ägaren lägger till hyran", () => {
    const v = view({
      slices: [slice({ storeId: "s3", orders: 0, storeShareOre: 58_065 })],
      trueUps: [],
      vat: example().vat,
      partner: null,
    });
    expect(v.empty).toBe(false);
    expect(v.basisOre).toBe(0);
    expect(v.rows[0]).toMatchObject({ key: "owner", amountOre: -58_065, displayOre: -58_100 });
    expect(v.rows.find((r) => r.kind === "store")).toMatchObject({ displayOre: 58_100 });
    expect(v.rows.reduce((a, r) => a + r.displayOre, 0)).toBe(0);
  });

  it("avtalet ändras mitt i perioden: båda andelarna i ordning", () => {
    const v = view({
      ...example(),
      partner: {
        segments: [
          segment({ to: "2026-10-14", costOre: 36_000, weightOre: 1 }),
          segment({ agreementId: "pa-2", reimburse: false, bp: 3_000, from: "2026-10-15" }),
        ],
        carryInOre: 0,
      },
    });
    const p = v.rows.find((r) => r.kind === "partner")!.partner!;
    expect(p.bps).toEqual([5_000, 3_000]);
    expect(p.bp).toBe(3_000);
    expect(p.reimbOre).toBe(36_000);
    expect(v.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(v.basisOre);
  });

  it("bolagets butiker i kronor summerar till bolagets rad i kronor", () => {
    const split = {
      slices: [
        slice({
          storeId: "s1",
          payee: { kind: "store_owner", id: "o1" },
          grossOre: 10_000,
          storeShareOre: 1_049,
        }),
        slice({
          storeId: "s2",
          payee: { kind: "store_owner", id: "o1" },
          grossOre: 10_000,
          storeShareOre: 1_049,
        }),
        slice({
          storeId: "s3",
          payee: { kind: "store_owner", id: "o1" },
          grossOre: 10_000,
          storeShareOre: 1_049,
        }),
      ],
      trueUps: [],
      vat: { mode: "none" as const, carryInOre: 0, vatRateBp: 2_500 },
      partner: null,
    };
    const v = view(split);
    const co = v.rows.find((r) => r.kind === "store_owner")!;
    expect(co.amountOre).toBe(3_147);
    expect(co.stores!.reduce((a, st) => a + st.displayOre, 0)).toBe(co.displayOre);
    for (const st of co.stores!)
      expect(Math.abs(st.displayOre - st.amountOre)).toBeLessThanOrEqual(150);
  });
});
