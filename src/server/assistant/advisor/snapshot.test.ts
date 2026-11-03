import { describe, expect, it } from "vitest";

import type { AnalyticsOrder } from "@/analytics/todos/types";
import { addDays, type IsoDate } from "@/domain";

import { buildSnapshot, snapshotText, type SnapshotInput } from "./snapshot";

const TODAY = "2026-11-03" as IsoDate;
const ASOF = addDays(TODAY, -1);

let seq = 0;
function order(
  titleId: string,
  machineId: string | null,
  date: IsoDate,
  amountOre: number,
  hour = 14,
): AnalyticsOrder {
  seq += 1;
  return {
    id: `o${seq}`,
    externalId: `x${seq}`,
    titleId,
    machineId,
    businessDate: date,
    amountOre,
    // 14:00 UTC = 15:00 svensk vintertid
    orderedAt: `${date}T${String(hour).padStart(2, "0")}:00:00Z`,
  };
}

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  const orders: AnalyticsOrder[] = [];
  // Föregående 30 dagar: titel A säljer 1/dag i M1 för 79 kr.
  for (let i = 30; i < 60; i++) orders.push(order("A", "M1", addDays(ASOF, -i), 7900));
  // Senaste 30 dagarna: A 2/dag för 89 kr (prishöjning), B 1/dag i M2 för 99 kr.
  for (let i = 0; i < 30; i++) {
    orders.push(order("A", "M1", addDays(ASOF, -i), 8900));
    orders.push(order("A", "M1", addDays(ASOF, -i), 8900, 18));
    orders.push(order("B", "M2", addDays(ASOF, -i), 9900));
  }
  return {
    organizationName: "Test AB",
    today: TODAY,
    timeZone: "Europe/Stockholm",
    now: new Date("2026-11-03T08:00:00Z"),
    sources: {
      prices: [
        { titleId: "A", unitCostOre: 5000, validFrom: "2026-01-01" },
        { titleId: "A", unitCostOre: 5500, validFrom: addDays(ASOF, -10) },
        { titleId: "B", unitCostOre: 6000, validFrom: "2026-01-01" },
      ],
      agreements: [
        {
          storeId: "S1",
          validFrom: "2026-01-01",
          validTo: null,
          commissionBp: 1000,
          monthlyRentOre: null,
        },
      ],
      placements: [
        { machineId: "M1", storeId: "S1", from: "2026-01-01", to: null },
        { machineId: "M2", storeId: "S1", from: "2026-01-01", to: null },
      ],
      settings: { vatRateBp: 0, cardFeeBp: 0 },
    },
    orders,
    titles: [
      { id: "A", name: "Surging Sparks" },
      { id: "B", name: "Prismatic Evolution" },
    ],
    machines: [
      {
        id: "M1",
        name: "Sega gubben",
        code: "BL-001",
        storeId: "S1",
        activeFrom: "2026-01-01",
        activeTo: null,
      },
      {
        id: "M2",
        name: "Automat 2",
        code: "BL-002",
        storeId: "S1",
        activeFrom: "2026-01-01",
        activeTo: null,
      },
    ],
    stores: [{ id: "S1", name: "ICA Test" }],
    machineStock: [
      { machineId: "M1", titleId: "A", onHand: 6 },
      { machineId: "M2", titleId: "B", onHand: 40 },
    ],
    ...overrides,
  };
}

