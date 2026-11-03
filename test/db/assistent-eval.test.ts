/**
 * Utvärderingen offline: varje fråga i EVAL_CASES (src/server/assistant/eval/cases.ts)
 * ställs till assistenten med den lokala testmodellen mot seedens data, som i AI-panelen
 * (med sidans sammanhang när frågan har en sida). Kontrollerar att rätt verktyg anropas med
 * rätt parametrar, att svaret klarar kontrollen av talen (alla tal finns i underlaget), att
 * knappar föreslås där det ska, och för några frågor att svaret har exakt talet som
 * beräkningslagret ger för seeden.
 *
 * Ingen AI: den lokala modellen väljer verktyg med nyckelord. Samma frågor körs mot Claude
 * API med scripts/assistant-eval.ts (opt-in).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { keyMetrics, profitability } from "@/domain";
import { LocalFileStore } from "@/import/file-store";
import { formatSek } from "@/lib/format";
import { listOrganizationsFor } from "@/server/access";
import { EVAL_CASES, EVAL_NOW } from "@/server/assistant/eval/cases";
import { createLocalModelClient } from "@/server/assistant/local-model";
import { pageContextFromUrl } from "@/server/assistant/page-context";
import type { AssistantEvent } from "@/server/assistant/protocol";
import { askAssistant } from "@/server/assistant/service";
import { loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";
import { runSeed } from "@/seed/run-seed";

import { db, createMember, uniqueSuffix } from "./helpers";
import { viewerFor } from "./assistent-fixture";

const NOW = new Date(EVAL_NOW);
const READY = { status: "ready", provider: "local", model: "lokal-testmodell" } as const;
const OCT = { start: "2026-10-01", end: "2026-10-31" };

let owner: Viewer;
let refiller: Viewer;
const kr = (ore: number) => formatSek(ore / 100);

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-eval",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-eval-"))),
    organization: { name: `Eval ${suffix}`, slug: `eval-${suffix}` },
    users: {
      owner: { email: `eval-agare-${suffix}@test.binderlab.se`, fullName: "Ägare", role: "owner" },
      partner: {
        email: `eval-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  const user = { userId: seeded.users.owner, email: `eval-agare-${suffix}@test.binderlab.se` };
  const organization = (await listOrganizationsFor(user)).find(
    (o) => o.id === seeded.organizationId,
  )!;
  owner = { user, organization };
  const member = await createMember(seeded.organizationId, "refiller");
  refiller = await viewerFor(member, seeded.organizationId);
}, 180_000);

async function ask(question: string, viewer: Viewer, page?: string) {
  const events: AssistantEvent[] = [];
  const [pathname, search = ""] = (page ?? "").split("?");
  await askAssistant({
    viewer,
    question,
    conversationId: randomUUID(),
    emit: (e) => events.push(e),
    now: NOW,
    config: READY,
    client: createLocalModelClient(),
    page: page ? pageContextFromUrl(pathname!, search ? `?${search}` : "") : null,
  });
  const calls = events.filter(
    (e): e is Extract<AssistantEvent, { type: "tool_call" }> => e.type === "tool_call",
  );
  const done = events.find(
    (e): e is Extract<AssistantEvent, { type: "done" }> => e.type === "done",
  );
  const error = events.find((e) => e.type === "error");
  return { calls, done, error, events };
}

describe("utvärdering: verktygsval och kontroll mot seedens data", () => {
  it(`har minst 20 frågor`, () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
  });

  for (const c of EVAL_CASES) {
    it(`${c.id}: "${c.question}" → ${c.tool}`, async () => {
      const viewer = c.role === "refiller" ? refiller : owner;
      const { calls, done, error } = await ask(c.question, viewer, c.page);
      expect(error, JSON.stringify(error)).toBeUndefined();
      const call = calls.find((x) => x.name === c.tool);
      expect(call, `anrop: ${calls.map((x) => x.name).join(", ")}`).toBeDefined();
      if (c.input) expect(call!.input).toMatchObject(c.input);
      expect(done?.status, done?.answer).toBe("answered");
      expect(done!.verification.unverified).toEqual([]);
      expect(done!.answer.length).toBeGreaterThan(10);
      if (c.button) expect(done!.actions?.length ?? 0).toBeGreaterThan(0);
    }, 60_000);
  }
});

describe("utvärdering: talen i svaret är beräkningslagrets", () => {
  it("oktobers vinst", async () => {
    const data = await loadDomainInputFor(owner, { period: OCT, compare: null }, NOW);
    const profit = kr(keyMetrics(data.current).profitOre);
    const { done } = await ask("Hur gick oktober?", owner);
    expect(done!.answer).toContain(profit);
  }, 60_000);

  it("automaten som tjänade mest i oktober, med sin vinst", async () => {
    const data = await loadDomainInputFor(owner, { period: OCT, compare: null }, NOW);
    const top = profitability(data.current, "machine")
      .rows.filter((r) => r.kind === "item")
      .sort((a, b) => b.profitOre - a.profitOre)[0]!;
    const machine = data.machines.find((m) => m.id === top.key)!;
    const { done } = await ask("Vilken automat tjänade mest i oktober?", owner);
    expect(done!.answer).toContain(machine.code);
    expect(done!.answer).toContain(kr(top.profitOre));
  }, 60_000);

  it("butiken som tjänade mest i oktober", async () => {
    const data = await loadDomainInputFor(owner, { period: OCT, compare: null }, NOW);
    const top = profitability(data.current, "store")
      .rows.filter((r) => r.kind === "item")
      .sort((a, b) => b.profitOre - a.profitOre)[0]!;
    const store = data.stores.find((s) => s.id === top.key)!;
    const { done } = await ask("Vilken butik tjänade mest i oktober?", owner);
    expect(done!.answer).toContain(store.name);
    expect(done!.answer).toContain(kr(top.profitOre));
  }, 60_000);

  it("förändringen mot perioden före har rätt tecken och belopp", async () => {
    const cur = await loadDomainInputFor(
      owner,
      {
        period: { start: "2026-10-26", end: "2026-11-01" },
        compare: { start: "2026-10-19", end: "2026-10-25" },
      },
      NOW,
    );
    const diff = keyMetrics(cur.current).profitOre - keyMetrics(cur.previous!).profitOre;
    const text = diff === 0 ? kr(0) : diff > 0 ? `+${kr(diff)}` : `−${kr(-diff)}`;
    const { done } = await ask("Hur gick förra veckan jämfört med veckan innan?", owner);
    expect(done!.answer).toContain(text);
  }, 60_000);

  it("sidans sammanfattning följer med som underlag (prefetch) och visas", async () => {
    const { events } = await ask(
      "Förklara vinsten",
      owner,
      "/lonsamhet?from=2026-10-13&to=2026-11-01",
    );
    const prefetched = events.filter(
      (e): e is Extract<AssistantEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.call.prefetched === true,
    );
    expect(prefetched).toHaveLength(1);
    expect(prefetched[0]!.call.name).toBe("nyckeltal");
    expect(prefetched[0]!.call.input).toMatchObject({ fran: "2026-10-13", till: "2026-11-01" });
  }, 60_000);

  it("påfyllaren får aldrig belopp, inte heller i sidans sammanfattning", async () => {
    const { events, done } = await ask("Vad behöver fyllas på i dag?", refiller, "/lager");
    expect(done!.answer).not.toMatch(/\bkr\b/);
    for (const e of events) {
      if (e.type === "tool_result")
        expect(JSON.stringify(e.call.result)).not.toMatch(/Ore"|\bkr\b/);
    }
  }, 60_000);
});
