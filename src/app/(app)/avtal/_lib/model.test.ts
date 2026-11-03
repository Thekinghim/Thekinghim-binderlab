import { describe, expect, it } from "vitest";

import { buildContractRows, contractHeadline, type ContractInput } from "./model";

const TODAY = "2026-11-03";
const stores = [
  { id: "a", name: "Sega gubben" },
  { id: "b", name: "Kafé Ett" },
  { id: "c", name: "Butik Tre" },
  { id: "d", name: "Ny plats" },
];

function contract(p: Partial<ContractInput> & { id: string; storeId: string }): ContractInput {
  return { validFrom: "2026-10-01", validTo: null, hasFile: false, archived: false, ...p };
}

describe("buildContractRows", () => {
  const list = buildContractRows({
    stores,
    contracts: [
      contract({ id: "ka", storeId: "a", template: "t", signedAt: "2026-10-02T10:00:00Z" }),
      contract({ id: "kb", storeId: "b", template: "t", sentAt: "2026-10-02T10:00:00Z" }),
      contract({ id: "old", storeId: "c", validTo: "2026-09-30" }),
      contract({ id: "arch", storeId: "d", archived: true }),
    ],
    agreements: [
      {
        id: "ag",
        storeId: "a",
        contractId: "ka",
        validFrom: "2026-10-01",
        validTo: null,
        commissionBp: 5_000,
        monthlyRentOre: null,
        commissionBase: "profit_after_costs",
      },
      {
        id: "ac",
        storeId: "c",
        contractId: null,
        validFrom: "2026-10-01",
        validTo: null,
        commissionBp: null,
        monthlyRentOre: 100_000,
        commissionBase: "net_excl_vat",
      },
    ],
    reminders: new Map(),
    due: new Set(),
    withMachine: new Set(["a", "b", "c"]),
    today: TODAY,
  });

  it("butik med automat utan signerat kontrakt först och röd; X av Y räknar butiker med automat", () => {
    expect(list.rows.map((r) => [r.storeName, r.status, r.alert])).toEqual([
      ["Butik Tre", "missing", true],
      ["Kafé Ett", "sent", true],
      ["Ny plats", "missing", false],
      ["Sega gubben", "signed", false],
    ]);
    expect(list.signed).toBe(1);
    expect(list.total).toBe(3);
  });

  it("villkoren i klartext: kontraktets, annars butikens", () => {
    const by = new Map(list.rows.map((r) => [r.storeId, r.terms?.replace(/\s/g, " ")]));
    expect(by.get("a")).toBe("50 % av vinsten efter kostnader");
    expect(by.get("c")).toBe("Fast hyra 1 000 kr/mån");
    expect(by.get("b")).toBeUndefined();
  });

  it("påminnelse: signerat som löper ut", () => {
    const due = buildContractRows({
      stores: stores.slice(0, 1),
      contracts: [contract({ id: "ka", storeId: "a", validTo: "2027-01-31" })],
      agreements: [],
      reminders: new Map([["ka", "due"]]),
      due: new Set(["ka"]),
      withMachine: new Set(["a"]),
      today: TODAY,
    });
    expect(due.rows[0]).toMatchObject({ status: "due", alert: false });
  });
});

describe("contractHeadline", () => {
  it("X av Y, alla, en", () => {
    expect(contractHeadline(2, 3)).toBe("2 av 3 butiker har signerat kontrakt.");
    expect(contractHeadline(3, 3)).toBe("Alla 3 butiker har signerat kontrakt.");
    expect(contractHeadline(1, 1)).toBe("Butiken har signerat kontrakt.");
    expect(contractHeadline(0, 1)).toBe("0 av 1 butik har signerat kontrakt.");
    expect(contractHeadline(0, 0)).toBe("Inga butiker än.");
  });
});
