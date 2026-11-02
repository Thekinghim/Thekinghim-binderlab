import { describe, expect, it } from "vitest";
import { computeTodos } from "./index";
import { daily, input, machine, NOW, order, title } from "./test-helpers";
import type { TodoInput } from "./types";

// Fönstret: 14 dagar t.o.m. i går = 19 okt.–1 nov. 2026.
const base = (p: Partial<TodoInput> = {}) =>
  input({
    titles: [title("t1", "Black Bolt")],
    orders: daily("t1", "m1", "2026-10-19", 14, 2), // 28 pack, 2 per dag
    ...p,
  });

const refills = (i: TodoInput) => computeTodos(i, NOW).filter((t) => t.kind === "refill");

describe("påfyllning", () => {
  it("slår till när lagret räcker under 2,5 dagar (4 pack vid 2 per dag = 2,0 dagar)", () => {
    const [t, ...rest] = refills(base({ stock: [{ machineId: "m1", titleId: "t1", onHand: 4 }] }));
    expect(rest).toHaveLength(0);
    expect(t).toMatchObject({
      key: "refill:m1:t1",
      level: "soon",
      daysLeft: 2,
      atStakeOre: 49_000, // 2 pack × 49 kr × (7 − 2) dagar
      title: "Fyll på Black Bolt i Automat 1",
      link: "/lager?automat=m1&titel=t1",
      action: {
        kind: "register-refill",
        label: "Registrera påfyllning",
        params: { machineId: "m1", titleId: "t1" },
      },
    });
    expect(t?.detail).toContain("räcker ca 2,0 dagar vid 2,0 pack per dag");
    expect(t?.detail).toMatch(/Väntas ta slut 4\u00a0nov\.$/);
    expect(t?.evidence.orderIds).toHaveLength(28);
    expect(t?.evidence.period).toEqual({ start: "2026-10-19", end: "2026-11-01" });
    expect(t?.evidence.figures.find((f) => f.key === "daysLeftTenths")?.value).toBe(20);
  });

  it("slår inte till vid exakt 2,5 dagar (5 pack) eller mer", () => {
    expect(refills(base({ stock: [{ machineId: "m1", titleId: "t1", onHand: 5 }] }))).toHaveLength(
      0,
    );
    expect(refills(base({ stock: [{ machineId: "m1", titleId: "t1", onHand: 40 }] }))).toHaveLength(
      0,
    );
  });

  it("tomt lager eller under 1 dag är 'now'", () => {
    const [empty] = refills(base({ stock: [{ machineId: "m1", titleId: "t1", onHand: 0 }] }));
    expect(empty).toMatchObject({
      level: "now",
      daysLeft: 0,
      atStakeOre: 68_600,
      title: "Black Bolt är slut i Automat 1",
    });
    expect(empty?.detail).toMatch(/^Slut i lager\. Säljer i snitt 2,0 pack och 98 kr per dag/);
    const [low] = refills(base({ stock: [{ machineId: "m1", titleId: "t1", onHand: 1 }] }));
    expect(low).toMatchObject({ level: "now", daysLeft: 0 });
  });

  it("negativt saldo räknas som tomt", () => {
    const [t] = refills(base({ stock: [{ machineId: "m1", titleId: "t1", onHand: -3 }] }));
    expect(t?.evidence.figures.find((f) => f.key === "onHand")?.value).toBe(0);
  });

  it("ingen försäljning i fönstret ger ingen punkt", () => {
    const i = base({
      orders: daily("t1", "m1", "2026-09-01", 10, 3),
      stock: [{ machineId: "m1", titleId: "t1", onHand: 0 }],
    });
    expect(refills(i)).toHaveLength(0);
  });

  it("dagens försäljning ingår inte i takten", () => {
    const i = base({
      orders: [
        ...daily("t1", "m1", "2026-10-19", 14, 2),
        ...daily("t1", "m1", "2026-11-02", 1, 30),
      ],
      stock: [{ machineId: "m1", titleId: "t1", onHand: 5 }],
    });
    expect(refills(i)).toHaveLength(0);
  });

  it("fönstret kortas vid automatens startdag", () => {
    const orders = daily("t1", "m1", "2026-10-28", 5, 2); // 10 pack på 5 dagar
    const stock = [{ machineId: "m1", titleId: "t1", onHand: 4 }];
    // Utan startdag: 4 pack vid 10/14 per dag = 5,6 dagar → ingen punkt.
    expect(refills(base({ orders, stock }))).toHaveLength(0);
    // Med startdag 28 okt.: 4 pack vid 2 per dag = 2 dagar → punkt.
    const i = base({
      orders,
      stock,
      machines: [machine("m1", "Automat 1", { activeFrom: "2026-10-28" })],
    });
    expect(refills(i)[0]).toMatchObject({
      daysLeft: 2,
      evidence: { period: { start: "2026-10-28", end: "2026-11-01" } },
    });
  });

  it("bara automater i drift", () => {
    const stock = [{ machineId: "m1", titleId: "t1", onHand: 0 }];
    expect(
      refills(base({ stock, machines: [machine("m1", "Automat 1", { activeTo: "2026-11-01" })] })),
    ).toHaveLength(0);
    expect(
      refills(base({ stock, machines: [machine("m1", "Automat 1", { archived: true })] })),
    ).toHaveLength(0);
    expect(refills(base({ stock, machines: [] }))).toHaveLength(0);
  });

  it("räknar per automat: försäljning i en annan automat påverkar inte", () => {
    const i = base({
      machines: [machine("m1", "Automat 1"), machine("m2", "Automat 2")],
      orders: [
        ...daily("t1", "m1", "2026-10-19", 14, 2),
        ...daily("t1", "m2", "2026-10-19", 14, 10),
      ],
      stock: [
        { machineId: "m1", titleId: "t1", onHand: 20 },
        { machineId: "m2", titleId: "t1", onHand: 20 },
      ],
    });
    expect(refills(i).map((t) => t.key)).toEqual(["refill:m2:t1"]);
  });

  it("fingerprint ändras med påfyllning och nivå", () => {
    const fp = (onHand: number, lastRestockedAt: string | null) =>
      refills(base({ stock: [{ machineId: "m1", titleId: "t1", onHand, lastRestockedAt }] }))[0]
        ?.fingerprint;
    expect(fp(4, "2026-10-20T08:00:00Z")).toBe("soon|2026-10-20T08:00:00Z");
    expect(fp(3, "2026-10-20T08:00:00Z")).toBe(fp(4, "2026-10-20T08:00:00Z"));
    expect(fp(0, "2026-10-20T08:00:00Z")).not.toBe(fp(4, "2026-10-20T08:00:00Z"));
    expect(fp(4, "2026-10-30T08:00:00Z")).not.toBe(fp(4, "2026-10-20T08:00:00Z"));
  });

  it("order utan automat ignoreras", () => {
    const i = base({
      orders: [order({ titleId: "t1", machineId: null, businessDate: "2026-11-01" })],
      stock: [{ machineId: "m1", titleId: "t1", onHand: 0 }],
    });
    expect(refills(i)).toHaveLength(0);
  });
});
