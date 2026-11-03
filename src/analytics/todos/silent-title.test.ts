import { describe, expect, it } from "vitest";
import { createTodoContext } from "./context";
import { applyDismissals, computeTodos } from "./index";
import { silentTitleTodos } from "./silent-title";
import { input, machine, NOW, order, title } from "./test-helpers";
import { businessDateAt, HOUR_MS } from "./time";
import type { AnalyticsOrder, StockLevelRef, TodoInput } from "./types";

/** En order varje timme från `fromIso` till (inte med) `toIso`, 07–18 UTC varje dag. */
function hourly(titleId: string, fromIso: string, toIso: string, machineId = "m1") {
  const out: AnalyticsOrder[] = [];
  for (let ms = Date.parse(fromIso); ms < Date.parse(toIso); ms += HOUR_MS) {
    const h = new Date(ms).getUTCHours();
    if (h < 7 || h > 18) continue;
    const orderedAt = new Date(ms).toISOString();
    out.push(order({ titleId, machineId, businessDate: businessDateAt(orderedAt), orderedAt }));
  }
  return out;
}

const stock = (p: Partial<StockLevelRef> = {}): StockLevelRef => ({
  machineId: "m1",
  titleId: "t1",
  onHand: 5,
  lastRestockedAt: "2026-10-01T08:00:00Z",
  ...p,
});

/** t1 säljer varje timme till 30 okt. 11:00Z och tystnar; t2 säljer hela tiden. */
function fixture(p: Partial<TodoInput> = {}, t1Until = "2026-10-30T11:00:00Z"): TodoInput {
  return input({
    titles: [title("t1", "Black Bolt"), title("t2", "Surging Sparks")],
    orders: [
      ...hourly("t1", "2026-10-05T00:00:00Z", t1Until),
      ...hourly("t2", "2026-10-05T00:00:00Z", NOW),
    ],
    stock: [stock(), stock({ titleId: "t2", onHand: 9 })],
    ...p,
  });
}

const silent = (i: TodoInput, now: string = NOW) =>
  computeTodos(i, now).filter((t) => t.kind === "silent-title");

