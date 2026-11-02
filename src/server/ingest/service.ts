/**
 * Ingest från Awish Chrome-tillägget: token → datakälla → samma importflöde som en
 * uppladdad orderlista. Anropas av route handlers i src/app/api/ingest/awish och
 * direkt av testerna (test/db/ingest-*.test.ts).
 *
 * Behörighet:
 * - Token slås upp på sin sha256 (systemrollen, eftersom ingen användare är inloggad).
 *   En okänd, återkallad eller felformad token nekas med samma svar (401).
 * - Allt som skrivs i organisationens data (import, order, titlar, källautomater,
 *   data_sources.last_synced_at) görs SOM den som skapade token, med RLS, och bara så
 *   länge hen är ägare eller admin i organisationen. Tappar hen rollen slutar token
 *   att fungera (403) utan att någon behöver återkalla den.
 * - Bara tokenens egen datakälla kan skrivas: organisation och datakälla kommer ur
 *   tokenraden, aldrig ur begäran.
 * - Kontaktfälten på tokenraden (senast sedd, senaste batch, status, fel, version)
 *   skrivs av systemrollen; triggern hindrar klientroller från att ändra dem.
 *
 * Varje batch med rader blir en import (trigger 'extension') i en transaktion med
 * samma lås per datakälla som filimporten. En tom batch är en hjärtslag: inget
 * importeras, men last_synced_at uppdateras om tillägget rapporterar att synken
 * gick bra och källan är aktiv (inte pausad).
 *
 * Samma Awish-order i flera källor: ordernumret är unikt per datakälla, men en
 * organisation som redan har laddat upp Awish orderlista som CSV (awish_csv) eller har
 * en annan Awish-källa får inte samma order två gånger när tillägget läser historiken.
 * En betald rad vars ordernummer redan finns i en annan Awish-källa i organisationen
 * räknas därför som dubblett och importeras inte (imports.mapping.otherSourceDuplicates).
 * Status-API:t räknar på samma sätt alla Awish-källor, så att tillägget slutar läsa vid
 * ordrar som finns i CSV-källan. Larmet för utebliven hämtning (src/analytics/alerts/rules.ts,
 * importAlerts) slår till när last_synced_at är äldre än två timmar.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import type { AdapterContext } from "@/import/adapter";
import { parseAwishExtensionBatch } from "@/import/adapters/awish-extension";
import { ImportError } from "@/import/errors";
import { sha256Hex } from "@/import/hash";
import { classify, commitClassification, type ImportSummary } from "@/import/pipeline";
import { IMPORT_PIPELINE_VERSION } from "@/import/run-import";

import { IngestError, type IngestBody } from "./body";
import {
  BAD_TOKEN_PER_MINUTE,
  MAX_BATCH_ROWS,
  MAX_BODY_BYTES,
  STATUS_KNOWN_IDS,
  type IngestLimiters,
} from "./limits";
import { bearerToken, hashToken } from "./tokens";

type Row = Record<string, unknown>;

/**
 * Datakällor med Awish ordernummer: samma order kan finnas i flera av dem. Listan står
 * också som literal i SQL-frågorna nedan (inga råa SQL-fragment).
 */
export const AWISH_PROVIDERS = ["awish_grpc", "awish_web", "awish_csv", "awish_extension"] as const;

const UNAUTHORIZED =
  "Token är ogiltig eller återkallad. Skapa en ny token under Datakällor i Binderlab.";

/** Token som har slagits upp och godkänts. */
export interface TokenContext {
  tokenId: string;
  organizationId: string;
  dataSourceId: string;
  /** Den som skapade token; skrivningarna görs som hen, med RLS. */
  actorUserId: string;
}

export interface IngestDeps {
  db: Db;
  limiters: IngestLimiters;
  now?: () => Date;
}

