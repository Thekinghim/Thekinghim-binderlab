/** Lagerlarm för mystery packs: inget larm före 0, vid 0 en hel omgång. */
import { describe, expect, it } from "vitest";

import { daily } from "@/analytics/todos/test-helpers";

import { lowStockAlerts } from "./index";

const NOW = "2026-11-02T09:00:00Z";
const machines = [{ id: "m1", name: "Automat 1", activeFrom: null, activeTo: null }];
const titles = [{ id: "mp", name: "Mystery Pack Plus", mysteryBatchSize: 14 }];
const orders = daily("mp", "m1", "2026-10-19", 14, 2);

describe("lagerlarm: mystery packs", () => {
  it("inget larm medan facket har pack, även när det tar slut i morgon", () => {
    const stock = [{ machineId: "m1", titleId: "mp", onHand: 1 }];
    expect(lowStockAlerts({ orders, machines, titles, stock }, NOW)).toEqual([]);
    // En vanlig titel larmar.
    expect(
      lowStockAlerts(
        { orders, machines, titles: [{ id: "mp", name: "Mystery Pack Plus" }], stock },
        NOW,
      ),
    ).toHaveLength(1);
  });

  it("tomt fack: kritiskt larm, fyll på en hel omgång", () => {
    const [a, ...rest] = lowStockAlerts(
      { orders, machines, titles, stock: [{ machineId: "m1", titleId: "mp", onHand: 0 }] },
      NOW,
    );
    expect(rest).toEqual([]);
    expect(a?.severity).toBe("critical");
    expect(a?.title).toBe("Mystery Pack Plus är slut i Automat 1 – fyll på en hel omgång (14 st)");
  });
});
