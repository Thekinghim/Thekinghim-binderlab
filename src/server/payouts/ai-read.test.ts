import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const budget = vi.hoisted(() => ({ exceeded: false }));
vi.mock("@/server/assistant/advisor/service", () => ({
  DEFAULT_ADVISOR_MODEL: "claude-sonnet-5-5",
  advisorConfigFrom: () => ({ status: "ready", apiKey: "x", model: "claude-sonnet-5-5" }),
  budgetState: async () => ({ spentOre: 0, budgetOre: 1, exceeded: budget.exceeded }),
  isDemoBlocked: (slug: string | null, env: Record<string, string | undefined>) =>
    env.NODE_ENV === "production" && (slug ?? "").startsWith("nordljus-demo"),
}));

import type { Db } from "@/db/client";

import { extractedFromTool, krToOre, readPayoutWithAi, type PayoutReaderModel } from "./ai-read";

function fakeDb(readsToday = 0) {
  const calls: string[] = [];
  const db = {
    execute: async (q: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(q);
      calls.push(text);
      if (text.includes("count(*)")) return [{ n: readsToday }];
      if (text.includes("insert into public.ai_runs"))
        return [{ id: "00000000-0000-4000-8000-000000000001" }];
      return [];
    },
  } as unknown as Db;
  return { db, calls };
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const reader = (toolInput: unknown): PayoutReaderModel => ({
  model: "claude-sonnet-5-5",
  read: async () => ({ toolInput, model: "claude-sonnet-5-5", usage }),
});
const base = {
  organizationId: "00000000-0000-4000-8000-000000000002",
  organizationSlug: "test",
  userId: null,
  input: { kind: "text" as const, text: "a;b" },
  byteLength: 10,
  env: {},
  now: new Date("2026-11-15T10:00:00Z"),
};

describe("extractedFromTool", () => {
  it("gör kronor till öre och markerar AI-fälten", () => {
    const r = extractedFromTool({
      paid_on: "2026-11-13",
      amount_kr: 48210,
      fees_kr: 1790,
      gross_kr: 50000,
      period_from: "2026-11-03",
      period_to: "2026-11-09",
      confidence: "high",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.extracted).toMatchObject({
      amountOre: 4_821_000,
      feesOre: 179_000,
      periodTo: "2026-11-09",
    });
    expect(r.extracted.aiFields).toContain("amountOre");
    expect(r.warnings).toEqual([]);
  });
  it("varnar när summorna inte går ihop", () => {
    const r = extractedFromTool({ amount_kr: 100, fees_kr: 5, gross_kr: 200, confidence: "low" });
    expect(r.ok && r.warnings[0]).toEqual({ code: "SUMS_MISMATCH", diffOre: 9500 });
  });
  it("nekar fel form och annan valuta", () => {
    expect(extractedFromTool("inte json").ok).toBe(false);
    expect(extractedFromTool({ amount_kr: "mycket" }).ok).toBe(false);
    expect(extractedFromTool({ amount_kr: 10, currency: "EUR" }).ok).toBe(false);
  });
  it("tar inte mer än två decimaler", () => {
    expect(krToOre(12.345)).toBeNull();
    expect(krToOre(12.34)).toBe(1234);
  });
});

describe("readPayoutWithAi", () => {
  it("läser med modellen och loggar körningen", async () => {
    const { db, calls } = fakeDb();
    const r = await readPayoutWithAi({
      ...base,
      db,
      reader: reader({ amount_kr: 10, confidence: "high" }),
    });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.includes("payout_read"))).toBe(true);
  });
  it("ett ogiltigt svar blir inget utkast", async () => {
    const { db } = fakeDb();
    const r = await readPayoutWithAi({ ...base, db, reader: reader({ amount_kr: "x" }) });
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
  });
  it("demon i produktion anropar inte modellen", async () => {
    const { db, calls } = fakeDb();
    const read = vi.fn();
    const r = await readPayoutWithAi({
      ...base,
      db,
      organizationSlug: "nordljus-demo-1",
      env: { NODE_ENV: "production" },
      reader: { model: "m", read },
    });
    expect(r).toMatchObject({ ok: false, reason: "demo" });
    expect(read).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
  it("när budgeten är slut", async () => {
    budget.exceeded = true;
    const { db } = fakeDb();
    const r = await readPayoutWithAi({ ...base, db, reader: reader({}) });
    budget.exceeded = false;
    expect(r).toMatchObject({
      ok: false,
      reason: "budget",
      message: "AI-budgeten är slut, fyll i för hand.",
    });
  });
  it("högst 20 per dygn och 10 MB", async () => {
    const { db } = fakeDb(20);
    expect(await readPayoutWithAi({ ...base, db, reader: reader({}) })).toMatchObject({
      reason: "rate",
    });
    expect(
      await readPayoutWithAi({
        ...base,
        db: fakeDb().db,
        byteLength: 11 * 1024 * 1024,
        reader: reader({}),
      }),
    ).toMatchObject({ reason: "too_large" });
  });
  it("ett fel från modellen", async () => {
    const { db } = fakeDb();
    const r = await readPayoutWithAi({
      ...base,
      db,
      reader: { model: "m", read: async () => Promise.reject(new Error("nätet")) },
    });
    expect(r).toMatchObject({ ok: false, reason: "error" });
  });
});