async function query<T extends Row>(tx: Tx | Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Som withRls, men på anslutningen som skickas in (testerna och servern delar kod). */
async function asActor<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const jwt = JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" });
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${jwt}, true)`);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

function rateLimited(retryAfterMs: number): IngestError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new IngestError(
    "rate_limited",
    429,
    `För många anrop. Tillägget försöker igen om ${seconds} s.`,
    seconds,
  );
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/**
 * Slår upp token ur Authorization-huvudet. Kastar IngestError 401 (saknas, fel form,
 * okänd, återkallad), 403 (skaparen är inte längre ägare/admin, datakällan arkiverad
 * eller av fel typ) eller 429 (för många försök med ogiltig token från samma IP).
 */
export async function authenticate(
  deps: IngestDeps,
  authorization: string | null | undefined,
  clientKey = "okänd",
): Promise<TokenContext> {
  // Spärren gäller bara misslyckade försök: en giltig token släpps alltid fram, även om
  // någon annan bakom samma IP (eller utan proxyrubriker, nyckeln "okänd") har provat
  // ogiltiga tokens. Token har 256 bitar slump, så spärren är bara ett skydd mot brus.
  const badKey = `bad:${clientKey}`;
  const reject = (): never => {
    const blocked = deps.limiters.badToken.check(badKey, BAD_TOKEN_PER_MINUTE);
    if (!blocked.allowed) throw rateLimited(blocked.retryAfterMs);
    deps.limiters.badToken.hit(badKey);
    throw new IngestError("unauthorized", 401, UNAUTHORIZED);
  };

  const token = bearerToken(authorization);
  if (!token) return reject();
  const [row] = await query<{
    id: string;
    organization_id: string;
    data_source_id: string;
    created_by: string | null;
    revoked_at: unknown;
    provider: string;
    archived_at: unknown;
    org_archived_at: unknown;
    actor_ok: boolean;
  }>(
    deps.db,
    sql`select t.id, t.organization_id, t.data_source_id, t.created_by, t.revoked_at,
               ds.provider::text as provider, ds.archived_at, o.archived_at as org_archived_at,
               exists (
                 select 1 from public.memberships m
                 where m.organization_id = t.organization_id and m.user_id = t.created_by
                   and m.role in ('owner', 'admin')
               ) as actor_ok
        from public.sync_tokens t
        join public.data_sources ds on ds.organization_id = t.organization_id and ds.id = t.data_source_id
        join public.organizations o on o.id = t.organization_id
        where t.token_hash = ${hashToken(token)}`,
  );
  if (!row || row.revoked_at !== null) return reject();
  if (row.org_archived_at !== null) {
    throw new IngestError("forbidden", 403, "Organisationen är arkiverad.");
  }
  if (row.provider !== "awish_extension" || row.archived_at !== null) {
    throw new IngestError(
      "source_unavailable",
      403,
      "Datakällan för den här token är arkiverad. Skapa en ny token under Datakällor.",
    );
  }
  if (!row.created_by || !row.actor_ok) {
    throw new IngestError(
      "forbidden",
      403,
      "Den som skapade token är inte längre ägare eller admin. Skapa en ny token under Datakällor.",
    );
  }
  return {
    tokenId: row.id,
    organizationId: row.organization_id,
    dataSourceId: row.data_source_id,
    actorUserId: row.created_by,
  };
}

/** Uppdaterar tokenradens kontaktfält (systemrollen). Får aldrig stoppa svaret. */
async function touchToken(
  deps: IngestDeps,
  ctx: TokenContext,
  fields: {
    batch?: boolean;
    status?: "ok" | "logged_out" | "error" | null;
    error?: string | null;
    clientVersion?: string | null;
  },
): Promise<void> {
  const now = (deps.now?.() ?? new Date()).toISOString();
  try {
    await deps.db.execute(
      sql`update public.sync_tokens
          set last_seen_at = ${now}::timestamptz,
              last_batch_at = case when ${fields.batch === true} then ${now}::timestamptz else last_batch_at end,
              last_status = case when ${fields.status !== undefined} then ${fields.status ?? null} else last_status end,
              last_error = case when ${fields.error !== undefined} then ${fields.error?.slice(0, 500) ?? null} else last_error end,
              client_version = coalesce(${fields.clientVersion?.slice(0, 100) ?? null}, client_version)
          where organization_id = ${ctx.organizationId}::uuid and id = ${ctx.tokenId}::uuid`,
    );
  } catch (error) {
    console.error("[ingest] tokenraden kunde inte uppdateras", error);
  }
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export interface IngestResult {
  /** imports.id, eller null för en hjärtslag utan rader. */
  importId: string | null;
  summary: ImportSummary | null;
  /** Betalda rader vars ordernummer redan finns i en annan Awish-källa (räknas som dubbletter). */
  otherSourceDuplicates: number;
  unknownMachines: number;
  newTitles: number;
  lastSyncedAt: string | null;
}

/**
 * imports.storage_path för en batch: samma namnrymd som uppladdade filer
 * ("{organisation}/{datakälla}/..."), med batchens sha256. Batchen sparas inte som fil;
 * raderna finns i import_rows (nya, konflikter och fel) och i orders. Sökvägen gör att
 * samma batch känns igen och följer samma regel som alla importer (imports_check).
 */
function batchStoragePath(ctx: TokenContext, sha256: string): string {
  return `${ctx.organizationId}/${ctx.dataSourceId}/extension-${sha256}.json`;
}

function batchFileName(body: IngestBody): string {
  const pages = body.rows.map((r) => r.page).filter((p): p is number => typeof p === "number");
  const span =
    pages.length === 0
      ? ""
      : Math.min(...pages) === Math.max(...pages)
        ? ` · sida ${Math.min(...pages)}`
        : ` · sida ${Math.min(...pages)}–${Math.max(...pages)}`;
  return `Chrome-tillägg${span} · ${body.rows.length} ${body.rows.length === 1 ? "rad" : "rader"}`;
}

/**
 * Tar emot en batch (eller en hjärtslag) från tillägget. Rate limit per token, sedan
 * importen som tokenens skapare med RLS.
 */
export async function ingestBatch(
  deps: IngestDeps,
  ctx: TokenContext,
  body: IngestBody,
): Promise<IngestResult> {
  const decision = deps.limiters.batches.consume([{ key: `batch:${ctx.tokenId}` }]);
  if (!decision.allowed) throw rateLimited(decision.retryAfterMs);

  const report = body.report;
  const clientVersion = body.client?.version ?? null;

  if (body.rows.length === 0) {
    // Hjärtslag: inget importeras. last_synced_at bara när synken gick bra.
    let lastSyncedAt: string | null = null;
    if (report?.state === "ok") {
      lastSyncedAt = await asActor(deps.db, ctx.actorUserId, async (tx) => {
        await assertActor(tx, ctx);
        const [r] = await query<{ last_synced_at: unknown }>(
          tx,
          sql`update public.data_sources set last_synced_at = now()
              where organization_id = ${ctx.organizationId}::uuid and id = ${ctx.dataSourceId}::uuid
                and archived_at is null and status <> 'paused'
              returning last_synced_at`,
        );
        return iso(r?.last_synced_at);
      });
    }
    await touchToken(deps, ctx, {
      status: report?.state ?? null,
      error: report && report.state !== "ok" ? (report.message ?? null) : null,
      clientVersion,
    });
    return {
      importId: null,
      summary: null,
      otherSourceDuplicates: 0,
      unknownMachines: 0,
      newTitles: 0,
      lastSyncedAt,
    };
  }

  const sha256 = sha256Hex(JSON.stringify({ rows: body.rows, absent: body.absent ?? [] }));
  try {
    const result = await asActor(deps.db, ctx.actorUserId, async (tx) => {
      await assertActor(tx, ctx);
      const [source] = await query<{
        name: string;
        source_timezone: string;
        status: string;
        org_timezone: string;
      }>(
        tx,
        sql`select ds.name, ds.source_timezone, ds.status::text as status, o.timezone as org_timezone
            from public.data_sources ds
            join public.organizations o on o.id = ds.organization_id
            where ds.organization_id = ${ctx.organizationId}::uuid
              and ds.id = ${ctx.dataSourceId}::uuid
              and ds.provider = 'awish_extension' and ds.archived_at is null`,
      );
      if (!source) {
        throw new IngestError(
          "source_unavailable",
          403,
          "Datakällan finns inte eller är arkiverad.",
        );
      }
      if (source.status === "paused") {
        throw new IngestError(
          "source_unavailable",
          409,
          "Datakällan är pausad i Binderlab. Inget importeras förrän den är aktiv igen.",
        );
      }
      const context: AdapterContext = {
        organizationId: ctx.organizationId,
        dataSourceId: ctx.dataSourceId,
        sourceTimezone: source.source_timezone,
        config: {},
        secretRef: null,
      };
      const parsed = parseAwishExtensionBatch({
        context,
        rows: body.rows,
        absent: body.absent,
      });

      // Samma lås som filimporten (src/import/run-import.ts): en import per källa i taget.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`binderlab:import:${ctx.dataSourceId}`}, 0))`,
      );
      const pipelineCtx = {
        organizationId: ctx.organizationId,
        dataSourceId: ctx.dataSourceId,
        organizationTimezone: source.org_timezone,
      };
      // Ordrar som redan finns i en annan Awish-källa (t.ex. en uppladdad CSV) är samma
      // order: de importeras inte en gång till.
      const elsewhere = await ordersInOtherAwishSources(
        tx,
        ctx,
        parsed.rows.filter((r) => r.isPaid).map((r) => r.externalId),
      );
      const fetched =
        elsewhere.size === 0
          ? parsed
          : {
              ...parsed,
              rows: parsed.rows.filter((r) => !(r.isPaid && elsewhere.has(r.externalId))),
            };
      const otherSourceDuplicates = parsed.rows.length - fetched.rows.length;
      const classification = await classify(tx, pipelineCtx, fetched);
      const [created] = await query<{ id: string }>(
        tx,
        sql`insert into public.imports (
              organization_id, data_source_id, trigger, file_name, file_sha256, storage_path,
              parser_version, mapping, status, started_at
            ) values (
              ${ctx.organizationId}::uuid, ${ctx.dataSourceId}::uuid, 'extension',
              ${batchFileName(body)}, ${sha256}, ${batchStoragePath(ctx, sha256)},
              ${`${fetched.parserVersion}+${IMPORT_PIPELINE_VERSION}`},
              ${JSON.stringify({ ...(fetched.mapping ?? {}), report: report ?? null, client: body.client ?? null, batch: body.batch ?? null, otherSourceDuplicates })}::jsonb,
              'running', clock_timestamp()
            )
            returning id`,
      );
      if (!created) throw new Error("Importen kunde inte skapas.");
      const outcome = await commitClassification(tx, pipelineCtx, created.id, classification);
      const s: ImportSummary = {
        ...outcome.summary,
        total: outcome.summary.total + otherSourceDuplicates,
        duplicate: outcome.summary.duplicate + otherSourceDuplicates,
      };
      await tx.execute(
        sql`update public.imports
            set rows_total = ${s.total}, rows_new = ${s.new}, rows_duplicate = ${s.duplicate},
                rows_conflict = ${s.conflict}, rows_error = ${s.error},
                status = 'succeeded', finished_at = clock_timestamp()
            where organization_id = ${ctx.organizationId}::uuid and id = ${created.id}::uuid`,
      );
      const [synced] = await query<{ last_synced_at: unknown }>(
        tx,
        sql`update public.data_sources set last_synced_at = now()
            where organization_id = ${ctx.organizationId}::uuid and id = ${ctx.dataSourceId}::uuid
            returning last_synced_at`,
      );
      return {
        importId: created.id,
        summary: s,
        otherSourceDuplicates,
        unknownMachines: outcome.unknownMachines.length,
        newTitles: outcome.newTitles.length,
        lastSyncedAt: iso(synced?.last_synced_at),
      };
    });
    await touchToken(deps, ctx, {
      batch: true,
      status: report?.state ?? "ok",
      error: report && report.state !== "ok" ? (report.message ?? null) : null,
      clientVersion,
    });
    return result;
  } catch (error) {
    if (error instanceof IngestError) {
      await touchToken(deps, ctx, { status: "error", error: error.message, clientVersion });
      throw error;
    }
    if (error instanceof ImportError) {
      await touchToken(deps, ctx, { status: "error", error: error.message, clientVersion });
      throw new IngestError("invalid", 400, error.message);
    }
    // Oväntat fel: importen rullades tillbaka. En misslyckad import sparas så att
    // Datakällor visar den och larmet import_failed slår till.
    await recordFailedBatch(deps, ctx, body, sha256);
    await touchToken(deps, ctx, {
      status: "error",
      error: "Binderlab kunde inte spara batchen. Tillägget försöker igen.",
      clientVersion,
    });
    console.error("[ingest] batchen kunde inte importeras", error);
    throw new IngestError(
      "failed",
      500,
      "Binderlab kunde inte spara batchen. Tillägget försöker igen.",
    );
  }
}

