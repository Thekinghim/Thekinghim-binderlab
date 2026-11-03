/**
 * Datakällor → kortet "Awish": status, spara AppId/AppSecret/AppKey, testa
 * anslutningen och synka nu. Bundet till en verifierad användare (Viewer); bara
 * ägare och admin. Datakällan läses och skapas som användaren med RLS, och
 * uppgifterna sparas med public.awish_save_credentials (Vault). Anropen till Awish
 * görs sedan av servern (systemrollen) för just den datakällan.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getServiceDb, type Db, type Tx } from "@/db/client";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";

import type { AwishApi, AwishCredentials } from "./grpc-client";
import {
  parseState,
  syncAwishSource,
  testAwishConnection,
  type AwishConnectionTest,
  type AwishLastRun,
  type AwishSyncResult,
} from "./sync";

type Row = Record<string, unknown>;

const field = (label: string) =>
  z
    .string()
    .trim()
    .max(200, `${label} får vara högst 200 tecken.`)
    .regex(/^[^\p{Cc}]*$/u, `${label} får inte innehålla radbrytningar.`);

export const saveCredentialsSchema = z.object({
  appId: field("AppId"),
  appSecret: field("AppSecret"),
  appKey: field("AppKey"),
});

export class AwishSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwishSetupError";
  }
}

export interface AwishPanelData {
  source: {
    id: string;
    name: string;
    status: string;
    sourceTimezone: string;
    lastSyncedAt: string | null;
    orders: number;
    latestOrderAt: string | null;
    credentials: { appIdLast4: string; appSecretLast4: string; appKeyLast4: string } | null;
    lastRun: AwishLastRun | null;
    historyDone: boolean;
  } | null;
}

/** Testerna ger en egen databas och klient; appen använder standardvärdena. */
export interface ManageDeps {
  serviceDb?: Db;
  connect?: (creds: AwishCredentials) => AwishApi;
}

async function query<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function asOperator<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  return withUserDbFor(viewer.user, fn);
}

/** Organisationens Awish API-källa (den äldsta som inte är arkiverad). */
async function findSource(tx: Tx, orgId: string): Promise<Row | undefined> {
  const [row] = await query(
    tx,
    sql`select ds.id, ds.name, ds.status::text as status, ds.source_timezone, ds.last_synced_at,
               ds.config, ds.cursor,
               (select count(*) from public.orders o
                 where o.organization_id = ds.organization_id and o.data_source_id = ds.id)::int as orders,
               (select max(o.ordered_at) from public.orders o
                 where o.organization_id = ds.organization_id and o.data_source_id = ds.id) as latest_order_at
        from public.data_sources ds
        where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
          and ds.archived_at is null
        order by ds.created_at
        limit 1`,
  );
  return row;
}

function credentialsOf(config: unknown): NonNullable<AwishPanelData["source"]>["credentials"] {
  const c = ((config ?? {}) as { awishGrpc?: { credentials?: Record<string, unknown> } }).awishGrpc
    ?.credentials;
  if (!c) return null;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    appIdLast4: s(c.appIdLast4),
    appSecretLast4: s(c.appSecretLast4),
    appKeyLast4: s(c.appKeyLast4),
  };
}

export async function loadAwishPanelFor(viewer: Viewer): Promise<AwishPanelData> {
  return asOperator(viewer, async (tx) => {
    const row = await findSource(tx, viewer.organization.id);
    if (!row) return { source: null };
    const state = parseState(row.cursor);
    return {
      source: {
        id: String(row.id),
        name: String(row.name),
        status: String(row.status),
        sourceTimezone: String(row.source_timezone),
        lastSyncedAt: iso(row.last_synced_at),
        orders: Number(row.orders),
        latestOrderAt: iso(row.latest_order_at),
        credentials: credentialsOf(row.config),
        lastRun: state.lastRun,
        historyDone: state.paging.historyDone,
      },
    };
  });
}

function rpcError(error: unknown): never {
  const e = error as {
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  const code = e.code ?? e.cause?.code;
  const message = String(e.cause?.message ?? e.message ?? "");
  if (code === "22023" || code === "42501" || code === "P0002") {
    throw new AwishSetupError(message);
  }
  throw error;
}

/**
 * Sparar uppgifterna (tomt fält = behåll det sparade). Skapar datakällan "Awish API"
 * (källans tidszon Asia/Shanghai) om organisationen inte har någon.
 */
export async function saveAwishCredentialsFor(
  viewer: Viewer,
  input: z.infer<typeof saveCredentialsSchema>,
): Promise<{ dataSourceId: string }> {
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    let id = (await findSource(tx, orgId))?.id as string | undefined;
    if (!id) {
      if (!input.appId || !input.appSecret || !input.appKey) {
        throw new AwishSetupError("Ange AppId, AppSecret och AppKey.");
      }
      const names = new Set(
        (
          await query<{ name: string }>(
            tx,
            sql`select name from public.data_sources where organization_id = ${orgId}::uuid`,
          )
        ).map((r) => r.name.toLowerCase()),
      );
      let name = "Awish API";
      for (let i = 2; names.has(name.toLowerCase()); i += 1) name = `Awish API (${i})`;
      const [created] = await query<{ id: string }>(
        tx,
        sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
            values (${orgId}::uuid, 'awish_grpc', ${name}, 'Asia/Shanghai')
            returning id`,
      );
      id = created?.id;
      if (!id) throw new Error("Datakällan kunde inte skapas.");
    }
    try {
      await tx.execute(
        sql`select public.awish_save_credentials(${orgId}::uuid, ${id}::uuid,
                   ${input.appId}, ${input.appSecret}, ${input.appKey})`,
      );
    } catch (error) {
      rpcError(error);
    }
    return { dataSourceId: id };
  });
}

/** Ägare/admin och källan finns i organisationen (läst med RLS). */
async function operatorSource(viewer: Viewer): Promise<string> {
  const id = await asOperator(viewer, async (tx) => {
    const row = await findSource(tx, viewer.organization.id);
    return row ? String(row.id) : null;
  });
  if (!id) throw new AwishSetupError("Spara AppId, AppSecret och AppKey först.");
  return id;
}

export async function testAwishConnectionFor(
  viewer: Viewer,
  deps: ManageDeps = {},
): Promise<AwishConnectionTest> {
  const id = await operatorSource(viewer);
  return testAwishConnection({ db: deps.serviceDb ?? getServiceDb(), connect: deps.connect }, id);
}

export async function syncAwishNowFor(
  viewer: Viewer,
  deps: ManageDeps = {},
): Promise<AwishSyncResult> {
  const id = await operatorSource(viewer);
  return syncAwishSource(
    { db: deps.serviceDb ?? getServiceDb(), connect: deps.connect },
    { dataSourceId: id, trigger: "manual", actorUserId: viewer.user.userId },
  );
}
