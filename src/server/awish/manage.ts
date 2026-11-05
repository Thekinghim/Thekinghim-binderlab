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
import { pgErrorOf } from "@/server/errors";
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
import { createAwishWebClient, type AwishWebApi, type AwishWebClientOptions } from "./web-client";
import { linkedAwishMachineIds, pushMachinesToAwish } from "./web-service";

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

export const saveWebCredentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .max(200, "E-postadressen får vara högst 200 tecken.")
    .regex(/^[^\p{Cc}]*$/u, "E-postadressen får inte innehålla radbrytningar."),
  // Lösenordet trimmas inte (blanksteg kan ingå) men radbrytningar nekas.
  password: z
    .string()
    .max(200, "Lösenordet får vara högst 200 tecken.")
    .regex(/^[^\p{Cc}]*$/u, "Lösenordet får inte innehålla radbrytningar."),
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
    /** Awish webbpanel: inloggning sparad (maskad e-post) och om push är på. */
    web: { email: string | null; hasPassword: boolean; enabled: boolean };
  } | null;
}

/** Testerna ger en egen databas och klient; appen använder standardvärdena. */
export interface ManageDeps {
  serviceDb?: Db;
  connect?: (creds: AwishCredentials) => AwishApi;
  /** Webb-klienten mot Awish; injiceras i tester. */
  makeWebClient?: (options: AwishWebClientOptions) => AwishWebApi;
  webClientOptions?: AwishWebClientOptions;
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

function webOf(config: unknown): NonNullable<AwishPanelData["source"]>["web"] {
  const w = ((config ?? {}) as { awishWeb?: Record<string, unknown> }).awishWeb ?? {};
  return {
    email: typeof w.email === "string" ? w.email : null,
    hasPassword: w.hasPassword === true,
    enabled: w.enabled === true,
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
        web: webOf(row.config),
      },
    };
  });
}

/**
 * Fel från awish_save_credentials. Kastar aldrig vidare det ursprungliga felet:
 * drizzles DrizzleQueryError har frågans parametrar (AppSecret, AppKey) i
 * meddelandet och skulle hamna i loggen. Bara SQLSTATE och Postgres meddelande går
 * vidare (Postgres meddelanden innehåller inte parametrarna).
 */
export function rpcError(error: unknown): never {
  const pg = pgErrorOf(error);
  if (pg && (pg.code === "22023" || pg.code === "42501" || pg.code === "P0002") && pg.message) {
    // Funktionens egna svenska meddelanden.
    throw new AwishSetupError(pg.message);
  }
  // Bara SQLSTATE följer med (dbErrorMessage ger ett svenskt meddelande av den).
  const sanitized = Object.assign(
    new Error(`awish_save_credentials misslyckades${pg ? ` (SQLSTATE ${pg.code})` : ""}.`),
    pg ? { code: pg.code, severity: "ERROR" } : {},
  );
  throw sanitized;
}

/**
 * Tidszon för en ny Awish API-källa: samma som organisationens senaste aktiva
 * Awish-källa (t.ex. den uppladdade CSV:n, som ägaren kan ha rättat efter
 * kontrollen i docs/awish.md), annars Asia/Shanghai. Samma tidszon behövs för att
 * samma försäljning i båda källorna ska få samma betaltid (dubblettkontrollen).
 */
async function defaultSourceTimezone(tx: Tx, orgId: string): Promise<string> {
  const [row] = await query<{ source_timezone: string }>(
    tx,
    sql`select ds.source_timezone from public.data_sources ds
        where ds.organization_id = ${orgId}::uuid
          and ds.provider in ('awish_csv', 'awish_web', 'awish_extension')
          and ds.archived_at is null
        order by ds.created_at desc
        limit 1`,
  );
  return row?.source_timezone ?? "Asia/Shanghai";
}

/**
 * Sparar uppgifterna (tomt fält = behåll det sparade). Skapar datakällan "Awish API"
 * om organisationen inte har någon, med samma tidszon som organisationens senaste
 * Awish-källa (annars Asia/Shanghai).
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
      const timezone = await defaultSourceTimezone(tx, orgId);
      const [created] = await query<{ id: string }>(
        tx,
        sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
            values (${orgId}::uuid, 'awish_grpc', ${name}, ${timezone})
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

/**
 * Sparar butikens inloggning till Awishs webbpanel (e-post och lösenord) för
 * push av påfyllningar. Kräver att AppId/AppSecret/AppKey redan sparats (samma
 * datakälla). Tomt lösenord = behåll det sparade.
 */
export async function saveAwishWebCredentialsFor(
  viewer: Viewer,
  input: z.infer<typeof saveWebCredentialsSchema>,
): Promise<{ dataSourceId: string }> {
  const orgId = viewer.organization.id;
  const id = await operatorSource(viewer);
  await asOperator(viewer, async (tx) => {
    try {
      await tx.execute(
        sql`select public.awish_save_web_credentials(${orgId}::uuid, ${id}::uuid,
                   ${input.email}, ${input.password})`,
      );
    } catch (error) {
      rpcError(error);
    }
  });
  return { dataSourceId: id };
}

/** Slår på eller av automatisk push till Awish. */
export async function setAwishWebPushFor(
  viewer: Viewer,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  const orgId = viewer.organization.id;
  const id = await operatorSource(viewer);
  await asOperator(viewer, async (tx) => {
    try {
      await tx.execute(
        sql`select public.awish_set_web_push(${orgId}::uuid, ${id}::uuid, ${enabled}::boolean)`,
      );
    } catch (error) {
      rpcError(error);
    }
  });
  return { enabled };
}

