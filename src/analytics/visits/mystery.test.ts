/**
 * Mystery packs i besöksplanen: besök när facket är tomt (inte med marginal före), och då en
 * hel omgång i packlistan, bara om centrallagret har en hel omgång.
 */
import { describe, expect, it } from "vitest";

import { daily } from "@/analytics/todos/test-helpers";

import { planVisits, type VisitPlanInput } from "./index";

const NOW = "2026-11-02T09:00:00Z"; // måndag 2 nov.
const machines = [{ id: "m1", name: "Automat 1", activeFrom: null, activeTo: null }];

function base(onHand: number, p: Partial<VisitPlanInput> = {}): VisitPlanInput {
  return {
    machines,
    titles: [{ id: "mp", name: "Mystery Pack Plus", mysteryBatchSize: 14 }],
    orders: daily("mp", "m1", "2026-10-20", 14, 2),
    stock: [{ machineId: "m1", titleId: "mp", onHand }],
    capacities: [{ machineId: "m1", titleId: "mp", capacity: 20 }],
    ...p,
  };
}

describe("besöksplanen: mystery packs", () => {
  it("tomt fack: besök i dag med exakt en omgång (inte kapaciteten)", () => {
    const plan = planVisits(base(0), NOW);
    const stop = plan.days[0]?.stops[0];
    expect(stop?.needBy).toBe("2026-11-02");
    expect(stop?.packs).toEqual([
      expect.objectContaining({ titleId: "mp", quantity: 14, target: 14, shortBy: 0 }),
    ]);
    expect(stop?.reasons[0]).toBe("Mystery Pack Plus är slut – fyll på en hel omgång (14 st)");
  });

  it("med pack kvar: senast dagen efter beräknat slut, ingen marginal", () => {
    // 5 pack vid 2 per dag (räknat från i dag): slut tor 5 nov. → besök fre 6 nov.
    const plan = planVisits(base(5), NOW);
    const stop = plan.days.flatMap((d) => d.stops)[0];
    expect(stop?.needBy).toBe("2026-11-06");
    // En vanlig titel besöks dagen före slut (marginal 1 dag).
    const plain = planVisits(base(5, { titles: [{ id: "mp", name: "Mystery Pack Plus" }] }), NOW);
    expect(plain.days.flatMap((d) => d.stops)[0]?.needBy).toBe("2026-11-04");
  });

  it("packlistan har inget för ett fack som väntas ha pack kvar vid besöket", () => {
    const plan = planVisits(
      base(20, {
        extraVisits: [{ machineId: "m1", reason: "Misstänkt fel", needBy: "2026-11-02" }],
      }),
      NOW,
    );
    const stop = plan.days.flatMap((d) => d.stops)[0];
    expect(stop?.packs).toEqual([]);
  });

  it("centrallagret har inte en hel omgång: inget tas med, hela omgången saknas", () => {
    const plan = planVisits(base(0, { warehouseStock: [{ titleId: "mp", onHand: 10 }] }), NOW);
    const p = plan.days[0]?.stops[0]?.packs[0];
    expect(p).toMatchObject({ quantity: 0, shortBy: 14 });
  });
});
