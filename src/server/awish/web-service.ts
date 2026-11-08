/**
 * Skickar Binderlabs maskinlager till Awishs webbpanel efter en påfyllning, så ägaren
 * aldrig behöver skriva antal på dash.awish.vip. Allt på servern; butikens inloggning
 * läses krypterat ur Vault (private.awish_read_web_credentials) och lämnar aldrig servern.
 *
 * En push rör bara automater som just fyllts på, höjer bara fackens antal (aldrig sänker),
 * och den blockerar aldrig att påfyllningen sparas: misslyckas den rapporteras det, men
 * påfyllningen ligger redan kvar i Binderlab.
 */

import { getServiceDb, type Db } from "@/db/client";
import { sql } from "drizzle-orm";

import { logAwishPushes } from "@/server/varde/log";

import { AwishApiError } from "./grpc-client";
import {
  createAwishWebClient,
  type AwishWebApi,
  type AwishWebLogin,
  type AwishWebClientOptions,
} from "./web-client";
import { planAwishPush, type MachineTitleQuantity } from "./web-push";

/** En rads resultat för en automat. */
export interface MachinePushResult {
  machineId: string;
  machineCode: string | null;
  status: "pushed" | "nothing" | "no_awish_machine" | "error";
  /** Antal fack som ändrades i Awish. */
  slotsUpdated: number;
  /** Titlar i Binderlab som saknar fack i Awish (rapporteras, inte ett fel). */
  titlesWithoutSlot: string[];
  /** Provkörning: vad som skulle ändras (titel, fack, från → till). Tom vid riktig push. */
  planned?: Array<{ titleName: string; productId: number; from: number; to: number }>;
  /** Provkörning: antal fack Awish visade för automaten. */
  slotsRead?: number;
  error?: string;
}

export interface WebPushResult {
  /** "off" = push avstängd eller ingen inloggning; "done" = körd (se machines). */
  status: "off" | "done";
  reason?: "no_credentials" | "disabled" | "no_source";
  machines: MachinePushResult[];
}

export interface WebPushDeps {
  serviceDb?: Db;
  /** Klienten mot Awish; injiceras i tester (annars riktiga webb-klienten). */
  makeClient?: (options: AwishWebClientOptions) => AwishWebApi;
  clientOptions?: AwishWebClientOptions;
  /** Provkörning: logga in och läs, men skriv ingenting till Awish (gäller även när push är av). */
  dryRun?: boolean;
}

interface WebSource {
  id: string;
  organization_id: string;
  enabled: boolean;
}

type WebCredentials = AwishWebLogin;

export async function loadWebSource(db: Db, organizationId: string): Promise<WebSource | null> {
  const rows = Array.from(
    await db.execute(sql`
      select ds.id, ds.organization_id,
             coalesce((ds.config -> 'awishWeb' ->> 'enabled')::boolean, false) as enabled
      from public.data_sources ds
      where ds.organization_id = ${organizationId}::uuid
        and ds.provider = 'awish_grpc' and ds.archived_at is null
      order by ds.created_at asc
      limit 1`),
  ) as Array<{ id: string; organization_id: string; enabled: boolean }>;
  return rows[0] ?? null;
}

export async function readWebCredentials(
  db: Db,
  dataSourceId: string,
): Promise<WebCredentials | null> {
  const rows = Array.from(
    await db.execute(
      sql`select private.awish_read_web_credentials(${dataSourceId}::uuid) as creds`,
    ),
  ) as Array<{ creds: unknown }>;
  const c = (rows[0]?.creds ?? null) as Record<string, unknown> | null;
  if (!c || typeof c.email !== "string" || typeof c.password !== "string") return null;
  return { email: c.email, password: c.password };
}

/** Awishs maskin-id (source_machines.external_id) för en Binderlab-automat. */
export async function awishMachineId(
  db: Db,
  organizationId: string,
  dataSourceId: string,
  machineId: string,
): Promise<number | null> {
  const rows = Array.from(
    await db.execute(sql`
      select sm.external_id
      from public.source_machines sm
      where sm.organization_id = ${organizationId}::uuid
        and sm.data_source_id = ${dataSourceId}::uuid
        and sm.machine_id = ${machineId}::uuid
        and sm.external_id ~ '^[0-9]{1,30}$'
      limit 1`),
  ) as Array<{ external_id: string }>;
  const raw = rows[0]?.external_id;
  return raw ? Number(raw) : null;
}

/** Binderlabs antal per titel i automaten nu (bara titlar med räknat saldo). */
async function machineTitleStock(
  db: Db,
  organizationId: string,
  machineId: string,
): Promise<MachineTitleQuantity[]> {
  const rows = Array.from(
    await db.execute(sql`
      select t.name as title_name, l.quantity,
             -- Mystery pack (egen produkt med innehåll): fylls bara i tomma fack.
             (t.own_product and exists (
                select 1 from public.mystery_recipes r
                where r.organization_id = t.organization_id and r.title_id = t.id)) as mystery
      from public.stock_locations loc
      join public.stock_levels l
        on l.organization_id = loc.organization_id and l.location_id = loc.id
      join public.titles t on t.organization_id = l.organization_id and t.id = l.title_id
      where loc.organization_id = ${organizationId}::uuid
        and loc.machine_id = ${machineId}::uuid
        and loc.kind = 'machine'
        and l.last_counted_at is not null
        and t.archived_at is null`),
  ) as Array<{ title_name: string; quantity: number; mystery: boolean | null }>;
  return rows.map((r) => ({
    titleName: r.title_name,
    quantity: Number(r.quantity),
    ...(r.mystery === true ? { mystery: true } : {}),
  }));
}