export interface AwishWebLoginTest {
  ok: boolean;
  message: string;
}

/**
 * Loggar in på Awishs webbpanel med den sparade inloggningen, bara för att visa att den
 * fungerar. Läser uppgifterna med systemrollen (Vault) och gör inget mer än att logga in.
 */
export async function testAwishWebLoginFor(
  viewer: Viewer,
  deps: ManageDeps = {},
): Promise<AwishWebLoginTest> {
  const id = await operatorSource(viewer);
  const db = deps.serviceDb ?? getServiceDb();
  const rows = await query<{ creds: unknown }>(
    db as unknown as Tx,
    sql`select private.awish_read_web_credentials(${id}::uuid) as creds`,
  );
  const c = (rows[0]?.creds ?? null) as { email?: unknown; password?: unknown } | null;
  if (!c || typeof c.email !== "string" || typeof c.password !== "string") {
    return { ok: false, message: "Ingen Awish-inloggning sparad. Fyll i e-post och lösenord." };
  }
  const client = (deps.makeWebClient ?? createAwishWebClient)(deps.webClientOptions ?? {});
  try {
    await client.login({ email: c.email, password: c.password });
    return { ok: true, message: "Inloggningen till Awish fungerar." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Kunde inte logga in på Awish.",
    };
  }
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

export interface AwishPushPreview {
  ok: boolean;
  /** Kort svensk sammanfattning. */
  message: string;
  machines: Array<{
    code: string | null;
    slotsRead: number;
    planned: Array<{ titleName: string; from: number; to: number }>;
    titlesWithoutSlot: string[];
    error: string | null;
  }>;
}

/**
 * Provkör push till Awish: loggar in, läser automaternas fack och räknar ut vad som
 * skulle ändras, men skriver ingenting. Fungerar även när push är avstängd.
 */
export async function previewAwishPushFor(
  viewer: Viewer,
  deps: ManageDeps = {},
): Promise<AwishPushPreview> {
  await operatorSource(viewer);
  const orgId = viewer.organization.id;
  const pushDeps = {
    serviceDb: deps.serviceDb,
    makeClient: deps.makeWebClient,
    clientOptions: deps.webClientOptions,
    dryRun: true,
  };
  const ids = await linkedAwishMachineIds(orgId, pushDeps);
  if (ids.length === 0) {
    return { ok: false, message: "Ingen automat är kopplad till Awish.", machines: [] };
  }
  const r = await pushMachinesToAwish(orgId, ids, pushDeps);
  if (r.status === "off") {
    return {
      ok: false,
      message:
        r.reason === "no_credentials"
          ? "Ingen Awish-inloggning sparad. Fyll i e-post och lösenord."
          : "Hittar ingen Awish-källa.",
      machines: [],
    };
  }
  const machines = r.machines.map((m) => ({
    code: m.machineCode,
    slotsRead: m.slotsRead ?? 0,
    planned: (m.planned ?? []).map((p) => ({ titleName: p.titleName, from: p.from, to: p.to })),
    titlesWithoutSlot: m.titlesWithoutSlot,
    error:
      m.status === "error"
        ? (m.error ?? "Okänt fel.")
        : m.status === "no_awish_machine"
          ? "Automaten är inte kopplad i Awish."
          : null,
  }));
  const failed = machines.find((m) => m.error);
  if (failed) {
    return { ok: false, message: failed.error ?? "Provkörningen misslyckades.", machines };
  }
  const changes = machines.reduce((n, m) => n + m.planned.length, 0);
  const slots = machines.reduce((n, m) => n + m.slotsRead, 0);
  return {
    ok: true,
    message:
      changes === 0
        ? `Kopplingen fungerar. Läste ${slots} fack i Awish. Inget behöver ändras just nu.`
        : `Kopplingen fungerar. Läste ${slots} fack. ${changes} fack skulle höjas (ändrades inte).`,
    machines,
  };
}

/**
 * Skicka till Awish nu: samma push som efter en påfyllning, för alla kopplade automater.
 * Höjer bara fack som har färre pack i Awish än i Binderlab. Kräver att push är på.
 */
export async function pushAwishNowFor(
  viewer: Viewer,
  deps: ManageDeps = {},
): Promise<{ ok: boolean; message: string }> {
  await operatorSource(viewer);
  const orgId = viewer.organization.id;
  const pushDeps = {
    serviceDb: deps.serviceDb,
    makeClient: deps.makeWebClient,
    clientOptions: deps.webClientOptions,
  };
  const ids = await linkedAwishMachineIds(orgId, pushDeps);
  if (ids.length === 0) return { ok: false, message: "Ingen automat är kopplad till Awish." };
  const r = await pushMachinesToAwish(orgId, ids, pushDeps);
  if (r.status === "off") {
    return {
      ok: false,
      message:
        r.reason === "disabled"
          ? "Slå på Skicka påfyllningar till Awish först."
          : "Ingen Awish-inloggning sparad.",
    };
  }
  const failed = r.machines.find((m) => m.status === "error");
  if (failed) return { ok: false, message: failed.error ?? "Kunde inte skicka till Awish." };
  const slots = r.machines.reduce((n, m) => n + m.slotsUpdated, 0);
  return {
    ok: true,
    message: slots === 0 ? "Awish hade redan rätt antal." : `Skickat till Awish (${slots} fack).`,
  };
}
