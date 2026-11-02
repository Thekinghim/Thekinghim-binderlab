import { describe, expect, it } from "vitest";
import type { OrderLine, Placement, Settings } from "@/domain";
import {
  contractCoverage,
  contractReminders,
  contractSuccessor,
  contractTerm,
  expiringRevenueOverview,
  noticeDeadline,
} from "./contracts";
import type { Contract } from "./types";

const norm = (s: string) => s.replace(/ /g, " ").replace(/−/g, "-");
const STORES = [
  { id: "s1", name: "ICA Kvantum" },
  { id: "s2", name: "Lekia" },
  { id: "s3", name: "Coop" },
  { id: "s4", name: "Pressbyrån" },
];

function contract(partial: Partial<Contract> & Pick<Contract, "id">): Contract {
  return {
    storeId: "s1",
    validFrom: "2026-04-01",
    validTo: "2027-03-31",
    noticeMonths: 3,
    ...partial,
  };
}

describe("noticeDeadline", () => {
  it("månadsslut ger månadsslut, annars samma dag kapad; dagar dras efteråt", () => {
    expect(noticeDeadline("2027-03-31", 3)).toBe("2026-12-31");
    expect(noticeDeadline("2027-06-30", 3)).toBe("2027-03-31");
    expect(noticeDeadline("2027-02-28", 1)).toBe("2027-01-31");
    expect(noticeDeadline("2027-06-15", 3)).toBe("2027-03-15");
    expect(noticeDeadline("2027-05-30", 3)).toBe("2027-02-28");
    expect(noticeDeadline("2027-03-31", 0, 30)).toBe("2027-03-01");
    expect(noticeDeadline("2027-03-31")).toBe("2027-03-31");
    expect(() => noticeDeadline("2027-03-31", -1)).toThrow();
  });
});

