/**
 * AI-rådgivaren mot testdatabasen, med mockad modell: RLS på ai_runs och ai_suggestions,
 * kontrollen mot underlaget, gränsen 3 knapptryck per dag, cron en gång per dag och
 * månadstaket (även för assistentens frågor).
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { AdvisorModel, AdvisorRequest } from "@/server/assistant/advisor/model";
import {
  budgetState,
  isDemoBlocked,
  loadAdvisorStateFor,
  runAdvisor,
  runAdvisorForAll,
  setSuggestionStatusFor,
} from "@/server/assistant/advisor/service";
import type { Snapshot } from "@/server/assistant/advisor/snapshot";
import type { AssistantEvent } from "@/server/assistant/protocol";
import { askAssistant } from "@/server/assistant/service";
import type { Viewer } from "@/server/data/core/loaders";

import { seedAssistantFixture, viewerFor, type AssistantFixture } from "./assistent-fixture";
import { asUser, attempt, createMember, db, rows } from "./helpers";

const NOW = new Date("2025-03-12T09:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "test", AI_MONTHLY_BUDGET_SEK: "1000" };
const USAGE = { inputTokens: 3000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 2500 };

/** Mockad modell: ett förslag med tal ur underlaget och ett med ett påhittat tal. */
function mockModel(calls: AdvisorRequest[] = []): AdvisorModel {
  return {
    model: "claude-sonnet-5-5",
    async propose(request) {
      calls.push(request);
      const snap = JSON.parse(request.snapshot) as Snapshot;
      const top = snap.titlar[0]!;
      return {
        stopReason: "tool_use",
        model: "claude-sonnet-5-5",
        usage: USAGE,
        toolInput: {
          forslag: [
            {
              titel: `Satsa på ${top.titel}`,
              varfor: `${top.titel} gav ${top.vinst30} i vinst på ${top.order30} order.`,
              atgard: `Lägg ${top.titel} i fler fack.`,
              effekt_kr_per_manad: 50,
              sakerhet: "medel",
            },
            {
              titel: "Höj priset",
              varfor: "Priset kan höjas med 17 kr.",
              atgard: "Höj priset.",
              effekt_kr_per_manad: 10,
              sakerhet: "lag",
            },
          ],
        },
      };
    },
  };
}

let fx: AssistantFixture;
let owner: Viewer;

beforeAll(async () => {
  fx = await seedAssistantFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
});

