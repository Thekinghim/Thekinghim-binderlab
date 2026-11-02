/**
 * Loggen över frågor och svar (assistant_logs): skrivs och läses som användaren med RLS.
 *
 * - Var och en skriver bara rader med sitt eget user_id och sin faktiska roll.
 * - Var och en läser sina egna rader; ägare och admin läser alla i organisationen.
 * - Ingen annan organisation ser något. Raderna ändras och raderas aldrig.
 * - Historiken i ett samtal kommer bara från användarens egna rader.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  getLogFor,
  insertLogFor,
  listRecentFor,
  loadConversationFor,
  type NewLogEntry,
} from "@/server/assistant/log";
import type { Viewer } from "@/server/data/core/loaders";

import { seedAssistantFixture, viewerFor, type AssistantFixture } from "./assistent-fixture";
import { asUser, attempt, createMember, rows } from "./helpers";

let fx: AssistantFixture;
let owner: Viewer;
let admin: Viewer;
let reader: Viewer;
let refiller: Viewer;
let otherOwner: Viewer;

function entry(v: Viewer, overrides: Partial<NewLogEntry> = {}): NewLogEntry {
  return {
    organizationId: v.organization.id,
    conversationId: randomUUID(),
    role: v.organization.role,
    question: "Vilken automat tjänade mest i mars?",
    answer: "Automat 1 (BL-001) tjänade mest i mars 2025: 120 kr i vinst.",
    status: "answered",
    provider: "local",
    model: "lokal-testmodell",
    toolCalls: [
      {
        id: "toolu_1",
        name: "lonsamhet",
        label: "Lönsamhet per automat",
        input: { fran: "2025-03-01", till: "2025-03-31", per: "automat" },
        ok: true,
        summary: "…",
        figures: [],
        links: [],
        result: { sammanfattning: "…", data: { vinst: "120 kr" } },
        durationMs: 12,
      },
    ],
    verification: { checked: 1, unverified: [] },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, turns: 2 },
    error: null,
    durationMs: 40,
    ...overrides,
  };
}

beforeAll(async () => {
  fx = await seedAssistantFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  admin = await viewerFor(await createMember(fx.orgId, "admin"), fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
  const other = await seedAssistantFixture();
  otherOwner = await viewerFor(other.owner, other.orgId);
});

describe("skriva", () => {
  it("alla roller, även påfyllaren, loggar sina egna frågor", async () => {
    for (const v of [owner, admin, reader, refiller]) {
      const id = await insertLogFor(v.user, entry(v));
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("nekar en rad med någon annans user_id", async () => {
    const outcome = await asUser({ id: reader.user.userId, email: reader.user.email }, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.assistant_logs
          (organization_id, conversation_id, user_id, role, question, status, provider, model)
          values (${fx.orgId}, gen_random_uuid(), ${owner.user.userId}, 'viewer', 'x', 'answered', 'local', 'm')`),
      ),
    );
    expect(outcome.code).toBe("42501");
  });

  it("nekar en rad med en roll användaren inte har (påfyllare som loggar sig som ägare)", async () => {
    await expect(
      insertLogFor(refiller.user, { ...entry(refiller), role: "owner" }),
    ).rejects.toThrow();
  });

  it("nekar en rad i en annan organisation", async () => {
    await expect(
      insertLogFor(owner.user, { ...entry(owner), organizationId: otherOwner.organization.id }),
    ).rejects.toThrow();
  });
});

describe("läsa", () => {
  it("läsaren och påfyllaren ser bara sina egna rader", async () => {
    const mine = await insertLogFor(reader.user, entry(reader, { question: "Läsarens fråga" }));
    const ownersRow = await insertLogFor(owner.user, entry(owner, { question: "Ägarens fråga" }));
    expect(await getLogFor(reader.user, fx.orgId, mine)).not.toBeNull();
    expect(await getLogFor(reader.user, fx.orgId, ownersRow)).toBeNull();
    expect(await getLogFor(refiller.user, fx.orgId, ownersRow)).toBeNull();
    const recent = await listRecentFor(refiller.user, fx.orgId);
    expect(recent.every((r) => r.userId === refiller.user.userId)).toBe(true);
  });

  it("ägare och admin ser alla rader i organisationen", async () => {
    const readersRow = await insertLogFor(
      reader.user,
      entry(reader, { question: "Läsarens andra fråga" }),
    );
    expect((await getLogFor(owner.user, fx.orgId, readersRow))?.question).toBe(
      "Läsarens andra fråga",
    );
    expect((await getLogFor(admin.user, fx.orgId, readersRow))?.question).toBe(
      "Läsarens andra fråga",
    );
  });

  it("en annan organisation ser ingenting", async () => {
    const id = await insertLogFor(owner.user, entry(owner));
    expect(await getLogFor(otherOwner.user, fx.orgId, id)).toBeNull();
    const visible = await asUser(
      { id: otherOwner.user.userId, email: otherOwner.user.email },
      (tx) =>
        rows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.assistant_logs where organization_id = ${fx.orgId}`,
        ),
    );
    expect(visible[0]!.n).toBe(0);
  });

  it("loggen sparar verktygsanropen och kontrollen", async () => {
    const id = await insertLogFor(owner.user, entry(owner));
    const row = await getLogFor(owner.user, fx.orgId, id);
    expect(row?.toolCalls[0]?.name).toBe("lonsamhet");
    expect(row?.toolCalls[0]?.input).toEqual({
      fran: "2025-03-01",
      till: "2025-03-31",
      per: "automat",
    });
    expect(row?.verification).toEqual({ checked: 1, unverified: [] });
    expect(row?.provider).toBe("local");
  });
});

describe("append-only", () => {
  it("ägaren kan varken ändra eller radera en rad", async () => {
    const id = await insertLogFor(owner.user, entry(owner));
    const as = { id: owner.user.userId, email: owner.user.email };
    const update = await asUser(as, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.assistant_logs set answer = 'x' where id = ${id}`),
      ),
    );
    const remove = await asUser(as, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`delete from public.assistant_logs where id = ${id}`)),
    );
    expect(update.ok).toBe(false);
    expect(remove.ok).toBe(false);
    expect((await getLogFor(owner.user, fx.orgId, id))?.answer).not.toBe("x");
  });
});

describe("historik i ett samtal", () => {
  it("läser bara användarens egna besvarade frågor, äldst först", async () => {
    const conversationId = randomUUID();
    await insertLogFor(owner.user, entry(owner, { conversationId, question: "Första" }));
    await insertLogFor(
      owner.user,
      entry(owner, { conversationId, question: "Fel", status: "error", answer: "" }),
    );
    await insertLogFor(owner.user, entry(owner, { conversationId, question: "Andra" }));
    // Samma samtals-id hos en annan användare blandas inte in.
    await insertLogFor(admin.user, entry(admin, { conversationId, question: "Admins" }));
    const history = await loadConversationFor(owner.user, fx.orgId, conversationId);
    expect(history.map((h) => h.question)).toEqual(["Första", "Andra"]);
    expect(history[0]!.sources).toEqual([{ sammanfattning: "…", data: { vinst: "120 kr" } }]);
    expect(await loadConversationFor(owner.user, fx.orgId, "inte-ett-uuid")).toEqual([]);
  });
});
