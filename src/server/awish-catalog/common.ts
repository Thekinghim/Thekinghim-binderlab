/**
 * Gemensamt för katalogen och personerna i Awish (varor, kategorier, valutor, medlemmar och
 * Awish-kontot) via gRPC-API v1.2.41.
 *
 * Säkerhet: varje skrivning går genom runControlAction (roll mot databasen, demo, takt,
 * idempotens, loggrad). Läsningarna här kontrollerar själva roll och demo innan något anrop
 * till Awish görs; en demo ansluter aldrig. Organisationen är alltid den inloggades aktiva,
 * aldrig ur begäran. Inget hemligt loggas.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import { AuthorizationError, requireRoleFor } from "@/server/access";
import {
  controlClientFor,
  type AwishApiState,
  type ControlDeps,
} from "@/server/awish/control/connect";
import type { ControlActionResult, runControlAction } from "@/server/awish/control/guard";
import type { AwishControlApi } from "@/server/awish/control/types";
import { planFingerprint } from "@/server/awish/goods";
import { AwishApiError } from "@/server/awish/grpc-client";
import { AwishNotConnectedError } from "@/server/awish/marketing";
import type { Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";

/** Fel som visas som det är (svenska, utan detaljer från Awish). */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

export const FORBIDDEN_MESSAGE = "Bara ägare och admin kan ändra i Awish.";
export const STALE_MESSAGE =
  "Något har ändrats sedan förhandsvisningen. Titta på förhandsvisningen igen.";

/** Beroenden: testerna ger en låtsas-Awish och en egen spärr. */
export interface CatalogDeps extends ControlDeps {
  run?: typeof runControlAction;
  client?: typeof controlClientFor;
}

export function dbOf(deps: CatalogDeps): Db {
  return deps.db ?? getServiceDb();
}

/** Ägare eller admin (läst ur databasen), annars AuthorizationError med vår text. */
export async function requireOperator(viewer: Viewer, message = FORBIDDEN_MESSAGE): Promise<void> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) throw new AuthorizationError("forbidden", message);
    throw error;
  }
}

/** Kastar CatalogError med demotexten för en demo (före varje anslutning). */
export async function refuseDemo(db: Db, orgId: string): Promise<void> {
  if (await isDemoOrganization(db, orgId)) throw new CatalogError(DEMO_MESSAGES.integrations);
}

/**
 * Läsning mot Awish: roll, demo (ingen anslutning alls), sedan klienten. Klienten stängs
 * efteråt. Fel från Awish blir CatalogError med svensk text.
 */
export async function withReadClient<T>(
  viewer: Viewer,
  deps: CatalogDeps,
  fn: (a: { api: AwishControlApi; state: AwishApiState; db: Db }) => Promise<T>,
  forbidden = FORBIDDEN_MESSAGE,
): Promise<T> {
  await requireOperator(viewer, forbidden);
  const db = dbOf(deps);
  const orgId = viewer.organization.id;
  await refuseDemo(db, orgId);
  let api: AwishControlApi;
  let state: AwishApiState;
  try {
    ({ api, state } = await (deps.client ?? controlClientFor)(db, orgId, deps));
  } catch (error) {
    throw new CatalogError(readErrorMessage(error));
  }
  try {
    return await fn({ api, state, db });
  } catch (error) {
    if (error instanceof CatalogError || error instanceof AuthorizationError) throw error;
    throw new CatalogError(readErrorMessage(error));
  } finally {
    api.close();
  }
}

/** Svensk text för ett läsfel. Aldrig Awishs råa text eller hemligheter. */
export function readErrorMessage(error: unknown): string {
  if (error instanceof CatalogError || error instanceof AwishNotConnectedError) {
    return error.message;
  }
  if (error instanceof AwishApiError) return error.message;
  return "Awish svarade inte som väntat. Försök igen om en stund.";
}

/** Det förhandsvisningen ger tillbaka till skärmen. */
export interface CatalogPreview {
  readonly lines: string[];
  readonly warnings: string[];
  /** Hindret som gör att det inte går att skicka, eller null. */
  readonly blocking: string | null;
  /** Fråga som måste bekräftas uttryckligen, eller null. */
  readonly confirm: string | null;
  /** Texten som måste skrivas för att bekräfta, eller null. */
  readonly typed: string | null;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

export function catalogPreview(
  plan: {
    lines: string[];
    warnings?: string[];
    blocking?: string | null;
    confirm?: string | null;
    typed?: string | null;
  },
  extra: Record<string, unknown>,
): CatalogPreview {
  return {
    lines: plan.lines,
    warnings: plan.warnings ?? [],
    blocking: plan.blocking ?? null,
    confirm: plan.confirm ?? null,
    typed: plan.typed ?? null,
    fingerprint: planFingerprint(
      { lines: plan.lines, blocking: plan.blocking ?? null, typed: plan.typed ?? null },
      extra,
    ),
    idempotencyKey: crypto.randomUUID(),
  };
}

/** Svaret på en skrivning till skärmen. */
export interface CatalogOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** Awish kan ha tagit emot det (svaret kom inte fram). */
  readonly unknown?: boolean;
}

export function outcomeOf(r: ControlActionResult<unknown>, okMessage?: string): CatalogOutcome {
  if (r.ok)
    return {
      ok: true,
      message: r.replayed ? `${r.message} (redan skickat)` : (okMessage ?? r.message),
    };
  return { ok: false, message: r.message, unknown: r.kind === "unknown_outcome" };
}

/** Idempotensnyckeln från förhandsvisningen (uuid). */
export function keyOf(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) {
    throw new CatalogError("Förhandsgranska först.");
  }
  return key;
}

/** Id i Awish (uint64 som text). */
export function awishIdOf(raw: unknown, message: string): string {
  const id = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id.trim())) throw new CatalogError(message);
  return id.trim();
}

export type WritesVia = AwishApiState["goodsWritesVia"];

/**
 * Hur varor skickas till Awish (Datakällor → Awish API): standard webbpanelen. Läses ur
 * awish_api_state för organisationens Awish API-källa; saknas raden gäller webbpanelen.
 */
export async function goodsWritesVia(db: Db, orgId: string, sourceId: string): Promise<WritesVia> {
  const [row] = Array.from(
    await db.execute(
      sql`select goods_writes_via from public.awish_api_state
          where organization_id = ${orgId}::uuid and data_source_id = ${sourceId}::uuid`,
    ),
  ) as { goods_writes_via: string }[];
  const via = row?.goods_writes_via;
  return via === "api" || via === "api_then_web" ? via : "web";
}
