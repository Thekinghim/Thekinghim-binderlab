import { describe, expect, it } from "vitest";

import type { AwishWebProduct } from "./web-client";
import { planAwishPush } from "./web-push";

function slot(p: Partial<AwishWebProduct> & { id: number }): AwishWebProduct {
  return {
    id: p.id,
    goodId: p.goodId ?? p.id,
    goodName: p.goodName ?? null,
    status: p.status ?? true,
    currentInventory: p.currentInventory ?? 0,
    capacity: p.capacity ?? null,
    channelName: p.channelName ?? null,
  };
}

describe("planAwishPush", () => {
  it("höjer ett tomt fack till Binderlabs antal", () => {
    const plan = planAwishPush(
      [{ titleName: "Mystery Pack", quantity: 7 }],
      [slot({ id: 12, goodName: "Mystery Pack", currentInventory: 0, capacity: 8 })],
    );
    expect(plan.updates).toEqual([
      {
        productId: 12,
        goodId: 12,
        status: true,
        currentInventory: 7,
        previousInventory: 0,
        titleName: "Mystery Pack",
      },
    ]);
    expect(plan.titlesWithoutSlot).toEqual([]);
  });

  it("lägger bara till skillnaden, aldrig sänker (Awish äger försäljningen)", () => {
    // Binderlab vill ha 5, Awish visar redan 8 (sålt mindre än väntat): rör inte facket.
    const plan = planAwishPush(
      [{ titleName: "A", quantity: 5 }],
      [slot({ id: 1, goodName: "A", currentInventory: 8, capacity: 10 })],
    );
    expect(plan.updates).toEqual([]);
  });

  it("fyller flera fack i ordning upp till kapaciteten", () => {
    // Vill ha 14 totalt; fack 1 har 2/10 (plats 8), fack 2 har 0/10. Lägg 8 i fack 1, 4 i fack 2.
    const plan = planAwishPush(
      [{ titleName: "A", quantity: 14 }],
      [
        slot({ id: 1, goodName: "A", currentInventory: 2, capacity: 10 }),
        slot({ id: 2, goodName: "A", currentInventory: 0, capacity: 10 }),
      ],
    );
    expect(plan.updates).toEqual([
      {
        productId: 1,
        goodId: 1,
        status: true,
        currentInventory: 10,
        previousInventory: 2,
        titleName: "A",
      },
      {
        productId: 2,
        goodId: 2,
        status: true,
        currentInventory: 4,
        previousInventory: 0,
        titleName: "A",
      },
    ]);
  });

  it("summan över facken redan uppnådd: inga uppdateringar", () => {
    const plan = planAwishPush(
      [{ titleName: "A", quantity: 5 }],
      [
        slot({ id: 1, goodName: "A", currentInventory: 3, capacity: 10 }),
        slot({ id: 2, goodName: "A", currentInventory: 3, capacity: 10 }),
      ],
    );
    expect(plan.updates).toEqual([]);
  });

  it("sista facket får resten när kapaciteten är okänd", () => {
    const plan = planAwishPush(
      [{ titleName: "A", quantity: 100 }],
      [slot({ id: 1, goodName: "A", currentInventory: 0, capacity: null })],
    );
    expect(plan.updates[0]?.currentInventory).toBe(100);
  });

  it("matchar titel mot fackets varunamn oavsett skiftläge och extra blanksteg", () => {
    const plan = planAwishPush(
      [{ titleName: "mystery  pack" }].map((t) => ({ titleName: t.titleName, quantity: 3 })),
      [slot({ id: 1, goodName: "Mystery Pack", currentInventory: 0, capacity: 10 })],
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.productId).toBe(1);
  });

  it("rapporterar titlar utan fack i Awish", () => {
    const plan = planAwishPush(
      [{ titleName: "Saknas", quantity: 4 }],
      [slot({ id: 1, goodName: "A", currentInventory: 0, capacity: 10 })],
    );
    expect(plan.updates).toEqual([]);
    expect(plan.titlesWithoutSlot).toEqual(["Saknas"]);
  });
});
