/**
 * Morgonbriefen (managerpaket 5) mot testdatabasen, med mockad modell: en gång per dag,
 * lås mot dubbla anrop, kontroll mot underlaget, nya försök efter fel (högst tre),
 * månadstaket (briefen räknas in i monthCostOre), rollerna och RLS på ai_briefs.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { budgetState } from "@/server/assistant/advisor/service";
import type { BriefFacts } from "@/server/assistant/brief/facts";
import type { BriefModel, BriefRequest } from "@/server/assistant/brief/model";
import {
  BRIEF_MAX_ATTEMPTS,
  ensureBrief,
  readBriefFor,
  runBriefsForAll,
} from "@/server/assistant/brief/service";
import type { Viewer } from "@/server/data/core/loaders";

import { seedAssistantFixture, viewerFor, type AssistantFixture } from "./assistent-fixture";
import { asUser, attempt, createMember, db, rows } from "./helpers";

const NOW = new Date("2025-03-12T08:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "test", AI_MONTHLY_BUDGET_SEK: "100000" };
const USAGE = { inputTokens: 1200, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 };

function factsOf(request: BriefRequest): BriefFacts {
  const json = request.message.match(/<underlag>\n([\s\S]*)\n<\/underlag>/)![1]!;
  return JSON.parse(json) as BriefFacts;
}

/** Mockad modell: raderna citerar underlaget; `invent` lägger in ett påhittat tal. */
function mockModel(calls: BriefRequest[] = [], options: { invent?: boolean } = {}): BriefModel {
  return {
    model: "claude-sonnet-5-5",
    async write(request) {
      calls.push(request);
      const f = factsOf(request);
      return {
        stopReason: "tool_use",
        model: "claude-sonnet-5-5",
        usage: USAGE,
        toolInput: {
          igar: options.invent
            ? "Rekorddag med 12 345 kr."
            : `${f.igar.intakt} på ${f.igar.kop} köp i går.`,
          fel: f.fel[0] ?? "Inget akut.",
          gor_idag: f.gorIdag[0] ?? "Inget att göra.",
        },
      };
    },
  };
}

const failing: BriefModel = {
  model: "claude-sonnet-5-5",
  async write() {
    throw new Error("API nere");
  },
};

let fx: AssistantFixture;
let owner: Viewer;

beforeAll(async () => {
  fx = await seedAssistantFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
});