describe("tyst titel", () => {
  it("flaggar en titel som tystnat medan andra säljer", () => {
    const [t, ...rest] = silent(fixture());
    expect(rest).toEqual([]);
    expect(t).toMatchObject({
      key: "silent-title:m1:t1",
      kind: "silent-title",
      level: "now",
      fingerprint: "2026-10-30T10:00:00.000Z",
      title: "Black Bolt i Automat 1 har inte sålt på 3\u00a0dygn",
      link: "/drift/automat/m1",
      action: { kind: "open-machine", label: "Öppna automaten" },
    });
    expect(t?.detail).toMatch(/^5 pack i facket · brukar sälja \d+,\d på den tiden/);
    expect(t?.detail).toMatch(/automaten sålde \d+ andra$/);
    expect(t?.evidence.machineIds).toEqual(["m1"]);
    expect(t?.evidence.titleIds).toEqual(["t1"]);
    // 12 pack/dag × 49 kr, 14 dagar t.o.m. 30 okt. → /14 × 7.
    expect(t?.atStakeOre).toBeGreaterThan(0);
    const days = t?.evidence.period;
    expect(days).toEqual({ start: "2026-10-17", end: "2026-10-30" });
  });

  it("flaggar inte när facket är tomt", () => {
    expect(silent(fixture({ stock: [stock({ onHand: 0 })] }))).toEqual([]);
  });

  it("flaggar inte när automaten sålt under 3 andra pack", () => {
    const i = fixture();
    const orders = i.orders.filter(
      (o) => o.titleId === "t1" || Date.parse(o.orderedAt!) < Date.parse("2026-10-30T10:00:00Z"),
    );
    const two = hourly("t2", "2026-10-31T09:00:00Z", "2026-10-31T11:00:00Z");
    expect(two).toHaveLength(2);
    expect(silent({ ...i, orders: [...orders, ...two] })).toEqual([]);
    const three = hourly("t2", "2026-10-31T09:00:00Z", "2026-10-31T12:00:00Z");
    expect(silent({ ...i, orders: [...orders, ...three] })).toHaveLength(1);
  });

  it("hoppar över automater som redan står som tysta automater", () => {
    const i = fixture();
    const ctx = createTodoContext(i, NOW);
    expect(silentTitleTodos(ctx, new Set())).toHaveLength(1);
    expect(silentTitleTodos(ctx, new Set(["m1"]))).toEqual([]);
  });

  it("räknar inte samma intäkt två gånger när titeln också ska fyllas på", () => {
    const ctx = createTodoContext(fixture(), NOW);
    const own = silentTitleTodos(ctx, new Set())[0]!.atStakeOre!;
    expect(own).toBeGreaterThan(0);
    const refill = new Map([["m1:t1", 1000]]);
    const [lower] = silentTitleTodos(ctx, new Set(), refill);
    expect(lower?.atStakeOre).toBe(own - 1000);
    const [none] = silentTitleTodos(ctx, new Set(), new Map([["m1:t1", own + 1]]));
    expect(none?.atStakeOre).toBe(0);
  });

  it("flaggar inte med under 10 sålda i historiken", () => {
    const i = fixture({
      orders: [
        ...hourly("t1", "2026-10-29T09:00:00Z", "2026-10-29T18:00:00Z"), // 9 st
        ...hourly("t2", "2026-10-05T00:00:00Z", NOW),
      ],
    });
    expect(i.orders.filter((o) => o.titleId === "t1")).toHaveLength(9);
    expect(silent(i)).toEqual([]);
  });

  it("en påfyllning efter senaste försäljningen flyttar tystnadens start", () => {
    // Fyllt på för 20 timmar sedan: för kort tystnad.
    expect(
      silent(fixture({ stock: [stock({ lastRestockedAt: "2026-11-01T14:00:00Z" })] })),
    ).toEqual([]);
    // Fyllt på för 30 timmar sedan: tystnaden räknas därifrån.
    const [t] = silent(fixture({ stock: [stock({ lastRestockedAt: "2026-11-01T04:00:00Z" })] }));
    expect(t?.fingerprint).toBe("2026-11-01T04:00:00.000Z");
    expect(t?.title).toBe("Black Bolt i Automat 1 har inte sålt på 30 timmar");
    // Bara ett datum: slutet av dagen (00:00 nästa dag svensk tid).
    const [d] = silent(fixture({ stock: [stock({ lastRestockedAt: "2026-10-31" })] }));
    expect(d?.fingerprint).toBe("2026-10-31T23:00:00.000Z");
  });

  it("hoppar över en titel som gått ur sortimentet", () => {
    const i = fixture({
      slotPeriods: [
        { machineId: "m1", titleId: "t1", validFrom: "2026-09-01", validTo: "2026-10-31" },
      ],
    });
    expect(silent(i)).toEqual([]);
  });

  it("räknar rätt över sommartidens slut", () => {
    // Sommartiden slutar 25 okt. 2026: natten har 25 timmar.
    const now = "2026-10-26T12:00:00Z";
    const i = input({
      titles: [title("t1", "Black Bolt"), title("t2", "Surging Sparks")],
      orders: [
        ...hourly("t1", "2026-10-01T00:00:00Z", "2026-10-24T12:00:00Z"),
        ...hourly("t2", "2026-10-01T00:00:00Z", now),
      ],
      stock: [stock()],
    });
    const [t] = silent(i, now);
    expect(t?.fingerprint).toBe("2026-10-24T11:00:00.000Z");
    expect(t?.title).toBe("Black Bolt i Automat 1 har inte sålt på 49 timmar");
  });

  it("en avbockning kommer tillbaka efter en ny försäljning och ny tystnad", () => {
    const [before] = silent(fixture());
    expect(before).toBeDefined();
    const dismissals = [{ key: before!.key, fingerprint: before!.fingerprint }];
    expect(applyDismissals(silent(fixture()), dismissals)).toEqual([]);
    const later = fixture();
    const sale = "2026-10-31T08:30:00Z";
    const withSale: TodoInput = {
      ...later,
      orders: [
        ...later.orders,
        order({ titleId: "t1", businessDate: businessDateAt(sale), orderedAt: sale }),
      ],
    };
    const [after] = silent(withSale);
    expect(after?.fingerprint).toBe("2026-10-31T08:30:00.000Z");
    expect(applyDismissals([after!], dismissals)).toHaveLength(1);
  });

  it("räknar bara fram till importens slut", () => {
    const [t] = silent(
      fixture({ salesDataUntil: [{ machineId: "m1", until: "2026-11-01T10:00:00Z" }] }),
    );
    expect(t?.title).toBe("Black Bolt i Automat 1 har inte sålt på 48 timmar");
  });

  it("hoppar över automater som inte är i drift", () => {
    expect(
      silent(fixture({ machines: [machine("m1", "Automat 1", { activeTo: "2026-11-01" })] })),
    ).toEqual([]);
  });
});