/** Ordernummer (av de givna) som finns i en annan Awish-källa i organisationen. */
async function ordersInOtherAwishSources(
  tx: Tx,
  ctx: TokenContext,
  externalIds: readonly string[],
): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const found = await query<{ external_id: string }>(
    tx,
    sql`select distinct o.external_id
        from public.orders o
        join public.data_sources ds on ds.organization_id = o.organization_id and ds.id = o.data_source_id
        where o.organization_id = ${ctx.organizationId}::uuid
          and o.data_source_id <> ${ctx.dataSourceId}::uuid
          and ds.provider in ('awish_grpc', 'awish_web', 'awish_csv', 'awish_extension')
          and o.external_id in (select jsonb_array_elements_text(${JSON.stringify([...new Set(externalIds)])}::jsonb))`,
  );
  return new Set(found.map((r) => r.external_id));
}

/** Skaparen måste fortfarande vara ägare eller admin (kontrolleras i samma transaktion). */
async function assertActor(tx: Tx, ctx: TokenContext): Promise<void> {
  const [access] = await query<{ ok: boolean }>(
    tx,
    sql`select private.has_role(${ctx.organizationId}::uuid,
               'owner'::public.member_role, 'admin'::public.member_role) as ok`,
  );
  if (!access?.ok) {
    throw new IngestError(
      "forbidden",
      403,
      "Den som skapade token är inte längre ägare eller admin. Skapa en ny token under Datakällor.",
    );
  }
}

