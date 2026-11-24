/**
 * Gemensamt för "Styr automaten": vilken automat det gäller, beroenden som testerna byter ut,
 * förhandsvisningens form och svaren.
 *
 * Säkerhet: varje skrivning går genom runControlAction (roll mot databasen, demo, takt,
 * idempotens, loggrad). Läsningarna här kontrollerar själva roll och demo innan något
 * anrop till Awish görs. Organisationen är alltid den inloggades aktiva, aldrig ur begäran.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import { AuthorizationError, requireRoleFor } from "@/server/access";
import {
  awishMachineIdFor,
  controlClientFor,
  type AwishApiState,
  type ControlDeps,
} from "@/server/awish/control/connect";
import type { runControlAction } from "@/server/awish/control/guard";
import { newIdempotencyKey, type ControlActionResult } from "@/server/awish/control/guard";
import type { slotWriterFor } from "@/server/awish/control/slot-writer";
import type { AwishControlApi } from "@/server/awish/control/types";
import { planFingerprint } from "@/server/awish/goods";
import type { Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";

/** Fel som visas som det är (svenska, utan detaljer från Awish). */
export class MachineControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineControlError";
  }
}

export const FORBIDDEN_MESSAGE = "Bara ägare och admin kan styra automaten.";
export const STALE_MESSAGE =
  "Något har ändrats sedan förhandsvisningen. Titta på förhandsvisningen igen.";
export const NOT_LINKED_MESSAGE = "Automaten är inte kopplad till Awish.";

/** Beroenden: testerna ger en låtsas-Awish och en egen spärr. */
export interface MachineControlDeps extends ControlDeps {
  run?: typeof runControlAction;
  client?: typeof controlClientFor;
  awishIdFor?: typeof awishMachineIdFor;
  slotWriter?: typeof slotWriterFor;
}

export function dbOf(deps: MachineControlDeps): Db {
  return deps.db ?? getServiceDb();
}

/** Ägare eller admin (läst ur databasen), annars AuthorizationError med vår text. */
export async function requireOperator(viewer: Viewer): Promise<void> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError)
      throw new AuthorizationError("forbidden", FORBIDDEN_MESSAGE);
    throw error;
  }
}

export interface ControlledMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly awishMachineId: string;
}

/** Automaten i organisationen (inte arkiverad) och dess Awish-id. */
export async function machineFor(
  db: Db,
  orgId: string,
  machineId: string,
  deps: MachineControlDeps,
): Promise<ControlledMachine> {
  const [row] = Array.from(
    await db.execute(
      sql`select id::text as id, code, name from public.machines
          where organization_id = ${orgId}::uuid and id = ${machineId}::uuid
            and archived_at is null`,
    ),
  ) as { id: string; code: string; name: string }[];
  if (!row) throw new MachineControlError("Automaten finns inte.");
  const awishMachineId = await (deps.awishIdFor ?? awishMachineIdFor)(db, orgId, row.id);
  if (!awishMachineId) throw new MachineControlError(NOT_LINKED_MESSAGE);
  return { id: row.id, code: row.code, name: row.name, awishMachineId };
}

/**
 * Läsning mot Awish för en förhandsvisning: roll, demo (ingen anslutning alls), sedan
 * klienten. Klienten stängs efteråt.
 */
export async function withReadClient<T>(
  viewer: Viewer,
  machineId: string,
  deps: MachineControlDeps,
  fn: (a: {
    api: AwishControlApi;
    state: AwishApiState;
    machine: ControlledMachine;
    db: Db;
  }) => Promise<T>,
): Promise<T> {
  await requireOperator(viewer);
  const db = dbOf(deps);
  const orgId = viewer.organization.id;
  if (await isDemoOrganization(db, orgId))
    throw new MachineControlError(DEMO_MESSAGES.integrations);
  const machine = await machineFor(db, orgId, machineId, deps);
  const { api, state } = await (deps.client ?? controlClientFor)(db, orgId, deps);
  try {
    return await fn({ api, state, machine, db });
  } finally {
    api.close();
  }
}

/** Det förhandsvisningen ger tillbaka till skärmen. */
export interface ControlPreview {
  readonly lines: string[];
  readonly warnings: string[];
  /** Hindret som gör att det inte går att skicka, eller null. */
  readonly blocking: string | null;
  /** Fråga som måste bekräftas uttryckligen, eller null. */
  readonly confirm: string | null;
  /** Texten som måste skrivas för att bekräfta (automatens kod), eller null. */
  readonly typed: string | null;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

export function preview(
  plan: { lines: string[]; warnings?: string[]; blocking?: string | null; confirm?: string | null },
  extra: Record<string, unknown>,
  typed: string | null = null,
): ControlPreview {
  return {
    lines: plan.lines,
    warnings: plan.warnings ?? [],
    blocking: plan.blocking ?? null,
    confirm: plan.confirm ?? null,
    typed,
    fingerprint: planFingerprint(plan, extra),
    idempotencyKey: newIdempotencyKey(),
  };
}

export type ControlOutcome =
  { ok: true; message: string; replayed: boolean } | { ok: false; message: string; kind: string };

export function outcome<T>(
  r: ControlActionResult<T>,
  success: (value: T) => string,
): ControlOutcome {
  if (r.ok)
    return { ok: true, message: r.replayed ? r.message : success(r.value), replayed: r.replayed };
  return { ok: false, message: r.message, kind: r.kind };
}

/** Den skrivna bekräftelsen: automatens kod, utan hänsyn till skiftläge och mellanslag. */
export function typedMatches(typed: unknown, code: string): boolean {
  return (
    typeof typed === "string" &&
    typed.trim().replace(/\s+/g, "").toUpperCase() === code.trim().toUpperCase()
  );
}

/** Idempotensnyckeln från förhandsvisningen (en uuid). */
export function idempotencyKeyOf(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
  ) {
    throw new MachineControlError("Titta på förhandsvisningen först.");
  }
  return raw.toLowerCase();
}

/** "Fack A3" (kanalens namn), annars facket id. */
export function slotName(channelName: string | null | undefined, id: string | number): string {
  return channelName ? `Fack ${channelName}` : `Fack ${id}`;
}