describe("ensureBrief", () => {
  it("tar fram tre rader ur gårdagen och Att göra, sparar kostnaden", async () => {
    const calls: BriefRequest[] = [];
    const r = await ensureBrief({
      viewer: owner,
      trigger: "visit",
      now: NOW,
      env: ENV,
      model: mockModel(calls),
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.fresh).toBe(true);
    expect(r.brief.date).toBe("2025-03-12");

    // Underlaget: i går (11 mars, en order) mot tisdagen veckan före (4 mars, en order).
    const f = factsOf(calls[0]!);
    expect(f.datum).toBe("2025-03-11");
    expect(f.veckodag).toBe("tisdag");
    expect(f.igar.kop).toBe(1);
    expect(f.igar.motForraVeckan).not.toBeNull();
    expect(r.brief.lines.yesterday).toBe(`${f.igar.intakt} på 1 köp i går.`);

    const [row] = await rows<{
      status: string;
      trigger: string;
      attempts: number;
      cost_ore: number;
      input_tokens: number;
    }>(
      db(),
      sql`select status, trigger, attempts, cost_ore, input_tokens from ai_briefs
          where organization_id = ${fx.orgId} and brief_date = '2025-03-12'`,
    );
    expect(row).toMatchObject({ status: "ok", trigger: "visit", attempts: 1, input_tokens: 1200 });
    expect(row!.cost_ore).toBeGreaterThan(0);
  });

  it("samma dag: den sparade briefen, inget nytt anrop", async () => {
    const calls: BriefRequest[] = [];
    const r = await ensureBrief({
      viewer: owner,
      trigger: "cron",
      now: NOW,
      env: ENV,
      model: mockModel(calls),
    });
    expect(r).toMatchObject({ status: "ok", fresh: false });
    expect(calls).toHaveLength(0);
    expect(await readBriefFor(owner, NOW, ENV)).toEqual(r.status === "ok" ? r.brief : null);
  });

  it("utan AI visas ingen brief, även om den finns", async () => {
    expect(await readBriefFor(owner, NOW, {})).toBeNull();
    expect((await ensureBrief({ viewer: owner, trigger: "visit", now: NOW, env: {} })).status).toBe(
      "off",
    );
  });

  it("ett påhittat tal byts mot den fasta raden", async () => {
    // I går = lördag 8 mars, med en order.
    const day = new Date("2025-03-09T08:00:00Z");
    const calls: BriefRequest[] = [];
    const r = await ensureBrief({
      viewer: owner,
      trigger: "visit",
      now: day,
      env: ENV,
      model: mockModel(calls, { invent: true }),
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const f = factsOf(calls[0]!);
    expect(r.brief.lines.yesterday).toContain(f.igar.intakt);
    expect(r.brief.lines.yesterday).not.toContain("12 345");
    const [row] = await rows<{ rejected: Array<{ line: string; reason: string }> }>(
      db(),
      sql`select rejected from ai_briefs where organization_id = ${fx.orgId} and brief_date = '2025-03-09'`,
    );
    expect(row!.rejected).toEqual([
      { line: "yesterday", reason: "tal utanför underlaget: 12 345" },
    ]);
  });

  it("två besök samtidigt blir ett anrop", async () => {
    const day = new Date("2025-03-14T08:00:00Z");
    const calls: BriefRequest[] = [];
    const model = mockModel(calls);
    const [a, b] = await Promise.all([
      ensureBrief({ viewer: owner, trigger: "visit", now: day, env: ENV, model }),
      ensureBrief({ viewer: owner, trigger: "visit", now: day, env: ENV, model }),
    ]);
    expect(calls).toHaveLength(1);
    // Den andra väntar på låset och ser antingen en pågående körning eller den färdiga.
    expect([a, b].filter((r) => r.status === "ok" && r.fresh)).toHaveLength(1);
    expect([a.status, b.status].every((s) => s === "ok" || s === "busy")).toBe(true);
  });

  it("fel från API:t: nytt försök vid nästa besök, högst tre", async () => {
    const day = new Date("2025-03-15T08:00:00Z");
    for (let i = 0; i < BRIEF_MAX_ATTEMPTS; i++) {
      const r = await ensureBrief({
        viewer: owner,
        trigger: "visit",
        now: day,
        env: ENV,
        model: failing,
      });
      expect(r.status).toBe("error");
    }
    const calls: BriefRequest[] = [];
    const last = await ensureBrief({
      viewer: owner,
      trigger: "visit",
      now: day,
      env: ENV,
      model: mockModel(calls),
    });
    expect(last.status).toBe("gave-up");
    expect(calls).toHaveLength(0);
    const [row] = await rows<{ status: string; attempts: number; error: string }>(
      db(),
      sql`select status, attempts, error from ai_briefs where organization_id = ${fx.orgId} and brief_date = '2025-03-15'`,
    );
    expect(row).toMatchObject({ status: "error", attempts: 3, error: "API nere" });
  });

  it("räknas in i månadstaket; när taket är nått görs inget anrop", async () => {
    const before = await budgetState(db(), NOW, ENV);
    const day = new Date("2025-03-16T08:00:00Z");
    const r = await ensureBrief({
      viewer: owner,
      trigger: "visit",
      now: day,
      env: ENV,
      model: mockModel(),
    });
    expect(r.status).toBe("ok");
    const [cost] = await rows<{ cost_ore: number }>(
      db(),
      sql`select cost_ore from ai_briefs where organization_id = ${fx.orgId} and brief_date = '2025-03-16'`,
    );
    const after = await budgetState(db(), NOW, ENV);
    expect(after.spentOre - before.spentOre).toBeGreaterThanOrEqual(cost!.cost_ore);

    const calls: BriefRequest[] = [];
    const capped = await ensureBrief({
      viewer: owner,
      trigger: "visit",
      now: new Date("2025-03-17T08:00:00Z"),
      env: { ...ENV, AI_MONTHLY_BUDGET_SEK: "0.01" },
      model: mockModel(calls),
    });
    expect(capped.status).toBe("budget");
    expect(calls).toHaveLength(0);
  });

  it("läsare och påfyllare får ingen brief och kan inte ta fram en", async () => {
    for (const role of ["viewer", "refiller"] as const) {
      const viewer = await viewerFor(await createMember(fx.orgId, role), fx.orgId);
      const calls: BriefRequest[] = [];
      const r = await ensureBrief({
        viewer,
        trigger: "visit",
        now: new Date("2025-03-18T08:00:00Z"),
        env: ENV,
        model: mockModel(calls),
      });
      expect(r.status).toBe("no-access");
      expect(calls).toHaveLength(0);
      expect(await readBriefFor(viewer, NOW, ENV)).toBeNull();
    }
  });
});

describe("runBriefsForAll", () => {
  it("tar fram briefen för organisationer med försäljning, som ägaren", async () => {
    const other = await seedAssistantFixture();
    const calls: BriefRequest[] = [];
    const r = await runBriefsForAll({
      now: new Date("2025-03-19T05:00:00Z"),
      env: ENV,
      model: mockModel(calls),
    });
    expect(r.organizations.find((o) => o.id === other.orgId)?.status).toBe("ok");
    const [row] = await rows<{ trigger: string }>(
      db(),
      sql`select trigger from ai_briefs where organization_id = ${other.orgId} and brief_date = '2025-03-19'`,
    );
    expect(row!.trigger).toBe("cron");
  });
});

describe("RLS på ai_briefs", () => {
  it("ägare och admin läser; läsare, påfyllare och andra organisationer ser inget", async () => {
    const count = (u: { id: string; email: string }) =>
      asUser(u, async (tx) => {
        const [r] = await rows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from ai_briefs where organization_id = ${fx.orgId}`,
        );
        return r!.n;
      });
    const own = await count(fx.owner);
    expect(own).toBeGreaterThan(0);
    expect(await count(await createMember(fx.orgId, "admin"))).toBe(own);
    for (const role of ["viewer", "refiller"] as const) {
      expect(await count(await createMember(fx.orgId, role))).toBe(0);
    }
    const stranger = await seedAssistantFixture();
    expect(await count(stranger.owner)).toBe(0);
  });

  it("ingen klientroll får skriva eller ändra briefen", async () => {
    await asUser(fx.owner, async (tx) => {
      const ins = await attempt(tx, (sp) =>
        sp.execute(
          sql`insert into ai_briefs (organization_id, brief_date, trigger, model)
              values (${fx.orgId}, '2025-04-01', 'visit', 'x')`,
        ),
      );
      expect(ins.code).toBe("42501");
      const upd = await attempt(tx, (sp) =>
        sp.execute(sql`update ai_briefs set line_today = 'Påhittat'`),
      );
      expect(upd.code).toBe("42501");
      const del = await attempt(tx, (sp) => sp.execute(sql`delete from ai_briefs`));
      expect(del.code).toBe("42501");
    });
  });

  it("en ok-brief måste ha tre rader; en rad per organisation och dag", async () => {
    await db().transaction(async (tx) => {
      const bad = await attempt(tx, (sp) =>
        sp.execute(
          sql`insert into ai_briefs (organization_id, brief_date, trigger, status, model)
              values (${fx.orgId}, '2025-04-02', 'visit', 'ok', 'x')`,
        ),
      );
      expect(bad.code).toBe("23514");
      const dup = await attempt(tx, (sp) =>
        sp.execute(
          sql`insert into ai_briefs (organization_id, brief_date, trigger, model)
              values (${fx.orgId}, '2025-03-12', 'visit', 'x')`,
        ),
      );
      expect(dup.code).toBe("23505");
    });
  });
});
