/**
 * Gemensamt för Kampanjer och Gratis-pack: organisationens Awish API-källa, automaterna
 * som är kopplade till en Awish-automat och en klient med kampanj- och kodanropen.
 *
 * Allt körs som systemrollen (databasägaren) EFTER rollkontrollen i tjänsterna:
 * organisationen kommer alltid från den inloggades aktiva organisation, aldrig från
 * begäran, och inloggningsuppgifterna läses ur Vault och lämnar aldrig servern.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";

import {
  awishClientConfigFromEnv,
  createAwishClient,
  type AwishCredentials,
  type AwishMarketingApi,
} from "./grpc-client";
import { readCredentials } from "./sync";

type Row = Record<string, unknown>;

async function query<T extends Row>(db: Db | Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute(q)) as T[];
}

/** Testerna ger låtsas-Awish; appen använder adressen ur miljön. */
export type MarketingConnect = (creds: AwishCredentials) => AwishMarketingApi;

/** Tidsgräns per anrop (s): användaren väntar på svaret. */
export const MARKETING_DEADLINE_MS = 10_000;

export class AwishNotConnectedError extends Error {
  constructor(message = "Koppla Awish först (Mer → Datakällor).") {
    super(message);
    this.name = "AwishNotConnectedError";
  }
}

export interface LinkedMachine {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly awishMachineId: string;
}

/** Organisationens Awish API-källa (den äldsta som inte är arkiverad), eller null. */
export async function awishSourceOf(
  db: Db | Tx,
  orgId: string,
): Promise<{ id: string; organization_id: string; secret_ref: string | null } | null> {
  const [row] = await query<{ id: string; organization_id: string; secret_ref: string | null }>(
    db,
    sql`select ds.id, ds.organization_id, ds.secret_ref
        from public.data_sources ds
        join public.organizations o on o.id = ds.organization_id
        where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
          and ds.archived_at is null and o.archived_at is null
        order by ds.created_at
        limit 1`,
  );
  return row ?? null;
}

/** Våra automater som är kopplade till en Awish-automat i källan (inte arkiverade). */
export async function linkedMachines(db: Db | Tx, orgId: string): Promise<LinkedMachine[]> {
  const source = await awishSourceOf(db, orgId);
  if (!source) return [];
  const rows = await query<{ id: string; code: string; name: string; external_id: string }>(
    db,
    sql`select distinct on (m.id) m.id, m.code, m.name, sm.external_id
        from public.source_machines sm
        join public.machines m
          on m.organization_id = sm.organization_id and m.id = sm.machine_id
        where sm.organization_id = ${orgId}::uuid and sm.data_source_id = ${source.id}::uuid
          and m.archived_at is null and sm.external_id ~ '^[0-9]{1,20}$'
        order by m.id, sm.created_at`,
  );
  return rows
    .map((r) => ({ machineId: r.id, code: r.code, name: r.name, awishMachineId: r.external_id }))
    .sort((a, b) => a.code.localeCompare(b.code, "sv", { numeric: true }));
}

function defaultConnect(creds: AwishCredentials): AwishMarketingApi {
  return createAwishClient(creds, {
    ...awishClientConfigFromEnv(),
    deadlineMs: MARKETING_DEADLINE_MS,
  });
}

/** Klient för organisationens Awish-konto. Kastar AwishNotConnectedError utan källa eller uppgifter. */
export async function marketingClient(
  db: Db,
  orgId: string,
  connect: MarketingConnect = defaultConnect,
): Promise<AwishMarketingApi> {
  const source = await awishSourceOf(db, orgId);
  if (!source) throw new AwishNotConnectedError();
  const creds = await readCredentials(db, source);
  if (!creds)
    throw new AwishNotConnectedError("Spara AppId, AppSecret och AppKey under Datakällor.");
  return connect(creds);
}
