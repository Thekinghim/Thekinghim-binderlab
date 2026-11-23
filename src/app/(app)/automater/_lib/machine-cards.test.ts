import { describe, expect, it } from "vitest";

import type { LagerMachine, PackList } from "../../lager/_lib/types";
import { cardSummary, machineCardsOf } from "./machine-cards";
import type { MachineScreen } from "./v2-data";

const machine = (id: string, code: string): LagerMachine => ({
  id,
  code,
  name: `Automat ${code}`,
  storeName: "Butik",
  awishSyncedAt: null,
});

const list = (machineId: string, over: Partial<PackList> = {}): PackList => ({
  machineId,
  lines: [],
  missing: [],
  totalPacks: 0,
  shortBy: 0,
  needBy: null,
  plannedDay: null,
  dueToday: false,
  reasons: [],
  ...over,
});

const screen = (id: string, over: Partial<MachineScreen> = {}): MachineScreen => ({
  id,
  code: id,
  name: id,
  appearance: "stjarnor",
  storeName: "Butik",
  city: "Stad",
  status: "i-drift",
  statusLabel: "I drift",
  tone: "neutral",
  fillBp: 8_000,
  units: 40,
  capacity: 50,
  daysLeft: 9,
  perDayMilli: 1_000,
  lastRefillAt: null,
  offlineSince: null,
  slots: [],
  ...over,
});

describe("machineCardsOf", () => {
  it("sorterar besök i dag först, sedan flottans läge och flest pack", () => {
    const cards = machineCardsOf(
      [
        machine("a", "BL-001"),
        machine("b", "BL-002"),
        machine("c", "BL-003"),
        machine("d", "BL-004"),
      ],
      [
        list("b", {
          dueToday: true,
          totalPacks: 12,
          lines: [
            { titleId: "t1", titleName: "Ett", quantity: 3, onHand: 7, target: 10, shortBy: 0 },
            { titleId: "t2", titleName: "Två", quantity: 9, onHand: 1, target: 10, shortBy: 0 },
          ],
        }),
        list("d", { totalPacks: 2 }),
      ],
      new Map([
        ["a", screen("a")],
        ["b", screen("b", { status: "fyll-pa", appearance: "gul" })],
        ["c", screen("c", { status: "offline" })],
      ]),
    );
    expect(cards.map((c) => c.code)).toEqual(["BL-002", "BL-003", "BL-001", "BL-004"]);
    const b = cards[0]!;
    expect(b.look).toBe("gul");
    expect(b.glyph).toBe("refill");
    // Minst kvar först.
    expect(b.lines.map((l) => l.name)).toEqual(["Två", "Ett"]);
    expect(cards[1]!.glyph).toBe("offline");
    // Utan flottans läge: svart med stjärnor och inget läge.
    expect(cards[3]!.look).toBe("stjarnor");
    expect(cards[3]!.status).toBeNull();
  });

  it("skärmens fack kommer från automatens Awish-fack", () => {
    const [card] = machineCardsOf(
      [machine("a", "BL-001")],
      [],
      new Map([
        [
          "a",
          screen("a", {
            slots: [
              {
                titleId: "t",
                name: "Black Bolt",
                channels: ["A1"],
                units: 0,
                capacity: 10,
                slots: 1,
                empty: 1,
              },
            ],
          }),
        ],
      ]),
    );
    expect(card!.slots).toEqual([{ title: "Black Bolt", fill: 0, empty: true }]);
    // Tomt fack som listan inte tar med (t.ex. slut i vårt lager): raden säger platsen.
    expect(card!.lines).toEqual([
      { titleId: "t", name: "Black Bolt", onHand: 0, take: 10, target: 10, kind: "room" },
    ]);
    expect(cardSummary(card!)).toBe("1 titel att fylla");
  });
});

describe("cardSummary", () => {
  it("säger det viktigaste i en rad", () => {
    const [c] = machineCardsOf([machine("a", "BL-001")], [], new Map([["a", screen("a")]]));
    expect(cardSummary(c!)).toBe("40 av 50 pack");
    expect(cardSummary({ ...c!, status: "offline" })).toBe("Offline");
    expect(
      cardSummary({
        ...c!,
        lines: [{ titleId: "t", name: "T", onHand: 0, take: 4, target: 4, kind: "take" }],
      }),
    ).toBe("1 titel att fylla");
  });
});

describe("lugnt kort", () => {
  it("visar de två lägsta facken som info", () => {
    const slot = (name: string, units: number) => ({
      titleId: name,
      name,
      channels: [],
      units,
      capacity: 10,
      slots: 1,
      empty: 0,
    });
    const [c] = machineCardsOf(
      [machine("a", "BL-001")],
      [],
      new Map([["a", screen("a", { slots: [slot("A", 9), slot("B", 5), slot("C", 7)] })]]),
    );
    expect(c!.lines.map((l) => [l.name, l.kind])).toEqual([
      ["B", "info"],
      ["C", "info"],
    ]);
    expect(cardSummary(c!)).toBe("40 av 50 pack");
  });
});