describe("contractTerm och påminnelser", () => {
  it("påminnelse 90 dagar före sista uppsägningsdag: slut 31 mars 2027, 3 mån → säg upp senast 31 dec., påminn 2 okt.", () => {
    const t = contractTerm(contract({ id: "c1" }), "2026-11-02");
    expect(t).toEqual({
      contractId: "c1",
      storeId: "s1",
      termStart: "2026-04-01",
      currentEnd: "2027-03-31",
      noticeDeadline: "2026-12-31",
      reminderDate: "2026-10-02",
      renews: false,
      nextEnd: null,
      renewals: 0,
    });
    const r = contractReminders({
      contracts: [contract({ id: "c1" })],
      asOf: "2026-11-02",
      stores: STORES,
    });
    const rem = r.reminders[0]!;
    expect(rem.status).toBe("due");
    expect(rem.daysToDeadline).toBe(59);
    expect(rem.daysToEnd).toBe(149);
    expect(norm(rem.title)).toBe("Avtalet med ICA Kvantum löper ut 31 mars 2027");
    expect(norm(rem.detail)).toBe(
      "Säg upp eller omförhandla senast 31 dec. 2026 (3 månaders uppsägningstid), om 59 dagar.",
    );
    expect(rem.evidence.contractIds).toEqual(["c1"]);
    expect(rem.evidence.dates).toEqual(["2026-10-02", "2026-12-31", "2027-03-31"]);
    expect(r.due.map((d) => d.contractId)).toEqual(["c1"]);
    expect(norm(r.summary)).toBe(
      "1 avtal behöver åtgärdas. Först: avtalet med ICA Kvantum löper ut 31 mars 2027, säg upp senast 31 dec. 2026.",
    );
  });

  it("utan uppsägningstid: påminnelse precis 90 dagar före slutet", () => {
    const c = contract({ id: "c", validTo: "2027-01-31", noticeMonths: 0 });
    expect(contractTerm(c, "2026-11-02").reminderDate).toBe("2026-11-02");
    const before = contractReminders({ contracts: [c], asOf: "2026-11-01" }).reminders[0]!;
    expect(before.status).toBe("scheduled");
    expect(norm(before.detail)).toContain("Påminnelse 2 nov. 2026");
    expect(contractReminders({ contracts: [c], asOf: "2026-11-02" }).reminders[0]!.status).toBe(
      "due",
    );
  });

  it("påminnelse räknad från slutet i stället för sista uppsägningsdag", () => {
    const t = contractTerm(contract({ id: "c" }), "2026-11-02", {
      reminderBasis: "end",
      reminderLeadDays: 30,
    });
    expect(t.reminderDate).toBe("2027-03-01");
  });

  it("automatisk förlängning: avtalet 2024–2025 med 12 månaders förlängning gäller nu t.o.m. 31 mars 2027", () => {
    const c = contract({
      id: "r",
      validFrom: "2024-04-01",
      validTo: "2025-03-31",
      renewalMonths: 12,
    });
    const t = contractTerm(c, "2026-11-02");
    expect([t.termStart, t.currentEnd, t.noticeDeadline, t.renews, t.nextEnd, t.renewals]).toEqual([
      "2026-04-01",
      "2027-03-31",
      "2026-12-31",
      true,
      "2028-03-31",
      2,
    ]);
    const rem = contractReminders({ contracts: [c], asOf: "2026-11-02", stores: STORES })
      .reminders[0]!;
    expect(norm(rem.detail)).toContain("Annars förlängs det med 12 månader till 31 mars 2028.");

    const after = contractReminders({ contracts: [c], asOf: "2027-01-15", stores: STORES });
    expect(after.reminders[0]!.status).toBe("notice-passed");
    expect(norm(after.reminders[0]!.title)).toBe(
      "Avtalet med ICA Kvantum förlängs till 31 mars 2028",
    );
    expect(after.due).toEqual([]);
  });

  it("förlängning över skottdag: slut 28 feb. 2027 + 12 månader → 29 feb. 2028", () => {
    const c = contract({
      id: "l",
      validFrom: "2026-03-01",
      validTo: "2027-02-28",
      renewalMonths: 12,
      noticeMonths: 0,
    });
    expect(contractTerm(c, "2027-03-01").currentEnd).toBe("2028-02-29");
  });

  it("uppsagt i tid: förlängs inte, upphör vid periodens slut", () => {
    const c = contract({
      id: "t",
      validFrom: "2024-04-01",
      validTo: "2025-03-31",
      renewalMonths: 12,
      terminatedOn: "2026-10-15",
    });
    const t = contractTerm(c, "2026-11-02");
    expect([t.currentEnd, t.renews, t.nextEnd]).toEqual(["2027-03-31", false, null]);
    const rem = contractReminders({ contracts: [c], asOf: "2026-11-02", stores: STORES })
      .reminders[0]!;
    expect(rem.status).toBe("terminated");
    expect(norm(rem.title)).toBe("Avtalet med ICA Kvantum är uppsagt och upphör 31 mars 2027");
  });

  it("uppsagt för sent: gäller en period till", () => {
    const c = contract({
      id: "t",
      validTo: "2027-03-31",
      renewalMonths: 12,
      terminatedOn: "2027-01-10",
    });
    const t = contractTerm(c, "2027-02-01");
    expect([t.currentEnd, t.renews]).toEqual(["2027-03-31", true]);
    expect(contractTerm(c, "2027-04-01").currentEnd).toBe("2028-03-31");
    expect(contractTerm(c, "2027-04-01").renews).toBe(false);
  });

  it("uppsägningstiden passerad utan förlängning, utgånget, tills vidare och ej påbörjat", () => {
    const res = contractReminders({
      asOf: "2027-01-15",
      stores: STORES,
      contracts: [
        contract({ id: "passed", storeId: "s1" }),
        contract({ id: "gone", storeId: "s2", validTo: "2026-09-30" }),
        contract({ id: "open", storeId: "s3", validTo: null, noticeMonths: 1 }),
        contract({ id: "future", storeId: "s4", validFrom: "2027-02-01", validTo: null }),
      ],
    });
    const by = new Map(res.reminders.map((r) => [r.contractId, r]));
    expect(by.get("passed")!.status).toBe("notice-passed");
    expect(norm(by.get("passed")!.detail)).toContain("Avtalet slutar om 75 dagar");
    expect(by.get("gone")!.status).toBe("expired");
    expect(norm(by.get("gone")!.title)).toBe("Avtalet med Lekia gick ut 30 sep. 2026");
    expect(by.get("open")!.status).toBe("open-ended");
    expect(norm(by.get("open")!.detail)).toBe("1 månads uppsägningstid.");
    expect(by.get("future")!.status).toBe("not-started");
    expect(res.due.map((d) => d.contractId)).toEqual(["passed"]);
    expect(norm(res.summary)).toContain("1 avtal har gått ut.");
    // Sorterat på sista uppsägningsdag/slut.
    expect(res.reminders.map((r) => r.contractId)).toEqual(["gone", "passed", "future", "open"]);
  });

  it("ogiltiga avtal", () => {
    expect(() => contractTerm(contract({ id: "x", validTo: "2026-01-01" }), "2026-11-02")).toThrow(
      /slutar/,
    );
    expect(() => contractTerm(contract({ id: "x", renewalMonths: 0 }), "2026-11-02")).toThrow(
      /minst 1/,
    );
    expect(() =>
      contractReminders({
        contracts: [contract({ id: "a" }), contract({ id: "a" })],
        asOf: "2026-11-02",
      }),
    ).toThrow(/två gånger/);
    expect(contractReminders({ contracts: [], asOf: "2026-11-02" }).summary).toBe(
      "Inget avtal behöver sägas upp eller omförhandlas nu.",
    );
  });
});

