import { describe, expect, it } from "vitest";

import type { StoreAgreement } from "@/domain";

import { machineReadiness, readinessLeft, type MachineReadyFacts } from "./machine-ready";

const STORE = { id: "s1", name: "Sega gubben", from: "2026-10-14" } as const;

function agreement(over: Partial<StoreAgreement> = {}): StoreAgreement {
  return {
    storeId: "s1",
    validFrom: "2026-10-01",
    validTo: null,
    commissionBp: 5000,
    monthlyRentOre: null,
    commissionBase: "profit_after_costs",
    ...over,
  };
}

function facts(over: Partial<MachineReadyFacts> = {}): MachineReadyFacts {
  return {
    machineId: "11111111-1111-4111-8111-111111111111",
    code: "BL-004",
    today: "2026-11-11",
    store: STORE,
    agreements: [agreement()],
    awish: true,
    slotsReadAt: "2026-11-11T08:00:00.000Z",
    titles: [
      { id: "t1", name: "Pokémon 151", hasCapacity: true, hasPrice: true },
      { id: "t2", name: "Mystery Pack", hasCapacity: true, hasPrice: true },
    ],
    investmentOre: 4_500_000,
    firstOrderDate: "2026-10-14",
    ...over,
  };
}

const ids = (r: ReturnType<typeof machineReadiness>, done: boolean) =>
  r.steps.filter((s) => s.done === done).map((s) => s.id);

describe("machineReadiness", () => {
  it("allt inlagt: klart, ingen lista", () => {
    const r = machineReadiness(facts());
    expect(r.complete).toBe(true);
    expect(r.done).toBe(7);
    expect(r.total).toBe(7);
    expect(r.next).toBeNull();
    expect(r.left).toBeNull();
    expect(readinessLeft([r])).toEqual({});
  });

  it("saknar avtal, kostnad och antal per fack: 4 av 7 klart, avtalet är nästa", () => {
    const r = machineReadiness(
      facts({
        agreements: [],
        investmentOre: 0,
        titles: [
          { id: "t1", name: "Pokémon 151", hasCapacity: false, hasPrice: true },
          { id: "t2", name: "Mystery Pack", hasCapacity: true, hasPrice: true },
        ],
      }),
    );
    expect(r.progress).toBe("4 av 7 klart");
    expect(r.headline).toBe("BL-004: 4 av 7 klart. Nästa: lägg in avtalet.");
    expect(ids(r, false)).toEqual(["avtal", "antal", "kostnad"]);
    expect(r.next?.id).toBe("avtal");
    expect(r.next?.href).toBe("/butiker/s1#ersattning");
    expect(r.left?.replace(/ /g, " ")).toBe("3 saker kvar");
    expect(readinessLeft([r])[r.machineId]?.replace(/ /g, " ")).toBe("3 saker kvar");
  });

  it("en sak kvar skrivs i ental", () => {
    const r = machineReadiness(facts({ investmentOre: 0 }));
    expect(r.left?.replace(/ /g, " ")).toBe("1 sak kvar");
    expect(r.next?.href).toBe(
      "/automater/enhetsekonomi?automat=11111111-1111-4111-8111-111111111111&ny=1#investeringar",
    );
  });

  it("utan butik: välj butik först, avtalet väntar på butiken", () => {
    const r = machineReadiness(facts({ store: null, agreements: [] }));
    expect(r.next?.id).toBe("butik");
    expect(r.next?.href).toBe("/automater/bl-004?gor=placera");
    expect(r.steps.find((s) => s.id === "avtal")?.detail).toBe("Välj butik först.");
  });

  it("avtal som börjar senare räknas inte, och texten säger varför", () => {
    const r = machineReadiness(facts({ agreements: [agreement({ validFrom: "2026-12-01" })] }));
    const step = r.steps.find((s) => s.id === "avtal");
    expect(step?.done).toBe(false);
    expect(step?.detail).toContain("har inte börjat");
  });

  it("en automat som ställs ut senare: avtalet ska gälla första dagen där", () => {
    const r = machineReadiness(
      facts({
        store: { ...STORE, from: "2026-12-01" },
        agreements: [agreement({ validFrom: "2026-12-01" })],
      }),
    );
    expect(r.steps.find((s) => s.id === "avtal")?.done).toBe(true);
  });

  it("det man bara kan vänta på blir nästa först när inget annat är kvar", () => {
    const waiting = machineReadiness(
      facts({ slotsReadAt: null, titles: [], firstOrderDate: null, investmentOre: 0 }),
    );
    expect(waiting.next?.id).toBe("kostnad");
    const onlyWait = machineReadiness(facts({ firstOrderDate: null }));
    expect(onlyWait.next?.id).toBe("kop");
    expect(onlyWait.headline).toBe("BL-004: 6 av 7 klart. Nästa: vänta på första köpet.");
    expect(onlyWait.next?.href).toBeNull();
  });

  it("inköpspris saknas: titlarna nämns och länken går till Inköpspriser", () => {
    const r = machineReadiness(
      facts({
        titles: [
          { id: "t1", name: "Pokémon 151", hasCapacity: true, hasPrice: false },
          { id: "t2", name: "Mystery Pack", hasCapacity: true, hasPrice: false },
          { id: "t3", name: "Black Bolt", hasCapacity: true, hasPrice: false },
        ],
      }),
    );
    const step = r.steps.find((s) => s.id === "pris");
    expect(step?.done).toBe(false);
    expect(step?.detail?.replace(/ /g, " ")).toBe("Saknas för Pokémon 151 och 2 till.");
    expect(step?.href).toBe("/inkopspriser?saknar=pris");
  });

  it("utan Awish: sex steg, lagret läggs in för hand", () => {
    const r = machineReadiness(facts({ awish: false, slotsReadAt: null, titles: [] }));
    expect(r.total).toBe(6);
    expect(r.steps.map((s) => s.id)).toEqual(["butik", "avtal", "fack", "pris", "kostnad", "kop"]);
    expect(r.steps.find((s) => s.id === "fack")?.href).toBe("/lager");
  });
});
