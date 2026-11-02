import { describe, expect, it } from "vitest";
import { computeTodos } from "./index";
import { silenceText } from "./stale-machine";
import { daily, input, machine, NOW, order, title } from "./test-helpers";
import type { TodoInput } from "./types";

const stale = (i: TodoInput, now = NOW) =>
  computeTodos(i, now).filter((t) => t.kind === "stale-machine");
const withLast = (orderedAt: string, p: Partial<TodoInput> = {}) =>
  input({
    titles: [title("t1", "Black Bolt")],
    orders: [
      ...daily("t1", "m1", "2026-10-10", 14, 3),
      order({ id: "last", titleId: "t1", businessDate: orderedAt.slice(0, 10), orderedAt }),
    ],
    ...p,
  });

describe("automat som inte sålt", () => {
  it("slår till efter mer än 48 timmar", () => {
    const [t] = stale(withLast("2026-10-31T09:00:00Z")); // 49 h före 2 nov. 10:00Z
    expect(t).toMatchObject({
      key: "stale-machine:m1",
      level: "now",
      fingerprint: "last",
      title: "Automat 1 har inte sålt på 49 timmar",
      link: "/automater/m1",
    });
    expect(t?.detail).toContain("Senaste order 31 okt. 10:00 (Black Bolt).");
    expect(t?.detail).toContain("brukar sälja 1,4 pack");
    expect(t?.evidence.orderIds).toContain("last");
    expect(t?.atStakeOre).toBeGreaterThan(0);
  });

  it("slår inte till vid exakt 48 timmar eller mindre", () => {
    expect(stale(withLast("2026-10-31T10:00:00Z"))).toHaveLength(0);
    expect(stale(withLast("2026-11-02T09:00:00Z"))).toHaveLength(0);
  });

  it("längre tystnad visas i dygn", () => {
    expect(stale(withLast("2026-10-29T09:00:00Z"))[0]?.title).toBe(
      "Automat 1 har inte sålt på 4 dygn",
    );
    expect(silenceText(71)).toBe("71 timmar");
    expect(silenceText(72)).toBe("3 dygn");
    expect(silenceText(1)).toBe("1 timme");
  });

  it("bara automater i drift", () => {
    const off = withLast("2026-10-25T09:00:00Z", {
      machines: [machine("m1", "Automat 1", { activeTo: "2026-10-31" })],
    });
    expect(stale(off)).toHaveLength(0);
    const archived = withLast("2026-10-25T09:00:00Z", {
      machines: [machine("m1", "Automat 1", { archived: true })],
    });
    expect(stale(archived)).toHaveLength(0);
    const future = withLast("2026-10-25T09:00:00Z", {
      machines: [machine("m1", "Automat 1", { activeFrom: "2026-11-03" })],
    });
    expect(stale(future)).toHaveLength(0);
  });

  it("automat utan order flaggas efter mer än 48 timmar i drift (från 00:00 svensk tid)", () => {
    const i = (activeFrom: string) =>
      input({ machines: [machine("m1", "Automat 1", { activeFrom })] });
    expect(stale(i("2026-10-25"))[0]).toMatchObject({
      title: "Automat 1 har inte sålt något sedan driftstart",
      fingerprint: "none",
    });
    // 31 okt. 00:00 CET → 2 nov. 11:00 = 59 timmar > 48.
    const oct31 = stale(i("2026-10-31"))[0];
    expect(oct31?.title).toBe("Automat 1 har inte sålt något sedan driftstart");
    expect(oct31?.evidence.figures.find((f) => f.key === "silentHours")?.value).toBe(59);
    expect(oct31?.detail).toContain("59\u00a0timmar");
    expect(stale(i("2026-11-01"))).toHaveLength(0); // 35 timmar
    expect(stale(input())).toHaveLength(0); // okänd startdag
  });

  it("order utan tidpunkt räknas som såld i slutet av affärsdagen", () => {
    const i = (date: string) => input({ orders: [order({ titleId: "t1", businessDate: date })] });
    // 30 okt. slutar 31 okt. 00:00 CET (30 okt. 23:00Z) → 59 timmar till 2 nov. 11:00.
    expect(stale(i("2026-10-30"))[0]).toMatchObject({
      title: "Automat 1 har inte sålt på 59\u00a0timmar",
    });
    expect(stale(i("2026-10-31"))).toHaveLength(0); // 35 timmar
  });

  it("ogiltig orderedAt stoppar inte beräkningen; ordern räknas på affärsdatum", () => {
    const recent = input({
      orders: [
        order({ titleId: "t1", businessDate: "2026-11-01", orderedAt: "inte en tid" }),
        order({ titleId: "t1", businessDate: "2026-10-20", orderedAt: "2026-10-20T10:00:00Z" }),
      ],
    });
    expect(() => computeTodos(recent, NOW)).not.toThrow();
    expect(stale(recent)).toHaveLength(0); // 1 nov. räknas: 35 timmar
    // Tidpunkt utan tidszon avvisas och ordern räknas på datum: 29 okt. slutar 29 okt. 23:00Z → 83 h.
    const old = input({
      orders: [order({ titleId: "t1", businessDate: "2026-10-29", orderedAt: "2026-10-29T12:00" })],
    });
    expect(stale(old)[0]?.title).toBe("Automat 1 har inte sålt på 3\u00a0dygn");
    expect(stale(old)[0]?.evidence.figures.find((f) => f.key === "silentHours")?.value).toBe(83);
  });

  it("ett senare affärsdatum utan tidpunkt vinner över en äldre tidpunkt", () => {
    const i = input({
      orders: [
        order({ titleId: "t1", businessDate: "2026-10-20", orderedAt: "2026-10-20T10:00:00Z" }),
        order({ titleId: "t1", businessDate: "2026-11-01" }),
      ],
    });
    expect(stale(i)).toHaveLength(0);
  });

  it("väljer senaste tidpunkten oavsett ordning i indata", () => {
    const a = withLast("2026-10-31T09:00:00Z");
    const reversed = { ...a, orders: [...a.orders].reverse() };
    expect(stale(reversed)).toEqual(stale(a));
  });

  it("gränsen kan ändras", () => {
    const i = withLast("2026-11-01T09:00:00Z", { options: { staleHours: 24 } });
    expect(stale(i)[0]?.title).toBe("Automat 1 har inte sålt på 25 timmar");
  });
});
