import { describe, expect, it } from "vitest";

import {
  buildContractRows,
  contractHeadline,
  revenueRiskHeadline,
  startHint,
  uncoveredSales,
  uncoveredText,
  type ContractInput,
} from "./model";

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

describe("uncoveredSales (Sega gubben sålde från 14\u00a0okt., kontraktet gäller från 3\u00a0nov.)", () => {
  const sega = [{ id: "a", name: "Sega gubben" }];
  const sales = new Map([["a", { firstSale: "2026-10-14", lastSale: "2026-11-03" }]]);

  it("osignerat kontrakt från 3\u00a0nov.: hela försäljningen saknar signerat kontrakt", () => {
    const u = uncoveredSales({
      stores: sega,
      sales,
      contracts: [
        contract({ id: "k", storeId: "a", validFrom: "2026-11-03", template: "t", sentAt: "x" }),
      ],
      today: "2026-11-04",
    });
    expect(u).toEqual([
      {
        storeId: "a",
        storeName: "Sega gubben",
        from: "2026-10-14",
        to: "2026-11-03",
        unsignedId: "k",
        unsignedFrom: "2026-11-03",
      },
    ]);
    expect(uncoveredText(u[0]!, "2026-11-04")).toBe(
      "Sega gubben har sålt 14\u00a0okt. – 3\u00a0nov. utan signerat kontrakt. Kontraktet gäller först från 3\u00a0nov.: ändra startdagen och signera.",
    );
  });

  it("signerat från 3\u00a0nov.: luckan är 14\u00a0okt. – 2 nov.", () => {
    const u = uncoveredSales({
      stores: sega,
      sales,
      contracts: [
        contract({ id: "k", storeId: "a", validFrom: "2026-11-03", template: "t", signedAt: "x" }),
      ],
      today: "2026-11-04",
    });
    expect(u.map((x) => [x.from, x.to, x.unsignedId])).toEqual([
      ["2026-10-14", "2026-11-02", null],
    ]);
    expect(uncoveredText(u[0]!, "2026-11-04")).toContain("Skapa ett kontrakt för den tiden.");
  });

  it("signerat från första försäljningen: ingen varning; utan försäljning: ingen varning", () => {
    expect(
      uncoveredSales({
        stores: sega,
        sales,
        contracts: [contract({ id: "k", storeId: "a", validFrom: "2026-10-14", template: null })],
        today: "2026-11-04",
      }),
    ).toEqual([]);
    expect(
      uncoveredSales({ stores: sega, sales: new Map(), contracts: [], today: "2026-11-04" }),
    ).toEqual([]);
  });

  it("arkiverade kontrakt täcker inget; utan kontrakt står butiken redan som Saknas", () => {
    const u = uncoveredSales({
      stores: sega,
      sales,
      contracts: [
        contract({
          id: "x",
          storeId: "a",
          validFrom: "2026-10-01",
          template: null,
          archived: true,
        }),
        contract({ id: "k", storeId: "a", validFrom: "2026-11-03", template: "t" }),
      ],
      today: "2026-11-04",
    });
    expect(u.map((x) => x.from)).toEqual(["2026-10-14"]);
    expect(uncoveredSales({ stores: sega, sales, contracts: [], today: "2026-11-04" })).toEqual([]);
  });
});

describe("revenueRiskHeadline (0,0 % i riskzonen fast inget var signerat)", () => {
  it("intäkt utan signerat kontrakt står först", () => {
    expect(
      revenueRiskHeadline({
        totalRevenueOre: 8_472_500,
        expiringShareBp: 0,
        noContractShareBp: 10_000,
        noContractRevenueOre: 8_472_500,
      }),
    ).toBe("100\u00a0% av intäkten saknar signerat kontrakt.");
  });
  it("allt signerat: andelen som löper ut", () => {
    expect(
      revenueRiskHeadline({
        totalRevenueOre: 100,
        expiringShareBp: 2_500,
        noContractShareBp: 0,
        noContractRevenueOre: 0,
      }),
    ).toBe("25\u00a0% av intäkten löper ut inom 12 mån.");
  });
});

describe("startHint", () => {
  it("varnar när kontraktet börjar efter första försäljningen", () => {
    expect(startHint("2026-10-14", "2026-11-03", "2026-11-04")).toBe(
      "Automaten har sålt sedan 14\u00a0okt. Den försäljningen täcks inte.",
    );
    expect(startHint("2026-10-14", "2026-10-14", "2026-11-04")).toBe(
      "Täcker försäljningen sedan 14\u00a0okt.",
    );
    expect(startHint(null, "2026-11-03", "2026-11-04")).toBeUndefined();
  });
});
