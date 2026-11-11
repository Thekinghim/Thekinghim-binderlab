import { describe, expect, it } from "vitest";
import { computeTodos } from "./index";
import { VISIT_DEFAULTS } from "@/analytics/visits";
import { refillFingerprint, VISIT_BUFFER_DAYS, withSlotAlerts } from "./refill";
import { daily, input, machine, NOW, order, title, TODAY } from "./test-helpers";
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
    // Räcker 2,0 dagar räknat med i dag: 2 och 3 nov. (domänens stockoutDate med asOf = i går).
    expect(t?.detail).toMatch(/Tar slut i morgon – fyll på i dag\.$/);
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

  it("ingen försäljning i fönstret ger ingen punkt så länge det finns pack kvar", () => {
    const i = base({
      orders: daily("t1", "m1", "2026-09-01", 10, 3),
      stock: [{ machineId: "m1", titleId: "t1", onHand: 2 }],
    });
    expect(refills(i)).toHaveLength(0);
  });

  it("tomt fack för en titel som sålt här förut är slut i dag, fast takten i fönstret är 0", () => {
    // Lager visar Akut för ett tomt fack; Att göra ska säga detsamma under "I dag".
    const i = base({
      orders: daily("t1", "m1", "2026-09-01", 10, 3),
      stock: [{ machineId: "m1", titleId: "t1", onHand: 0 }],
    });
    expect(refills(i)).toMatchObject([
      { key: "refill:m1:t1", level: "now", title: "Black Bolt är slut i Automat 1" },
    ]);
    // Aldrig sålt i automaten: ingen punkt.
    expect(
      refills(base({ orders: [], stock: [{ machineId: "m1", titleId: "t1", onHand: 0 }] })),
    ).toHaveLength(0);
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

  it("fingerprint ändras med registrerad påfyllning, saldo och nivå, inte med en inventering", () => {
    const fp = (onHand: number, lastRefilledAt: string | null, lastRestockedAt?: string) =>
      refills(
        base({
          stock: [
            {
              machineId: "m1",
              titleId: "t1",
              onHand,
              lastRefilledAt,
              lastRestockedAt: lastRestockedAt ?? lastRefilledAt,
            },
          ],
        }),
      )[0]?.fingerprint;
    expect(fp(4, "2026-10-20T08:00:00Z")).toBe("soon|saldo:4|påfyllt:2026-10-20T08:00:00Z");
    // Ett pack till sålt: läget har ändrats, punkten kommer tillbaka.
    expect(fp(3, "2026-10-20T08:00:00Z")).not.toBe(fp(4, "2026-10-20T08:00:00Z"));
    expect(fp(0, "2026-10-20T08:00:00Z")).not.toBe(fp(4, "2026-10-20T08:00:00Z"));
    expect(fp(4, "2026-10-30T08:00:00Z")).not.toBe(fp(4, "2026-10-20T08:00:00Z"));
    // En inventering (Awish) med samma saldo ändrar inget.
    expect(fp(4, null, "2026-11-01T12:20:00Z")).toBe(fp(4, null, "2026-10-25T12:20:00Z"));
  });

  it("order utan automat ignoreras", () => {
    const i = base({
      orders: [order({ titleId: "t1", machineId: null, businessDate: "2026-11-01" })],
      stock: [{ machineId: "m1", titleId: "t1", onHand: 0 }],
    });
    expect(refills(i)).toHaveLength(0);
  });
});

describe("påfyllning: slutdatum och avbockning", () => {
  it("räcker 2,3 dagar den 2 nov. → väntas ta slut 4 nov. (inte 5 nov.)", () => {
    // 3 per dag i 14 dagar = 42 pack; 7 i lager räcker 7 × 14 / 42 = 2,33 dagar: 2, 3 och 4 nov.
    const i = base({
      orders: daily("t1", "m1", "2026-10-19", 14, 3),
      stock: [{ machineId: "m1", titleId: "t1", onHand: 7 }],
    });
    const t = refills(i)[0];
    expect(t?.detail).toContain("räcker ca 2,3 dagar");
    // 4 nov. är en onsdag; fyll på senast dagen före (3 nov., i morgon).
    expect(t?.detail).toMatch(/Tar slut på onsdag – fyll på senast i morgon\.$/);
  });

  it("refillFingerprint: nivå, saldo och senaste registrerade påfyllning", () => {
    expect(refillFingerprint("soon", { onHand: 4, lastRefilledAt: "2026-10-30T08:00:00Z" })).toBe(
      "soon|saldo:4|påfyllt:2026-10-30T08:00:00Z",
    );
    expect(refillFingerprint("now", { onHand: 0, lastRefilledAt: null })).toBe(
      "now|saldo:0|påfyllt:-",
    );
    expect(refillFingerprint("now", { onHand: -2 })).toBe("now|saldo:0|påfyllt:-");
  });

  it("besöksplanens marginal är densamma som här", () => {
    expect(VISIT_BUFFER_DAYS).toBe(VISIT_DEFAULTS.bufferDays);
  });

  it("försenat besök (exakt 1,0 dag kvar, besök senast i går) står under I dag", () => {
    // 2 per dag, 2 pack: räcker 1,0 dag → slut 2 nov. (i dag), besök senast 1 nov. (passerat).
    const [t] = refills(base({ stock: [{ machineId: "m1", titleId: "t1", onHand: 2 }] }));
    expect(t?.level).toBe("now");
    expect(t?.detail).toMatch(/Besöket är försenat \(senast 1\u00a0nov\.\)\.$/);
  });
});