describe("runAdvisor", () => {
  it("sparar förslag som klarar kontrollen och kastar de andra", async () => {
    const calls: AdvisorRequest[] = [];
    const r = await runAdvisor({
      viewer: owner,
      trigger: "manual",
      now: NOW,
      env: ENV,
      model: mockModel(calls),
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([{ title: "Höj priset", reason: "tal utanför underlaget: 17" }]);
    expect(r.costOre).toBeGreaterThan(0);

    // Underlaget gäller de 30 dagarna t.o.m. i går och har med titlarna.
    const snap = JSON.parse(calls[0]!.snapshot) as Snapshot;
    expect(snap.perioder.d30.end).toBe("2025-03-11");
    expect(snap.titlar.length).toBe(2);
    expect(calls[0]!.message).toContain("Inga tidigare förslag");

    const [run] = await rows<{
      status: string;
      accepted: number;
      cost_ore: number;
      input_tokens: number;
    }>(
      db(),
      sql`select status, accepted, cost_ore, input_tokens from ai_runs where id = ${r.runId}`,
    );
    expect(run).toEqual({ status: "ok", accepted: 1, cost_ore: r.costOre, input_tokens: 3000 });

    const state = await loadAdvisorStateFor(owner, NOW);
    expect(state!.suggestions).toHaveLength(1);
    expect(state!.suggestions[0]!.confidence).toBe("medium");
    expect(state!.manualLeft).toBe(2);
  });

  it("nästa körning får tidigare förslag så att de inte upprepas", async () => {
    const calls: AdvisorRequest[] = [];
    await runAdvisor({
      viewer: owner,
      trigger: "manual",
      now: NOW,
      env: ENV,
      model: mockModel(calls),
    });
    expect(calls[0]!.message).toContain("Redan föreslaget");
    expect(calls[0]!.message).toContain("Satsa på");
  });

  it("högst 3 knapptryck per dag och organisation", async () => {
    const calls: AdvisorRequest[] = [];
    const third = await runAdvisor({
      viewer: owner,
      trigger: "manual",
      now: NOW,
      env: ENV,
      model: mockModel(calls),
    });
    expect(third.status).toBe("ok");
    const fourth = await runAdvisor({
      viewer: owner,
      trigger: "manual",
      now: NOW,
      env: ENV,
      model: mockModel(calls),
    });
    expect(fourth.status).toBe("rate-limited");
    expect(calls).toHaveLength(1);
  });

  it("cron kör en gång per dag", async () => {
    const first = await runAdvisor({
      viewer: owner,
      trigger: "cron",
      now: NOW,
      env: ENV,
      model: mockModel(),
    });
    expect(first.status).toBe("ok");
    const again = await runAdvisor({
      viewer: owner,
      trigger: "cron",
      now: NOW,
      env: ENV,
      model: mockModel(),
    });
    expect(again.status).toBe("skipped");
  });

  it("läsare och påfyllare kan inte köra rådgivaren", async () => {
    for (const role of ["viewer", "refiller"] as const) {
      const member = await createMember(fx.orgId, role);
      const viewer = await viewerFor(member, fx.orgId);
      await expect(
        runAdvisor({ viewer, trigger: "manual", now: NOW, env: ENV, model: mockModel() }),
      ).rejects.toThrow();
      expect(await loadAdvisorStateFor(viewer, NOW)).toBeNull();
    }
  });

  it("modellen anropar inte verktyget: körningen blir error, inga förslag", async () => {
    const other = await seedAssistantFixture();
    const viewer = await viewerFor(other.owner, other.orgId);
    const r = await runAdvisor({
      viewer,
      trigger: "manual",
      now: NOW,
      env: ENV,
      model: {
        model: "claude-sonnet-5-5",
        propose: async () => ({
          toolInput: null,
          stopReason: "end_turn",
          model: "claude-sonnet-5-5",
          usage: USAGE,
        }),
      },
    });
    expect(r.status).toBe("error");
    expect((await loadAdvisorStateFor(viewer, NOW))!.suggestions).toEqual([]);
  });
});

describe("RLS på ai_runs och ai_suggestions", () => {
  it("ägare och admin läser; läsare, påfyllare och andra organisationer ser inget", async () => {
    const count = (u: { id: string; email: string }) =>
      asUser(u, async (tx) => {
        const [r] = await rows<{ runs: number; sugg: number }>(
          tx,
          sql`select (select count(*)::int from ai_runs where organization_id = ${fx.orgId}) as runs,
                     (select count(*)::int from ai_suggestions where organization_id = ${fx.orgId}) as sugg`,
        );
        return r!;
      });
    const own = await count(fx.owner);
    expect(own.runs).toBeGreaterThan(0);
    expect(own.sugg).toBeGreaterThan(0);
    const admin = await createMember(fx.orgId, "admin");
    expect(await count(admin)).toEqual(own);
    for (const role of ["viewer", "refiller"] as const) {
      expect(await count(await createMember(fx.orgId, role))).toEqual({ runs: 0, sugg: 0 });
    }
    const stranger = await seedAssistantFixture();
    expect(await count(stranger.owner)).toEqual({ runs: 0, sugg: 0 });
  });

  it("ingen klientroll får skriva körningar eller förslag; ägaren ändrar bara status", async () => {
    const [s] = await rows<{ id: string; run_id: string }>(
      db(),
      sql`select id, run_id from ai_suggestions where organization_id = ${fx.orgId} limit 1`,
    );
    await asUser(fx.owner, async (tx) => {
      const ins = await attempt(tx, (sp) =>
        sp.execute(
          sql`insert into ai_runs (organization_id, trigger, model) values (${fx.orgId}, 'manual', 'x')`,
        ),
      );
      expect(ins.code).toBe("42501");
      const insS = await attempt(tx, (sp) =>
        sp.execute(sql`insert into ai_suggestions (organization_id, run_id, rank, title, why, action, effect_sek_month, confidence)
                       values (${fx.orgId}, ${s!.run_id}, 5, 'x', 'x', 'x', 0, 'low')`),
      );
      expect(insS.code).toBe("42501");
      const upd = await attempt(tx, (sp) =>
        sp.execute(sql`update ai_suggestions set title = 'Påhittat' where id = ${s!.id}`),
      );
      expect(upd.code).toBe("42501");
      const updRun = await attempt(tx, (sp) => sp.execute(sql`update ai_runs set cost_ore = 0`));
      expect(updRun.code).toBe("42501");
    });
  });

  it("statusändring: vem och när sätts av databasen, läsaren kan inte ändra", async () => {
    const [s] = await rows<{ id: string }>(
      db(),
      sql`select id from ai_suggestions where organization_id = ${fx.orgId} and status = 'new' limit 1`,
    );
    const reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
    await expect(setSuggestionStatusFor(reader, s!.id, "done")).rejects.toThrow();

    expect(await setSuggestionStatusFor(owner, s!.id, "done")).toBe(true);
    const [after] = await rows<{ status: string; status_by: string; status_at: Date | null }>(
      db(),
      sql`select status, status_by, status_at from ai_suggestions where id = ${s!.id}`,
    );
    expect(after!.status).toBe("done");
    expect(after!.status_by).toBe(fx.owner.id);
    expect(after!.status_at).not.toBeNull();
    const state = await loadAdvisorStateFor(owner, NOW);
    expect(state!.suggestions.map((x) => x.id)).not.toContain(s!.id);

    expect(await setSuggestionStatusFor(owner, s!.id, "new")).toBe(true);
    const [back] = await rows<{ status_by: string | null }>(
      db(),
      sql`select status_by from ai_suggestions where id = ${s!.id}`,
    );
    expect(back!.status_by).toBeNull();
    // En annan organisations ägare når inte förslaget.
    const stranger = await seedAssistantFixture();
    expect(
      await setSuggestionStatusFor(await viewerFor(stranger.owner, stranger.orgId), s!.id, "done"),
    ).toBe(false);
  });
});

describe("månadstaket", () => {
  it("räknar rådgivaren och assistentens frågor; nått tak stoppar båda utan anrop", async () => {
    const spent = await budgetState(db(), NOW, ENV);
    expect(spent.spentOre).toBeGreaterThan(0);
    const tight = { ...ENV, AI_MONTHLY_BUDGET_SEK: String(spent.spentOre / 100) };
    const calls: AdvisorRequest[] = [];
    const other = await seedAssistantFixture();
    const viewer = await viewerFor(other.owner, other.orgId);
    const r = await runAdvisor({
      viewer,
      trigger: "manual",
      now: NOW,
      env: tight,
      model: mockModel(calls),
    });
    expect(r.status).toBe("budget");
    expect(calls).toHaveLength(0);

    // Assistentens frågor: samma tak (process.env), ingen klient skapas.
    const previous = process.env.AI_MONTHLY_BUDGET_SEK;
    process.env.AI_MONTHLY_BUDGET_SEK = tight.AI_MONTHLY_BUDGET_SEK;
    try {
      const events: AssistantEvent[] = [];
      const res = await askAssistant({
        viewer,
        question: "Hur gick mars?",
        conversationId: randomUUID(),
        emit: (e) => events.push(e),
        now: NOW,
        config: {
          status: "ready",
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          apiKey: "test",
          effort: "high",
        },
      });
      expect(res.status).toBe("error");
      expect(events).toEqual([
        expect.objectContaining({
          type: "error",
          code: "budget",
          message: expect.stringContaining("AI-budget"),
        }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.AI_MONTHLY_BUDGET_SEK;
      else process.env.AI_MONTHLY_BUDGET_SEK = previous;
    }
  });

  it("cron stannar vid nått tak och hoppar över demo", async () => {
    const calls: AdvisorRequest[] = [];
    const r = await runAdvisorForAll({
      now: NOW,
      env: { ...ENV, AI_MONTHLY_BUDGET_SEK: "0.01" },
      model: mockModel(calls),
    });
    expect(calls).toHaveLength(0);
    expect(r.organizations.filter((o) => o.status === "budget").length).toBeLessThanOrEqual(1);
    expect(r.organizations.every((o) => ["budget", "skipped"].includes(o.status))).toBe(true);
  });

  it("demon anropar inte Claude i produktion (eget tak behövs inte)", async () => {
    expect(isDemoBlocked("nordljus-demo", { NODE_ENV: "production" })).toBe(true);
    expect(isDemoBlocked("nordljus-demo", { NODE_ENV: "development" })).toBe(false);
    expect(isDemoBlocked("kortkungen", { NODE_ENV: "production" })).toBe(false);
    const other = await seedAssistantFixture();
    const base = await viewerFor(other.owner, other.orgId);
    const viewer: Viewer = {
      ...base,
      organization: { ...base.organization, slug: "nordljus-demo" },
    };
    const r = await runAdvisor({
      viewer,
      trigger: "manual",
      now: NOW,
      env: { ...ENV, NODE_ENV: "production" },
    });
    expect(r.status).toBe("off");
  });
});