async function recordFailedBatch(
  deps: IngestDeps,
  ctx: TokenContext,
  body: IngestBody,
  sha256: string,
): Promise<void> {
  try {
    await deps.db.execute(
      sql`insert into public.imports (
            organization_id, data_source_id, trigger, file_name, file_sha256, storage_path,
            parser_version, rows_total, status, started_at, finished_at, created_by
          ) values (
            ${ctx.organizationId}::uuid, ${ctx.dataSourceId}::uuid, 'extension',
            ${batchFileName(body)}, ${sha256}, ${batchStoragePath(ctx, sha256)},
            ${`awish_extension/1+${IMPORT_PIPELINE_VERSION}`}, ${body.rows.length},
            'failed', now(), now(), ${ctx.actorUserId}::uuid
          )`,
    );
  } catch (error) {
    console.error("[ingest] den misslyckade importen kunde inte sparas", error);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface IngestStatus {
  ok: true;
  dataSource: { id: string; name: string; sourceTimezone: string; status: string };
  lastSyncedAt: string | null;
  orders: {
    /** Ordrar i organisationens alla Awish-källor (tillägget, CSV, ...). */
    count: number;
    /** Ordrar i just den här datakällan. */
    sourceCount: number;
    latestExternalId: string | null;
    latestOrderedAt: string | null;
    /**
     * De senaste ordernumren (högst 500) i alla Awish-källor, nyast först: tillägget
     * slutar läsa när det når dem, även när de kom från en uppladdad CSV.
     */
    knownExternalIds: string[];
  };
  limits: { maxRows: number; maxBodyBytes: number };
  serverTime: string;
}

/** Status för tillägget: hur långt bakåt det behöver läsa. Läses som tokenens skapare. */
export async function ingestStatus(deps: IngestDeps, ctx: TokenContext): Promise<IngestStatus> {
  const decision = deps.limiters.status.consume([{ key: `status:${ctx.tokenId}` }]);
  if (!decision.allowed) throw rateLimited(decision.retryAfterMs);

  const status = await asActor(deps.db, ctx.actorUserId, async (tx) => {
    await assertActor(tx, ctx);
    const [source] = await query<{
      id: string;
      name: string;
      source_timezone: string;
      status: string;
      last_synced_at: unknown;
      orders: number;
      family_orders: number;
    }>(
      tx,
      sql`select ds.id, ds.name, ds.source_timezone, ds.status::text as status, ds.last_synced_at,
                 (select count(*) from public.orders o
                   where o.organization_id = ds.organization_id and o.data_source_id = ds.id)::int as orders,
                 (select count(*) from public.orders o
                   join public.data_sources f on f.organization_id = o.organization_id and f.id = o.data_source_id
                   where o.organization_id = ds.organization_id and f.provider in ('awish_grpc', 'awish_web', 'awish_csv', 'awish_extension'))::int as family_orders
          from public.data_sources ds
          where ds.organization_id = ${ctx.organizationId}::uuid and ds.id = ${ctx.dataSourceId}::uuid`,
    );
    if (!source) {
      throw new IngestError("source_unavailable", 403, "Datakällan finns inte.");
    }
    const recent = await query<{ external_id: string; ordered_at: unknown }>(
      tx,
      sql`select o.external_id, o.ordered_at from public.orders o
          join public.data_sources f on f.organization_id = o.organization_id and f.id = o.data_source_id
          where o.organization_id = ${ctx.organizationId}::uuid
            and f.provider in ('awish_grpc', 'awish_web', 'awish_csv', 'awish_extension')
          order by o.ordered_at desc, o.external_id desc
          limit ${STATUS_KNOWN_IDS}`,
    );
    return {
      ok: true as const,
      dataSource: {
        id: source.id,
        name: source.name,
        sourceTimezone: source.source_timezone,
        status: source.status,
      },
      lastSyncedAt: iso(source.last_synced_at),
      orders: {
        count: Number(source.family_orders),
        sourceCount: Number(source.orders),
        latestExternalId: recent[0]?.external_id ?? null,
        latestOrderedAt: iso(recent[0]?.ordered_at),
        knownExternalIds: recent.map((r) => r.external_id),
      },
      limits: { maxRows: MAX_BATCH_ROWS, maxBodyBytes: MAX_BODY_BYTES },
      serverTime: (deps.now?.() ?? new Date()).toISOString(),
    };
  });
  await touchToken(deps, ctx, {});
  return status;
}
