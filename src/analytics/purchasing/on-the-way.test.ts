import { describe, expect, it } from "vitest";

import { expectedWhen, onTheWay } from "./on-the-way";
import type { OnOrderLine, PurchasePlan } from "./types";

const order = (over: Partial<OnOrderLine>): OnOrderLine => ({
  purchaseOrderId: "po",
  supplierId: "s",
  status: "ordered",
  outstanding: 36,
  unitCostOre: 0,
  expectedOn: "2026-11-13",
  overdue: false,
  counted: true,
  ...over,
});
const plan = (lines: { titleId: string; onOrder: OnOrderLine[] }[]) =>
  ({ lines }) as unknown as Pick<PurchasePlan, "lines">;

describe("På väg", () => {
  it("summerar det som är beställt per titel, med tidigaste dagen", () => {
    const way = onTheWay(
      plan([
        {
          titleId: "a",
          onOrder: [
            order({ outstanding: 36, expectedOn: "2026-11-20" }),
            order({ outstanding: 12, expectedOn: "2026-11-13", status: "partially_received" }),
          ],
        },
        { titleId: "b", onOrder: [] },
        { titleId: "c", onOrder: [order({ status: "draft" })] },
        { titleId: "d", onOrder: [order({ outstanding: 0 })] },
        { titleId: "e", onOrder: [order({ expectedOn: "2026-11-01", overdue: true })] },
      ]),
    );
    expect(way).toEqual([
      { titleId: "a", quantity: 48, expectedOn: "2026-11-13", late: false },
      { titleId: "e", quantity: 36, expectedOn: "2026-11-01", late: true },
    ]);
  });
  it("väntas: i dag, veckodagen inom en vecka, annars datumet", () => {
    // 11 nov. 2026 är en onsdag.
    expect(expectedWhen("2026-11-11", "2026-11-11")).toEqual({ kind: "today" });
    expect(expectedWhen("2026-11-13", "2026-11-11")).toEqual({ kind: "weekday", day: 5 });
    expect(expectedWhen("2026-11-18", "2026-11-11")).toEqual({ kind: "weekday", day: 3 });
    expect(expectedWhen("2026-11-19", "2026-11-11")).toEqual({ kind: "date", date: "2026-11-19" });
    expect(expectedWhen("2026-11-05", "2026-11-11")).toEqual({ kind: "date", date: "2026-11-05" });
  });
});
