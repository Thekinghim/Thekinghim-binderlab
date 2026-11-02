/**
 * Loggen över frågor och svar (tabellen assistant_logs, append-only, RLS).
 *
 * Allt körs som användaren (withUserDbFor). Raden skrivs via
 * private.insert_assistant_log (security definer, nås inte via API:t): ingen medlem kan
 * skriva egna rader direkt, och funktionen kräver användarens eget user_id och hens
 * faktiska roll i organisationen. Var och en läser sina egna rader, men rader skrivna med
 * en roll som ser ekonomi bara så länge användaren fortfarande ser ekonomi (RLS, och samma
 * filter här när rollen är känd). Ägare och admin läser alla i organisationen.
 */

import "server-only";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import { assistantLogs, type MemberRole, type MembershipRole } from "@/db/schema";
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

/**
 * Rollerna vars rader en användare med rollen `role` får läsa bland sina egna: rader
 * skrivna med ekonomi (ägare, admin, läsare) bara om rollen fortfarande ser ekonomi.
 * Samma regel som policyn assistant_logs_select.
 */
export function visibleRowRoles(role: MembershipRole): MemberRole[] {
  if (role === "store") return [];
  if (role === "refiller") return ["refiller"];
  return ["owner", "admin", "viewer", "refiller"];
}

/** Sparar frågan (via private.insert_assistant_log). Returnerar radens id. */
export async function insertLogFor(user: SessionUser, entry: NewLogEntry): Promise<string> {
  const toolCalls = JSON.stringify(entry.toolCalls.map(compactCall));
  const verification = JSON.stringify({ ...entry.verification });
  const usage = JSON.stringify({ ...entry.usage });
  return withUserDbFor(user, async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      select private.insert_assistant_log(
        ${entry.organizationId}::uuid,
        ${entry.conversationId}::uuid,
        ${entry.role}::public.member_role,
        ${entry.question},
        ${entry.answer.slice(0, 50_000)},
        ${entry.status},
        ${entry.provider},
        ${entry.model.slice(0, 100)},
        ${toolCalls}::jsonb,
        ${verification}::jsonb,
        ${usage}::jsonb,
        ${entry.error ? entry.error.slice(0, 2000) : null},
        ${Math.max(0, Math.round(entry.durationMs))}::integer
      ) as id`);
    if (!row?.id) throw new Error("assistant_logs: raden sparades inte.");
    return row.id;
  });
}

/** En rad i loggen som den visas på sidan. */
export interface LogRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string | null;
  readonly role: MembershipRole;
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

/** Filter på nuvarande roll (utöver RLS). */
export interface RoleFilter {
  /** Användarens roll nu: bara rader som rollen får se (visibleRowRoles). */
  readonly role?: MembershipRole;
}

function roleCondition(options: RoleFilter) {
  if (!options.role) return undefined;
  const roles = visibleRowRoles(options.role);
  return roles.length > 0 ? inArray(assistantLogs.role, roles) : sql`false`;
}

/**
 * Tidigare frågor i samtalet (användarens egna), äldst först, som historik till modellen.
 * Bara besvarade frågor; de senaste HISTORY_LIMIT. Rader som användarens nuvarande roll
 * inte får se (t.ex. ekonomisvar efter en nedgradering) skickas aldrig med.
 */
export async function loadConversationFor(
  user: SessionUser,
  organizationId: string,
  conversationId: string,
  options: RoleFilter = {},
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
          roleCondition(options),
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
  options: RoleFilter = {},
): Promise<LogRecord[]> {
  const rows = await withUserDbFor(user, (tx) =>
    tx
      .select()
      .from(assistantLogs)
      .where(
        and(
          eq(assistantLogs.organizationId, organizationId),
          eq(assistantLogs.userId, user.userId),
          roleCondition(options),
        ),
      )
      .orderBy(desc(assistantLogs.createdAt))
      .limit(limit),
  );
  return rows.map(toRecord);
}

/** Antal frågor användaren ställt i organisationen (som rollen får se). */
export async function countFor(
  user: SessionUser,
  organizationId: string,
  options: RoleFilter = {},
): Promise<number> {
  const [row] = await withUserDbFor(user, (tx) =>
    tx
      .select({ n: count() })
      .from(assistantLogs)
      .where(
        and(
          eq(assistantLogs.organizationId, organizationId),
          eq(assistantLogs.userId, user.userId),
          roleCondition(options),
        ),
      ),
  );
  return row?.n ?? 0;
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
