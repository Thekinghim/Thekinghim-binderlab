/**
 * De sparade obetalda avräkningarna (cache.ts) mot en liten Next-datacache i minnet:
 * sparas per organisation och användare, räknas om när tiden gått ut och direkt när en
 * åtgärd eller synken rensat organisationens tagg, men inte när en annan organisation
 * ändrats.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SettlementRef } from "@/analytics/todos";

const next = vi.hoisted(() => {
  const entries = new Map<string, { value: unknown; at: number; tags: string[] }>();
  const tagTimes = new Map<string, number>();
  const state = { inAction: true, inNext: true, revalidated: [] as unknown[][] };
  return {
    entries,
    tagTimes,
    state,
    reset() {
      entries.clear();
      tagTimes.clear();
      state.inAction = true;
      state.inNext = true;
      state.revalidated = [];
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  unstable_cache:
    (
      fn: () => Promise<unknown>,
      keyParts: string[],
      opts: { revalidate: number; tags: string[] },
    ) =>
    async () => {
      const key = JSON.stringify(keyParts);
      const e = next.entries.get(key);
      const now = Date.now();
      const fresh =
        e &&
        now - e.at < opts.revalidate * 1000 &&
        e.tags.every((t) => (next.tagTimes.get(t) ?? -1) < e.at);
      if (fresh) return structuredClone(e.value);
      const value = await fn();
      next.entries.set(key, { value, at: now, tags: opts.tags });
      return structuredClone(value);
    },
  updateTag: (tag: string) => {
    if (!next.state.inAction)
      throw new Error("updateTag can only be called from within a Server Action.");
    next.tagTimes.set(tag, Date.now());
  },
  revalidateTag: (tag: string, profile: unknown) => {
    if (!next.state.inNext) throw new Error("Invariant: static generation store missing");
    next.state.revalidated.push([tag, profile]);
    next.tagTimes.set(tag, Date.now());
  },
}));

import {
  cachedUnpaidSettlements,
  invalidateUnpaidSettlements,
  UNPAID_SETTLEMENTS_SECONDS,
  unpaidSettlementsTag,
} from "./cache";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const key = (organizationId: string) => ({ organizationId, userId: "u1", role: "owner" });

function settlement(amountOre: number): SettlementRef[] {
  return [{ id: "s1", storeId: "st1", month: "2026-10-01", amountOre }];
}

beforeEach(() => {
  next.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("obetalda avräkningar sparade mellan förfrågningar", () => {
  it("räknas en gång och läses sedan ur cachen", async () => {
    const load = vi.fn(async () => settlement(1_000));
    expect(await cachedUnpaidSettlements(key(ORG_A), load)).toEqual(settlement(1_000));
    vi.advanceTimersByTime(30_000);
    expect(await cachedUnpaidSettlements(key(ORG_A), load)).toEqual(settlement(1_000));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("räknas om när tiden gått ut", async () => {
    let amount = 1_000;
    const load = vi.fn(async () => settlement(amount));
    await cachedUnpaidSettlements(key(ORG_A), load);
    amount = 2_000;
    vi.advanceTimersByTime(UNPAID_SETTLEMENTS_SECONDS * 1000 + 1);
    expect(await cachedUnpaidSettlements(key(ORG_A), load)).toEqual(settlement(2_000));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("en åtgärd (updateTag) rensar organisationen: nästa visning har nya beloppet", async () => {
    let amount = 1_000;
    const load = vi.fn(async () => settlement(amount));
    await cachedUnpaidSettlements(key(ORG_A), load);
    amount = 0; // t.ex. markerad som betald
    vi.advanceTimersByTime(1);
    invalidateUnpaidSettlements(ORG_A);
    vi.advanceTimersByTime(1);
    expect(await cachedUnpaidSettlements(key(ORG_A), load)).toEqual(settlement(0));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("en annan organisations ändring rör inte cachen", async () => {
    const loadA = vi.fn(async () => settlement(1_000));
    const loadB = vi.fn(async () => settlement(5_000));
    await cachedUnpaidSettlements(key(ORG_A), loadA);
    await cachedUnpaidSettlements(key(ORG_B), loadB);
    vi.advanceTimersByTime(1);
    invalidateUnpaidSettlements(ORG_B);
    vi.advanceTimersByTime(1);
    await cachedUnpaidSettlements(key(ORG_A), loadA);
    await cachedUnpaidSettlements(key(ORG_B), loadB);
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(2);
  });

  it("varje användare har sin egen post (inget delas mellan användare)", async () => {
    const load = vi.fn(async () => settlement(1_000));
    await cachedUnpaidSettlements(key(ORG_A), load);
    await cachedUnpaidSettlements({ ...key(ORG_A), userId: "u2" }, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("en extra tagg (appDataTag) rensar också", async () => {
    const load = vi.fn(async () => settlement(1_000));
    await cachedUnpaidSettlements(key(ORG_A), load, ["app-data:x"]);
    vi.advanceTimersByTime(1);
    next.tagTimes.set("app-data:x", Date.now());
    vi.advanceTimersByTime(1);
    await cachedUnpaidSettlements(key(ORG_A), load, ["app-data:x"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("utanför en åtgärd (synken i cron) rensas med revalidateTag utan gammalt innehåll", async () => {
    next.state.inAction = false;
    const load = vi.fn(async () => settlement(1_000));
    await cachedUnpaidSettlements(key(ORG_A), load);
    vi.advanceTimersByTime(1);
    invalidateUnpaidSettlements(ORG_A);
    expect(next.state.revalidated).toEqual([[unpaidSettlementsTag(ORG_A), { expire: 0 }]]);
    vi.advanceTimersByTime(1);
    await cachedUnpaidSettlements(key(ORG_A), load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("utanför Next kastar rensningen inte", () => {
    next.state.inAction = false;
    next.state.inNext = false;
    expect(() => invalidateUnpaidSettlements(ORG_A)).not.toThrow();
  });
});
