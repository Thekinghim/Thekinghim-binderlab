/**
 * awish_api_state: en rad per Awish API-källa (Version, anslutning, signering, skrivvägar).
 * Skrivs bara här, som systemrollen, efter rollkontrollen i anroparen.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";

import { isAwishSignMode } from "../sign";
import type { AwishApiState } from "./connect";

type Row = Record<string, unknown>;

async function query<T extends Row>(db: Db | Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute(q)) as T[];
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function via(value: unknown): AwishApiState["slotWritesVia"] {
  return value === "api" || value === "api_then_web" ? value : "web";
}

function toState(r: Row): AwishApiState {
  return {
    id: String(r.id),
    dataSourceId: String(r.data_source_id),
    version: (r.version as string | null) ?? null,
    versionSeenAt: date(r.version_seen_at),
    previousVersion: (r.previous_version as string | null) ?? null,
    versionChangedAt: date(r.version_changed_at),
    versionAcknowledgedAt: date(r.version_acknowledged_at),
    endpoint: r.endpoint === "tls" || r.endpoint === "plain" ? r.endpoint : null,
    endpointCheckedAt: date(r.endpoint_checked_at),
    endpointError: (r.endpoint_error as string | null) ?? null,
    signMode: isAwishSignMode(r.sign_mode) ? r.sign_mode : null,
    signStatus: r.sign_status === "ok" || r.sign_status === "failed" ? r.sign_status : "unverified",
    signCheckedAt: date(r.sign_checked_at),
    signError: (r.sign_error as string | null) ?? null,
    slotWritesVia: via(r.slot_writes_via),
    goodsWritesVia: via(r.goods_writes_via),
  };
}

/** Läget för källan, eller null om ingen rad finns än. */
export async function loadApiState(
  db: Db | Tx,
  orgId: string,
  dataSourceId: string,
): Promise<AwishApiState | null> {
  const [row] = await query(
    db,
    sql`select * from public.awish_api_state
        where organization_id = ${orgId}::uuid and data_source_id = ${dataSourceId}::uuid`,
  );
  return row ? toState(row) : null;
}

/** Läget för källan; skapar raden (standardvärden) om den saknas. */
export async function ensureApiState(
  db: Db | Tx,
  orgId: string,
  dataSourceId: string,
): Promise<AwishApiState> {
  const existing = await loadApiState(db, orgId, dataSourceId);
  if (existing) return existing;
  await db.execute(
    sql`insert into public.awish_api_state (organization_id, data_source_id)
        values (${orgId}::uuid, ${dataSourceId}::uuid)
        on conflict (data_source_id) do nothing`,
  );
  const created = await loadApiState(db, orgId, dataSourceId);
  if (!created) throw new Error("Awish API-läget kunde inte sparas.");
  return created;
}

export interface ApiStatePatch {
  version?: string;
  versionSeenAt?: Date;
  previousVersion?: string | null;
  versionChangedAt?: Date | null;
  versionAcknowledgedAt?: Date | null;
  versionAcknowledgedBy?: string | null;
  endpoint?: "tls" | "plain" | null;
  endpointCheckedAt?: Date;
  endpointError?: string | null;
  signMode?: string | null;
  signStatus?: "unverified" | "ok" | "failed";
  signCheckedAt?: Date;
  signError?: string | null;
  slotWritesVia?: "web" | "api" | "api_then_web";
  goodsWritesVia?: "web" | "api" | "api_then_web";
}

const COLUMNS: Record<keyof ApiStatePatch, string> = {
  version: "version",
  versionSeenAt: "version_seen_at",
  previousVersion: "previous_version",
  versionChangedAt: "version_changed_at",
  versionAcknowledgedAt: "version_acknowledged_at",
  versionAcknowledgedBy: "version_acknowledged_by",
  endpoint: "endpoint",
  endpointCheckedAt: "endpoint_checked_at",
  endpointError: "endpoint_error",
  signMode: "sign_mode",
  signStatus: "sign_status",
  signCheckedAt: "sign_checked_at",
  signError: "sign_error",
  slotWritesVia: "slot_writes_via",
  goodsWritesVia: "goods_writes_via",
};

function clip(text: string | null | undefined, max = 300): string | null {
  if (text === null || text === undefined) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Uppdaterar läget (bara de fält som anges). */
export async function updateApiState(
  db: Db | Tx,
  orgId: string,
  dataSourceId: string,
  patch: ApiStatePatch,
): Promise<void> {
  const sets = (Object.keys(patch) as Array<keyof ApiStatePatch>)
    .filter((k) => patch[k] !== undefined)
    .map((k) => {
      let value = patch[k] as unknown;
      if (k === "endpointError" || k === "signError") value = clip(value as string | null);
      if (value instanceof Date) value = value.toISOString();
      return sql`${sql.raw(COLUMNS[k])} = ${value}`;
    });
  if (sets.length === 0) return;
  await db.execute(
    sql`update public.awish_api_state set ${sql.join(sets, sql`, `)}
        where organization_id = ${orgId}::uuid and data_source_id = ${dataSourceId}::uuid`,
  );
}