describe("expiringRevenueOverview", () => {
  const settings: Settings = { vatRateBp: 0, cardFeeBp: 0 };
  const placements: Placement[] = [
    { machineId: "m1", storeId: "s1", from: "2025-01-01", to: null },
    { machineId: "m2", storeId: "s2", from: "2025-01-01", to: null },
    { machineId: "m3", storeId: "s3", from: "2025-01-01", to: null },
  ];
  let n = 0;
  const o = (machineId: string | null, date: string, amountOre = 10_000): OrderLine => ({
    id: `o${++n}`,
    externalId: String(n),
    titleId: "t1",
    machineId,
    businessDate: date,
    amountOre,
  });
  const orders = [
    o("m1", "2026-06-01"),
    o("m1", "2026-07-01"),
    o("m1", "2025-11-02"), // första dagen i fönstret
    o("m2", "2026-03-01"),
    o("m2", "2026-11-01"), // sista dagen i fönstret
    o("m3", "2026-08-01"),
    o("m4", "2026-08-01"), // automat utan placering
    o("m1", "2025-11-01"), // före fönstret
    o("m1", "2026-11-02"), // i dag, efter fönstret
  ];
  const contracts: Contract[] = [
    contract({
      id: "c1",
      storeId: "s1",
      validFrom: "2024-04-01",
      validTo: "2025-03-31",
      renewalMonths: 12,
    }),
    contract({ id: "c2", storeId: "s2", validFrom: "2025-01-01", validTo: "2028-06-30" }),
    contract({ id: "c3-old", storeId: "s3", validFrom: "2025-01-01", validTo: "2026-06-30" }),
    contract({ id: "c4", storeId: "s4", validFrom: "2025-01-01", validTo: null }),
  ];
  const base = {
    contracts,
    orders,
    prices: [],
    agreements: [],
    placements,
    settings,
    asOf: "2026-11-02",
    stores: STORES,
  };

  it("43 % av intäkten ligger på avtal som löper ut inom 12 månader", () => {
    const r = expiringRevenueOverview(base);
    expect(r.window).toEqual({ start: "2025-11-02", end: "2026-11-01" });
    expect(r.horizonEnd).toBe("2027-11-02");
    expect(r.totalRevenueOre).toBe(70_000);
    expect(r.expiringRevenueOre).toBe(30_000);
    expect(r.expiringShareBp).toBe(4286);
    expect(r.renewingRevenueOre).toBe(30_000);
    expect(r.noContractRevenueOre).toBe(10_000);
    expect(r.noContractShareBp).toBe(1429);
    expect(r.noStoreRevenueOre).toBe(10_000);
    expect(
      r.stores.map((s) => [s.storeId, s.category, s.revenueOre, s.contractId, s.currentEnd]),
    ).toEqual([
      ["s1", "expiring", 30_000, "c1", "2027-03-31"],
      ["s2", "secure", 20_000, "c2", "2028-06-30"],
      ["s3", "no-contract", 10_000, null, null],
      ["s4", "secure", 0, "c4", null],
    ]);
    expect(norm(r.summary)).toBe(
      "43 % av intäkten de senaste 12 månaderna (300 kr av 700 kr) ligger på avtal som löper ut inom 12 månader: ICA Kvantum 43 % (slutar 31 mars 2027). 300 kr av det förlängs automatiskt om ingen säger upp. 100 kr (14 %) kommer från butiker utan gällande avtal: Coop.",
    );
    expect(r.evidence.storeIds).toEqual(["s1"]);
    expect(r.evidence.contractIds).toEqual(["c1"]);
  });

  it("avtal som slutar precis vid horisonten räknas; dagen efter gör det inte", () => {
    const at = expiringRevenueOverview({
      ...base,
      contracts: [
        contract({ id: "c2", storeId: "s2", validFrom: "2025-01-01", validTo: "2027-11-02" }),
      ],
    });
    expect(at.stores.find((s) => s.storeId === "s2")!.category).toBe("expiring");
    const after = expiringRevenueOverview({
      ...base,
      contracts: [
        contract({ id: "c2", storeId: "s2", validFrom: "2025-01-01", validTo: "2027-11-03" }),
      ],
    });
    expect(after.stores.find((s) => s.storeId === "s2")!.category).toBe("secure");
  });

  it("ett nytt avtal som ersatt ett gammalt används", () => {
    const r = expiringRevenueOverview({
      ...base,
      contracts: [
        ...contracts,
        contract({ id: "c3-new", storeId: "s3", validFrom: "2026-07-01", validTo: null }),
      ],
    });
    expect(r.stores.find((s) => s.storeId === "s3")!).toMatchObject({
      category: "secure",
      contractId: "c3-new",
    });
    expect(r.noContractRevenueOre).toBe(0);
  });

  it("utan intäkt", () => {
    const r = expiringRevenueOverview({ ...base, orders: [] });
    expect(r.expiringShareBp).toBeNull();
    expect(r.summary).toBe("Ingen intäkt de senaste 12 månaderna.");
  });

  it("inga avtal löper ut", () => {
    const r = expiringRevenueOverview({
      ...base,
      contracts: [contracts[1]!],
      orders: orders.filter((x) => x.machineId === "m2"),
    });
    expect(norm(r.summary)).toBe("Inget avtal med intäkt löper ut före 2 nov. 2027.");
  });
});