/** Automatens kod (BL-001) för loggning. */
async function machineCodes(
  db: Db,
  organizationId: string,
  machineIds: string[],
): Promise<Map<string, string | null>> {
  if (machineIds.length === 0) return new Map();
  const rows = Array.from(
    await db.execute(sql`
      select m.id::text as id, m.code
      from public.machines m
      where m.organization_id = ${organizationId}::uuid
        and m.id in (select jsonb_array_elements_text(${JSON.stringify(machineIds)}::jsonb)::uuid)`),
  ) as Array<{ id: string; code: string | null }>;
  return new Map(rows.map((r) => [r.id, r.code]));
}

/**
 * Skickar en eller flera automaters lager till Awish. `organizationId` och `machineIds`
 * kommer från en redan rollkontrollerad åtgärd (påfyllningen). Loggar aldrig lösenordet.
 */
/** Alla Binderlab-automater som är kopplade till organisationens Awish-källa. */
export async function linkedAwishMachineIds(
  organizationId: string,
  deps: WebPushDeps = {},
): Promise<string[]> {
  const db = deps.serviceDb ?? getServiceDb();
  const rows = Array.from(
    await db.execute(sql`
      select distinct sm.machine_id::text as id
      from public.source_machines sm
      join public.data_sources ds on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
      where sm.organization_id = ${organizationId}::uuid
        and ds.provider = 'awish_grpc' and ds.archived_at is null
        and sm.machine_id is not null`),
  ) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export async function pushMachinesToAwish(
  organizationId: string,
  machineIds: readonly string[],
  deps: WebPushDeps = {},
): Promise<WebPushResult> {
  const db = deps.serviceDb ?? getServiceDb();
  const ids = [...new Set(machineIds)].filter(Boolean);
  if (ids.length === 0) return { status: "off", reason: "no_source", machines: [] };

  const source = await loadWebSource(db, organizationId);
  if (!source) return { status: "off", reason: "no_source", machines: [] };
  if (!source.enabled && !deps.dryRun) return { status: "off", reason: "disabled", machines: [] };

  const creds = await readWebCredentials(db, source.id);
  if (!creds) return { status: "off", reason: "no_credentials", machines: [] };

  const codes = await machineCodes(db, organizationId, ids);
  const client = (deps.makeClient ?? createAwishWebClient)(deps.clientOptions ?? {});
  const machines: MachinePushResult[] = [];
  let loggedIn = false;

  for (const machineId of ids) {
    const code = codes.get(machineId) ?? null;
    try {
      const awishId = await awishMachineId(db, organizationId, source.id, machineId);
      if (awishId == null) {
        machines.push({
          machineId,
          machineCode: code,
          status: "no_awish_machine",
          slotsUpdated: 0,
          titlesWithoutSlot: [],
        });
        continue;
      }
      const want = await machineTitleStock(db, organizationId, machineId);
      if (!loggedIn) {
        await client.login(creds);
        loggedIn = true;
      }
      const products = await client.products(awishId);
      const plan = planAwishPush(want, products);
      if (deps.dryRun) {
        machines.push({
          machineId,
          machineCode: code,
          status: "nothing",
          slotsUpdated: 0,
          titlesWithoutSlot: plan.titlesWithoutSlot,
          slotsRead: products.length,
          planned: plan.updates.map((u) => ({
            titleName: u.titleName,
            productId: u.productId,
            from: u.previousInventory,
            to: u.currentInventory,
          })),
        });
        continue;
      }
      for (const u of plan.updates) {
        await client.setProductInventory(u.productId, {
          goodId: u.goodId,
          status: u.status,
          currentInventory: u.currentInventory,
        });
      }
      machines.push({
        machineId,
        machineCode: code,
        status: plan.updates.length > 0 ? "pushed" : "nothing",
        slotsUpdated: plan.updates.length,
        titlesWithoutSlot: plan.titlesWithoutSlot,
      });
    } catch (error) {
      const message =
        error instanceof AwishApiError
          ? error.message
          : "Kunde inte skicka till Awish. Försök igen.";
      machines.push({
        machineId,
        machineCode: code,
        status: "error",
        slotsUpdated: 0,
        titlesWithoutSlot: [],
        error: message,
      });
      // Ett auth-fel gäller hela inloggningen: sluta försöka med fler automater.
      if (error instanceof AwishApiError && error.kind === "auth") break;
    }
  }

  // Värde: räknas som sparad tid (automation_log). Stoppar aldrig pushen.
  if (!deps.dryRun) await logAwishPushes(db, organizationId, machines);
  return { status: "done", machines };
}