describe("påfyllning: larmgräns", () => {
  const alert = (alertAtUnits: number) => [{ machineId: "m1", titleId: "t1", alertAtUnits }];
  const stockAt = (onHand: number) => [{ machineId: "m1", titleId: "t1", onHand }];

  it("gränsen ensam: saldo 4 och gräns 4 utan försäljning ger en punkt", () => {
    const [t, ...rest] = refills(base({ orders: [], stock: stockAt(4), slotAlerts: alert(4) }));
    expect(rest).toHaveLength(0);
    expect(t).toMatchObject({
      key: "refill:m1:t1",
      level: "soon",
      detail: "Saldo 4, larmgräns 4.",
      atStakeOre: null,
      daysLeft: null,
      link: "/lager?automat=m1&titel=t1",
      title: "Fyll på Black Bolt i Automat 1",
    });
  });

  it("gränsen ensam: över gränsen och utan takt ger ingen punkt", () => {
    expect(refills(base({ orders: [], stock: stockAt(5), slotAlerts: alert(4) }))).toHaveLength(0);
  });

  it("gränsen slår till fast takten inte gör (40 pack, gräns 40)", () => {
    const [t] = refills(base({ stock: stockAt(40), slotAlerts: alert(40) }));
    expect(t?.detail).toBe("Saldo 40, larmgräns 40.");
  });

  it("båda reglerna samtidigt: en punkt, texten börjar med gränsen", () => {
    const list = refills(base({ stock: stockAt(4), slotAlerts: alert(4) }));
    expect(list).toHaveLength(1);
    expect(list[0]?.detail).toMatch(/^Saldo 4, larmgräns 4\. 4.pack kvar räcker ca 2,0 dagar/);
    expect(list[0]?.atStakeOre).toBe(49_000);
  });

  it("gräns 0 slår bara till vid tomt lager, och då är nivån 'now'", () => {
    expect(refills(base({ orders: [], stock: stockAt(1), slotAlerts: alert(0) }))).toHaveLength(0);
    const [t] = refills(base({ orders: [], stock: stockAt(0), slotAlerts: alert(0) }));
    expect(t).toMatchObject({ level: "now", title: "Black Bolt är slut i Automat 1" });
  });

  it("utan gräns (null eller tom lista) är allt som förut", () => {
    const pick = (l: ReturnType<typeof refills>) =>
      l.map((t) => [t.key, t.level, t.detail, t.atStakeOre, t.fingerprint]);
    const plain = pick(refills(base({ stock: stockAt(4) })));
    expect(pick(refills(base({ stock: stockAt(4), slotAlerts: [] })))).toEqual(plain);
    expect(refills(base({ orders: [], stock: stockAt(0), slotAlerts: [] }))).toHaveLength(0);
  });

  it("utgången titel eller automat ur drift ger ingen punkt", () => {
    expect(
      refills(
        base({
          orders: [],
          stock: stockAt(0),
          slotAlerts: alert(4),
          slotPeriods: [
            { machineId: "m1", titleId: "t1", validFrom: "2026-09-01", validTo: "2026-10-01" },
          ],
        }),
      ),
    ).toHaveLength(0);
    expect(
      refills(
        base({
          orders: [],
          stock: stockAt(0),
          slotAlerts: alert(4),
          machines: [machine("m1", "Automat 1", { activeTo: "2026-10-01" })],
        }),
      ),
    ).toHaveLength(0);
  });

  it("withSlotAlerts lägger till, märker befintliga och hoppar över avbockade", () => {
    const machines = [machine("m1", "Automat 1")];
    const titles = [title("t1", "Black Bolt"), title("t2", "Ascended")];
    const existing = refills(base({ stock: stockAt(4) }));
    const stock = [...stockAt(4), { machineId: "m1", titleId: "t2", onHand: 2 }];
    const alerts = [...alert(4), { machineId: "m1", titleId: "t2", alertAtUnits: 3 }];
    const out = withSlotAlerts(existing, { alerts, stock, machines, titles, today: TODAY });
    expect(out.map((t) => t.key).sort()).toEqual(["refill:m1:t1", "refill:m1:t2"]);
    expect(out.find((t) => t.key === "refill:m1:t1")?.detail).toMatch(/^Saldo 4, larmgräns 4\. /);
    expect(out.find((t) => t.key === "refill:m1:t2")?.detail).toBe("Saldo 2, larmgräns 3.");
    // Idempotent: texten läggs inte till två gånger.
    const twice = withSlotAlerts(out, { alerts, stock, machines, titles, today: TODAY });
    expect(twice.find((t) => t.key === "refill:m1:t1")?.detail).toBe(
      out.find((t) => t.key === "refill:m1:t1")?.detail,
    );
    const skipped = withSlotAlerts([], {
      alerts,
      stock,
      machines,
      titles,
      today: TODAY,
      skipKeys: new Set(["refill:m1:t2"]),
    });
    expect(skipped.map((t) => t.key)).toEqual(["refill:m1:t1"]);
    expect(withSlotAlerts(existing, { alerts: [], stock, machines, titles, today: TODAY })).toEqual(
      existing,
    );
  });
});