/** Formaterade tal har hårda mellanslag; testerna skriver vanliga. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/[\u00a0\u202f]/g, " ")) as T;
}

describe("buildSnapshot", () => {
  const snap = plain(buildSnapshot(input()));

  it("perioderna slutar i går och jämförs med lika långa perioder före", () => {
    expect(snap.senasteHelaDag).toBe("2026-11-02");
    expect(snap.perioder.d30).toEqual({ start: "2026-10-04", end: "2026-11-02" });
    expect(snap.perioder.foregaende30).toEqual({ start: "2026-09-04", end: "2026-10-03" });
    expect(snap.perioder.d7).toEqual({ start: "2026-10-27", end: "2026-11-02" });
  });

  it("nyckeltal med förändring mot föregående period", () => {
    expect(snap.nyckeltal.d30.order).toBe(90);
    expect(snap.nyckeltal.foregaende30.order).toBe(30);
    expect(snap.nyckeltal.forandring30.order).toBe("+200 %");
    expect(snap.nyckeltal.d7.order).toBe(21);
  });

  it("titlar sorteras på vinst, med pris, inköpspris och order senaste 7 dagarna", () => {
    expect(snap.titlar.map((t) => t.titel)).toEqual(["Surging Sparks", "Prismatic Evolution"]);
    const a = snap.titlar[0]!;
    expect(a.order30).toBe(60);
    expect(a.order7).toBe(14);
    expect(a.pris).toBe("89 kr");
    expect(a.inkopspris).toBe("55 kr");
    expect(a.intaktMotForegaende30).toMatch(/^\+/);
  });

  it("butiksandel = butiksersättning / intäkt", () => {
    expect(snap.butiker).toHaveLength(1);
    expect(snap.butiker[0]!.butik).toBe("ICA Test");
    expect(snap.butiker[0]!.butiksandel).toBe("10,0 %");
  });

  it("veckodagar och timmar i svensk tid", () => {
    expect(snap.veckodagar30.reduce((n, d) => n + d.order, 0)).toBe(90);
    // 14 och 18 UTC: 15/19 efter sommartidens slut (25 okt.), 16/20 före.
    expect(snap.timmar30.map((h) => h.timme)).toEqual(["kl 15", "kl 16", "kl 19", "kl 20"]);
  });

  it("lagerrisk: rader som räcker under 7 dagar", () => {
    // M1/A säljer 2 per dag: 6 i lager räcker 3 dagar. M2/B: 40 dagar, ingen risk.
    expect(snap.lager.riskUnderSjuDagar).toEqual([
      {
        automat: "Sega gubben (BL-001)",
        titel: "Surging Sparks",
        iLager: 6,
        saltPerDag: "2,0",
        dagarKvar: 3,
      },
    ]);
    expect(snap.lager.antalRaderMedRisk).toBe(1);
  });

  it("prisändringar: försäljningspris och inköpspris", () => {
    expect(snap.prisandringar.forsaljningspris).toEqual([
      {
        titel: "Surging Sparks",
        prisFore: "79 kr",
        prisNu: "89 kr",
        orderFore30: 30,
        orderNu30: 60,
      },
    ]);
    expect(snap.prisandringar.inkopspris).toEqual([
      { titel: "Surging Sparks", fran: "2026-10-23", inkopFore: "50 kr", inkopNu: "55 kr" },
    ]);
  });

  it("avvikelser: automat utan försäljning de senaste tre dagarna", () => {
    const recent = input();
    const quiet = buildSnapshot({
      ...recent,
      orders: recent.orders.filter(
        (o) => !(o.machineId === "M2" && o.businessDate >= addDays(ASOF, -2)),
      ),
    });
    expect(quiet.avvikelser.automaterUtanForsaljningTreDagar).toEqual(["Automat 2 (BL-002)"]);
    expect(snap.avvikelser.automaterUtanForsaljningTreDagar).toEqual([]);
  });

  it("är deterministisk och kompakt", () => {
    expect(snapshotText(buildSnapshot(input()))).toBe(snapshotText(buildSnapshot(input())));
    expect(snapshotText(snap).length).toBeLessThan(6000);
  });

  it("tom organisation ger tomma listor, inget fel", () => {
    const empty = buildSnapshot(input({ orders: [], machineStock: [] }));
    expect(empty.nyckeltal.d30.order).toBe(0);
    expect(empty.titlar).toEqual([]);
    expect(empty.lager.riskUnderSjuDagar).toEqual([]);
  });
});
