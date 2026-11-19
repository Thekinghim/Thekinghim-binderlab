/** Pushen till Awish för mystery packs: bara tomma fack fylls, med omgången. */
import { describe, expect, it } from "vitest";

import type { AwishWebProduct } from "./web-client";
import { planAwishPush } from "./web-push";

function slot(p: Partial<AwishWebProduct> & { id: number }): AwishWebProduct {
  return {
    id: p.id,
    goodId: p.goodId ?? p.id,
    goodName: p.goodName ?? "Mystery Pack Plus",
    status: p.status ?? true,
    currentInventory: p.currentInventory ?? 0,
    capacity: p.capacity ?? null,
    channelName: p.channelName ?? null,
  };
}

describe("planAwishPush: mystery packs", () => {
  it("tomt fack fylls med omgången", () => {
    const plan = planAwishPush(
      [{ titleName: "Mystery Pack Plus", quantity: 14, mystery: true }],
      [slot({ id: 1, currentInventory: 0, capacity: 20 })],
    );
    expect(plan.updates.map((u) => [u.productId, u.currentInventory])).toEqual([[1, 14]]);
    expect(plan.mysteryHeldBack).toEqual([]);
  });

  it("ett fack med pack kvar fylls inte på (påfyllningen hålls tillbaka)", () => {
    const plan = planAwishPush(
      [{ titleName: "Mystery Pack Plus", quantity: 17, mystery: true }],
      [slot({ id: 1, currentInventory: 3, capacity: 20 })],
    );
    expect(plan.updates).toEqual([]);
    expect(plan.mysteryHeldBack).toEqual(["Mystery Pack Plus"]);
    // Samma läge för en vanlig titel fyller på facket.
    const plain = planAwishPush(
      [{ titleName: "Mystery Pack Plus", quantity: 17 }],
      [slot({ id: 1, currentInventory: 3, capacity: 20 })],
    );
    expect(plain.updates.map((u) => u.currentInventory)).toEqual([17]);
  });

  it("fördelar aldrig över ett fack som har pack: bara det tomma fylls", () => {
    // Fack 1 har 3 kvar, fack 2 är tomt; appen vill ha 3 + 14.
    const plan = planAwishPush(
      [{ titleName: "Mystery Pack Plus", quantity: 17, mystery: true }],
      [slot({ id: 1, currentInventory: 3, capacity: 20 }), slot({ id: 2, capacity: 20 })],
    );
    expect(plan.updates.map((u) => [u.productId, u.previousInventory, u.currentInventory])).toEqual(
      [[2, 0, 14]],
    );
    expect(plan.mysteryHeldBack).toEqual([]);
  });

  it("tomt fack med okänd kapacitet får hela omgången", () => {
    const plan = planAwishPush(
      [{ titleName: "Mystery Pack Plus", quantity: 14, mystery: true }],
      [slot({ id: 4, currentInventory: 0 })],
    );
    expect(plan.updates.map((u) => u.currentInventory)).toEqual([14]);
  });

  it("säger hur många pack som inte fick plats, och varför", () => {
    // Omgången är 14 men facket rymmer 10: fyra pack tar Awish inte emot.
    const small = planAwishPush(
      [{ titleName: "Mystery Pack Plus", quantity: 14, mystery: true }],
      [slot({ id: 1, currentInventory: 0, capacity: 10 })],
    );
    expect(small.updates.map((u) => [u.productId, u.currentInventory])).toEqual([[1, 10]]);
    expect(small.notSent).toEqual([
      { titleName: "Mystery Pack Plus", left: 4, reason: "capacity" },
    ]);
    // Facket har tre kvar: inget skickas, och alla 14 står som inte skickade.
    const notEmpty = planAwishPush(
      [{ titleName: "Mystery Pack Plus", quantity: 17, mystery: true }],
      [slot({ id: 1, currentInventory: 3, capacity: 20 })],
    );
    expect(notEmpty.updates).toEqual([]);
    expect(notEmpty.notSent).toEqual([
      { titleName: "Mystery Pack Plus", left: 14, reason: "mystery_not_empty" },
    ]);
  });

  it("en vanlig titel som inte ryms rapporteras också (förr försvann resten tyst)", () => {
    const plan = planAwishPush(
      [{ titleName: "Surging Sparks", quantity: 12 }],
      [slot({ id: 1, goodName: "Surging Sparks", currentInventory: 3, capacity: 8 })],
    );
    expect(plan.updates.map((u) => [u.productId, u.currentInventory])).toEqual([[1, 8]]);
    expect(plan.notSent).toEqual([{ titleName: "Surging Sparks", left: 4, reason: "capacity" }]);
    // Ryms allt: inget att säga.
    const fits = planAwishPush(
      [{ titleName: "Surging Sparks", quantity: 8 }],
      [slot({ id: 1, goodName: "Surging Sparks", currentInventory: 3, capacity: 8 })],
    );
    expect(fits.notSent).toEqual([]);
  });
});