describe("redan tecknat efterföljande avtal", () => {
  const ASOF = "2026-11-02";
  // Gammalt: 1 apr. 2025 – 31 mars 2027, 3 mån → sista dag 31 dec. 2026, påminnelse 2 okt. (due).
  const old = contract({ id: "k1", validFrom: "2025-04-01", validTo: "2027-03-31" });
  const next = contract({ id: "k8", validFrom: "2027-04-01", validTo: "2029-03-31" });

  it("påminnelsen för det gamla avtalet behövs inte när ett nytt tar vid utan lucka", () => {
    const r = contractReminders({ contracts: [old, next], asOf: ASOF, stores: STORES });
    const k1 = r.reminders.find((x) => x.contractId === "k1")!;
    expect(k1.status).toBe("scheduled");
    expect(k1.successor).toEqual({
      contractId: "k8",
      validFrom: "2027-04-01",
      currentEnd: "2029-03-31",
    });
    expect(norm(k1.title)).toBe("Avtalet med ICA Kvantum ersätts 1 apr. 2027");
    expect(norm(k1.detail)).toBe(
      "Nuvarande avtal slutar 31 mars 2027. Nytt avtal gäller från 1 apr. 2027 till 31 mars 2029.",
    );
    expect(k1.evidence.contractIds).toEqual(["k1", "k8"]);
    expect(r.due).toEqual([]);
    expect(r.reminders.find((x) => x.contractId === "k8")!.status).toBe("not-started");
  });

  it("med lucka (nytt från 1 maj) är det gamla fortfarande att åtgärda", () => {
    const gap = { ...next, validFrom: "2027-05-01" };
    const r = contractReminders({ contracts: [old, gap], asOf: ASOF, stores: STORES });
    expect(r.due.map((x) => x.contractId)).toEqual(["k1"]);
    expect(r.due[0]!.successor).toBeNull();
  });

  it("förlängs det gamla automatiskt måste det fortfarande sägas upp", () => {
    const renewing = { ...old, renewalMonths: 12 };
    const r = contractReminders({ contracts: [renewing, next], asOf: ASOF, stores: STORES });
    const k1 = r.reminders.find((x) => x.contractId === "k1")!;
    expect(k1.status).toBe("due");
    expect(norm(k1.detail)).toBe(
      "Nytt avtal gäller från 1 apr. 2027 till 31 mars 2029. Säg upp det här avtalet senast " +
        "31 dec. 2026 (3 månaders uppsägningstid), om 59 dagar, så att det inte förlängs.",
    );
  });

  it("contractSuccessor och contractCoverage följer kedjan", () => {
    const third = contract({ id: "k9", validFrom: "2029-04-01", validTo: null });
    const all = [third, next, old];
    const t = contractTerm(old, ASOF);
    expect(contractSuccessor(old, t, all, ASOF)?.contract.id).toBe("k8");
    const cov = contractCoverage(old, t, all, ASOF);
    expect(cov.chain.map((c) => c.id)).toEqual(["k1", "k8", "k9"]);
    expect(cov.coveredUntil).toBeNull();
    // Ett "nytt" avtal som slutar före det gamla förlänger ingenting.
    const shorter = contract({ id: "k2", validFrom: "2026-01-01", validTo: "2027-01-31" });
    expect(contractSuccessor(old, t, [old, shorter], ASOF)).toBeNull();
    // Annan butik räknas inte.
    expect(contractSuccessor(old, t, [old, { ...next, storeId: "s2" }], ASOF)).toBeNull();
  });

  it("översikten räknar butiken som säker när det nya avtalet gäller bortom horisonten", () => {
    const settings: Settings = { vatRateBp: 0, cardFeeBp: 0 };
    const input = {
      orders: [
        {
          id: "x1",
          externalId: "1",
          titleId: "t1",
          machineId: "m1",
          businessDate: "2026-06-01",
          amountOre: 10_000,
        },
      ],
      prices: [],
      agreements: [],
      placements: [{ machineId: "m1", storeId: "s1", from: "2025-01-01", to: null }],
      settings,
      asOf: ASOF,
      stores: STORES,
    };
    const secure = expiringRevenueOverview({ ...input, contracts: [old, next] });
    expect(secure.stores[0]).toMatchObject({
      storeId: "s1",
      category: "secure",
      contractId: "k1",
      currentEnd: "2027-03-31",
      coveredUntil: "2029-03-31",
      successorIds: ["k8"],
    });
    expect(secure.expiringRevenueOre).toBe(0);
    expect(secure.stores[0]!.evidence.contractIds).toEqual(["k1", "k8"]);

    // Det nya avtalet slutar 30 sep. 2027, inom horisonten 2 nov. 2027 → löper ut, med det slutet.
    const short = { ...next, validTo: "2027-09-30" };
    const expiring = expiringRevenueOverview({ ...input, contracts: [old, short] });
    expect(expiring.stores[0]).toMatchObject({ category: "expiring", coveredUntil: "2027-09-30" });
    expect(expiring.evidence.contractIds).toEqual(["k1", "k8"]);
    expect(norm(expiring.summary)).toBe(
      "100 % av intäkten de senaste 12 månaderna (100 kr av 100 kr) ligger på avtal som löper ut " +
        "inom 12 månader: ICA Kvantum 100 % (slutar 30 sep. 2027).",
    );
  });
});
