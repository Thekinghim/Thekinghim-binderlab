/**
 * Loggen över frågor och svar (tabellen assistant_logs, append-only, RLS).
 *
 * Allt skrivs och läses som användaren (withUserDbFor): RLS kräver att raden har
 * användarens eget user_id och hens faktiska roll i organisationen. Var och en läser sina
 * egna rader; ägare och admin läser alla i organisationen.
 */

import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { assistantLogs, type MemberRole } from "@/db/schema";
import { isUuid, withUserDbFor, type SessionUser } from "@/server/access";

import type { HistoryEntry } from "./loop";
import type { AssistantStatus, AssistantUsage, ToolCallRecord, Verification } from "./protocol";

/** Största storlek på ett verktygsresultat i loggen (resten kortas). */
const MAX_RESULT_CHARS = 60_000;
/** Antal tidigare frågor i samtalet som skickas med som historik. */
export const HISTORY_LIMIT = 6;

export interface NewLogEntry {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly role: MemberRole;
  readonly question: string;
  readonly answer: string;
  readonly status: AssistantStatus;
  readonly provider: "anthropic" | "local";
  readonly model: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly verification: Verification;
  readonly usage: AssistantUsage;
  readonly error: string | null;
  readonly durationMs: number;
}

/** Ett verktygsanrop i loggen: resultatet kortas om det är mycket stort. */
function compactCall(call: ToolCallRecord): ToolCallRecord {
  const json = JSON.stringify(call.result ?? null);
  if (json.length <= MAX_RESULT_CHARS) return call;
  return {
    ...call,
    result: { kortat: true, tecken: json.length, sammanfattning: call.summary },
  };
}

/** Sparar frågan. Returnerar radens id. */
export async function insertLogFor(user: SessionUser, entry: NewLogEntry): Promise<string> {
  return withUserDbFor(user, async (tx) => {
    const [row] = await tx
      .insert(assistantLogs)
      .values({
        organizationId: entry.organizationId,
        conversationId: entry.conversationId,
        userId: user.userId,
        role: entry.role,
        question: entry.question,
        answer: entry.answer.slice(0, 50_000),
        status: entry.status,
        provider: entry.provider,
        model: entry.model,
        toolCalls: entry.toolCalls.map(compactCall) as unknown[],
        verification: { ...entry.verification },
        usage: { ...entry.usage },
        error: entry.error ? entry.error.slice(0, 2000) : null,
        durationMs: Math.max(0, Math.round(entry.durationMs)),
      })
      .returning({ id: assistantLogs.id });
    return row!.id;
  });
}

/** En rad i loggen som den visas på sidan. */
export interface LogRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string | null;
  readonly role: MemberRole;
  readonly question: string;
  readonly answer: string;
  readonly status: AssistantStatus;
  readonly provider: "anthropic" | "local";
  readonly model: string;
  readonly toolCalls: ToolCallRecord[];
  readonly verification: Verification;
  readonly durationMs: number;
  readonly error: string | null;
  readonly createdAt: string;
}

function toRecord(row: typeof assistantLogs.$inferSelect): LogRecord {
  const verification = row.verification as Partial<Verification>;
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    role: row.role,
    question: row.question,
    answer: row.answer,
    status: row.status,
    provider: row.provider,
    model: row.model,
    toolCalls: (Array.isArray(row.toolCalls) ? row.toolCalls : []) as ToolCallRecord[],
    verification: {
      checked: typeof verification.checked === "number" ? verification.checked : 0,
      unverified: Array.isArray(verification.unverified) ? verification.unverified.map(String) : [],
    },
    durationMs: row.durationMs,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Tidigare frågor i samtalet (användarens egna), äldst först, som historik till modellen.
 * Bara besvarade frågor; de senaste HISTORY_LIMIT.
 */
export async function loadConversationFor(
  user: SessionUser,
  organizationId: string,
  conversationId: string,
): Promise<HistoryEntry[]> {
  if (!isUuid(conversationId)) return [];
  const rows = await withUserDbFor(user, (tx) =>
    tx
      .select()
      .from(assistantLogs)
      .where(
        and(
          eq(assistantLogs.organizationId, organizationId),
          eq(assistantLogs.conversationId, conversationId),
          eq(assistantLogs.userId, user.userId),
          inArray(assistantLogs.status, ["answered", "unverified"]),
        ),
      )
      .orderBy(desc(assistantLogs.createdAt))
      .limit(HISTORY_LIMIT),
  );
  return rows.reverse().map((row) => {
    const record = toRecord(row);
    return {
      question: record.question,
      answer: record.answer,
      sources: record.toolCalls.filter((c) => c.ok).map((c) => c.result),
    };
  });
}

/** Användarens senaste frågor i organisationen, nyast först. */
export async function listRecentFor(
  user: SessionUser,
  organizationId: string,
  limit = 20,
): Promise<LogRecord[]> {
  const rows = await withUserDbFor(user, (tx) =>
    tx
      .select()
      .from(assistantLogs)
      .where(
        and(
          eq(assistantLogs.organizationId, organizationId),
          eq(assistantLogs.userId, user.userId),
        ),
      )
      .orderBy(desc(assistantLogs.createdAt))
      .limit(limit),
  );
  return rows.map(toRecord);
}

/** En rad ur loggen (användarens egen, eller valfri i organisationen för ägare och admin). */
export async function getLogFor(
  user: SessionUser,
  organizationId: string,
  id: string,
): Promise<LogRecord | null> {
  if (!isUuid(id)) return null;
  const [row] = await withUserDbFor(user, (tx) =>
    tx
      .select()
      .from(assistantLogs)
      .where(and(eq(assistantLogs.organizationId, organizationId), eq(assistantLogs.id, id)))
      .limit(1),
  );
  return row ? toRecord(row) : null;
}
