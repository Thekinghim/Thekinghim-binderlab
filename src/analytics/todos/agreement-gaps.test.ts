import { describe, expect, it } from "vitest";

import { agreementGaps } from "@/domain";

import { agreementGapTodos, mergeAgreementTodos } from "./agreement-gaps";
import { createTodoContext } from "./context";
import { computeTodos } from "./index";
import { missingContractTodos } from "./missing-contract";
import type { TodoInput } from "./types";

const placements = [
  { machineId: "m1", storeId: "s1", from: "2026-10-01", to: null },
  { machineId: "m3", storeId: "s3", from: "2026-10-27", to: null },
];

const base: TodoInput = {
  orders: [],
  prices: [],
  agreements: [
    {
      storeId: "s1",
      validFrom: "2026-01-01",
      validTo: "2026-10-09",
      commissionBp: 1_000,
      monthlyRentOre: null,
    },
    {
      storeId: "s1",
      validFrom: "2026-10-13",
      validTo: null,
      commissionBp: 1_000,
      monthlyRentOre: null,
    },
  ],
  placements,
  settings: { vatRateBp: 0, cardFeeBp: 0 },
  titles: [],
  machines: [
    { id: "m1", name: "Automat 1", code: "BL-001", activeFrom: null, activeTo: null },
    { id: "m3", name: "Automat 3", code: "BL-003", activeFrom: null, activeTo: null },
  ],
  stores: [
    { id: "s1", name: "Kiosken" },
    { id: "s3", name: "Hörnan" },
  ],
  stock: [],
  reportRecipients: [],
  reportDeliveries: [],
};

const at = (iso: string) => new Date(`${iso}T10:00:00Z`);
const plain = (t: string) => t.replace(/ /g, " ");
const gaps = agreementGaps({
  placements: base.placements,
  agreements: base.agreements,
  period: { start: "2026-10-01", end: "2026-11-03" },
});

describe("agreementGapTodos (butik med automat utan avtal)", () => {
  it("hela tiden utan avtal: nu; några dagar: snart, med dagarna", () => {
    const todos = agreementGapTodos(
      createTodoContext({ ...base, agreementGaps: gaps }, at("2026-11-03")),
    );
    const hornan = todos.find((t) => t.key === "agreement:s3")!;
    expect(plain(hornan.title)).toBe("Hörnan har inget avtal – räknas som 0 %");
    expect(hornan.level).toBe("now");
    expect(hornan.kind).toBe("agreement");
    expect(hornan.link).toBe("/butiker/s3?vy=avtal");
    expect(hornan.evidence.machineIds).toEqual(["m3"]);
    const kiosk = todos.find((t) => t.key === "agreement:s1")!;
    expect(plain(kiosk.title)).toBe("Kiosken: inget avtal 3 dagar – 0 % de dagarna");
    expect(kiosk.level).toBe("soon");
    expect(plain(kiosk.detail)).toContain("10 okt.–12 okt.");
  });

  it("utan underlag: inga punkter (påfyllaren, eller inga luckor)", () => {
    expect(agreementGapTodos(createTodoContext(base, at("2026-11-03")))).toEqual([]);
  });

  it("utan kontrakt och utan avtal: EN punkt (Skapa kontrakt lägger in avtalet)", () => {
    const ctx = createTodoContext(
      { ...base, agreementGaps: gaps, contracts: [] },
      at("2026-11-03"),
    );
    const contracts = missingContractTodos(ctx);
    expect(contracts.map((t) => t.key).sort()).toEqual([
      "contract-missing:s1",
      "contract-missing:s3",
    ]);
    const merged = mergeAgreementTodos(contracts, agreementGapTodos(ctx));
    expect(merged.agreements).toEqual([]);
    const hornan = merged.contracts.find((t) => t.key === "contract-missing:s3")!;
    expect(plain(hornan.title)).toBe("Hörnan saknar kontrakt och avtal – räknas som 0 %");
    expect(hornan.level).toBe("now");
    expect(hornan.action?.label).toBe("Skapa kontrakt");
    const kiosk = merged.contracts.find((t) => t.key === "contract-missing:s1")!;
    expect(plain(kiosk.title)).toBe(
      "Kiosken saknar kontrakt; inget avtal 3 dagar – 0 % de dagarna",
    );
    // I computeTodos: inga dubbletter för samma butik.
    const all = computeTodos({ ...base, agreementGaps: gaps, contracts: [] }, at("2026-11-03"));
    expect(all.filter((t) => t.evidence.storeIds.includes("s3")).map((t) => t.kind)).toEqual([
      "contract",
    ]);
  });
});
