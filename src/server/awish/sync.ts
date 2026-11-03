/**
 * Synk från Awish officiella gRPC-API till Binderlab (docs/awish-api.md).
 *
 * Körs av /api/cron/awish (pg_cron var tionde minut, alla aktiva awish_grpc-källor)
 * och av knappen "Synka nu" i Datakällor. Allt körs som systemrollen
 * (getServiceDb): organisation och datakälla kommer alltid ur data_sources-raden,
 * aldrig ur en begäran. Inloggningsuppgifterna läses ur Vault
 * (private.awish_read_credentials) och lämnar aldrig servern.
 *
 * En körning:
 * 1. Tar ett lås på källan (ett "lease" i data_sources.cursor, tre minuter), så att
 *    cron och "Synka nu" inte läser samtidigt.
 * 2. Hämtar automaterna (Machines) och orderna (Orders) enligt paging.ts: det
 *    senaste dygnet, eventuellt glapp, och första gången hela historiken över
 *    flera körningar.
 * 3. Tolkar orderna med adaptern (src/import/adapters/awish-grpc.ts) och skickar
 *    dem genom samma pipeline som en uppladdad fil, i en transaktion med samma
 *    lås per datakälla. Ordrar som redan finns i källan räknas som dubbletter utan
 *    att gå genom pipelinen igen. En betald order som redan finns i en annan
 *    Awish-källa i organisationen (en uppladdad CSV) med samma betaltid och belopp
 *    är samma försäljning och importeras inte (se docs/awish-api.md).
 * 4. Skapar en import (trigger 'schedule') bara när något nytt finns, uppdaterar
 *    källautomaterna (namn, maskinnummer), last_synced_at och läget.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import {
  assertSecretRefInNamespace,
  mapAwishOrders,
  statusKind,
  type AwishGrpcMachine,
  type AwishGrpcOrder,
} from "@/import/adapters/awish-grpc";
import { sha256Hex } from "@/import/hash";
import { classify, commitClassification, type ImportSummary } from "@/import/pipeline";
import { IMPORT_PIPELINE_VERSION } from "@/import/run-import";

import {
  AWISH_PER_PAGE,
  AwishApiError,
  awishClientConfigFromEnv,
  createAwishClient,
  type AwishApi,
  type AwishClientOptions,
  type AwishCredentials,
} from "./grpc-client";
import { collectOrders, parseCursor, type SyncCursor } from "./paging";

type Row = Record<string, unknown>;

/** Högst så många anrop till Orders per körning (20 order per sida). */
export const MAX_ORDER_PAGES = 50;
/** Högst så många sidor med automater. */
export const MAX_MACHINE_PAGES = 10;
/**
 * Hela körningen (alla källor i en cron-körning) får så här lång tid för anropen
 * till Awish. Varje anrops tidsgräns kortas till det som återstår, så att importen
 * hinner sparas långt innan funktionens maxDuration (60 s). Det som inte hanns med
 * fortsätter nästa körning.
 */
export const TIME_BUDGET_MS = 40_000;
/** En källa påbörjas inte med mindre tid kvar än så här (den tas nästa körning). */
export const MIN_SOURCE_MS = 8_000;
/** "Testa anslutningen": kort tidsgräns och inga nya försök, så att svaret kommer snabbt. */
export const TEST_DEADLINE_MS = 8_000;
/** Låset på en källa (om en körning dör släpps det efter så här lång tid). */
export const LEASE_MS = 3 * 60_000;
/** Så många order som redan loggats (återbetald efter import, eller fel) kommer vi ihåg. */
const MAX_REFUND_REPORTED = 500;

export interface AwishSyncDeps {
  db: Db;
  now?: () => Date;
  /** Skapar klienten (testerna ger en låtsasserver). */
  connect?: (creds: AwishCredentials, options?: AwishConnectOptions) => AwishApi;
  maxPages?: number;
  timeBudgetMs?: number;
}

/** Tidsgränser som synken ger klienten (se grpc-client.ts). */
export type AwishConnectOptions = Pick<
  AwishClientOptions,
  "deadlineAt" | "clock" | "deadlineMs" | "maxAttempts"
>;

/** Synkens läge i data_sources.cursor (JSON-text; inga hemligheter). */
export interface AwishSyncState {
  v: 1;
  paging: SyncCursor;
  leaseUntil: string | null;
  lastRun: AwishLastRun | null;
  lastSuccessAt: string | null;
  refundReported: string[];
  /**
   * Beloppsformatet som setts i källan: "decimal" när minst ett belopp med
   * decimalpunkt ("4.00") har kommit. Innan dess stoppas en körning som får ett
   * betalt belopp utan decimaler ("400"): det kan vara öre (dokumentationens
   * tabell säger "Int, unit cent") och skulle då bli 100 gånger för mycket.
   */
  amountFormat: "decimal" | null;
}

export interface AwishLastRun {
  at: string;
  ok: boolean;
  message: string | null;
  pages: number;
  fetched: number;
  imported: number;
  durationMs: number;
  trigger: "schedule" | "manual";
  /** Sidfälten som Awish skickade (total, per_page, last_page, has_more). */
  pagingFields?: string[];
}

export interface AwishSyncResult {
  organizationId: string;
  dataSourceId: string;
  ok: boolean;
  skipped: "locked" | "paused" | "archived" | "no_credentials" | "deferred" | null;
  message: string | null;
  importId: string | null;
  pages: number;
  fetched: number;
  summary: ImportSummary | null;
  otherSourceDuplicates: number;
  historyDone: boolean;
}

export function parseState(text: unknown): AwishSyncState {
  let value: Record<string, unknown> = {};
  if (typeof text === "string" && text.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
    } catch {
      value = {};
    }
  }
  const lastRun = value.lastRun && typeof value.lastRun === "object" ? value.lastRun : null;
  return {
    v: 1,
    paging: parseCursor(value.paging),
    leaseUntil: typeof value.leaseUntil === "string" ? value.leaseUntil : null,
    lastRun: lastRun as AwishLastRun | null,
    lastSuccessAt: typeof value.lastSuccessAt === "string" ? value.lastSuccessAt : null,
    refundReported: Array.isArray(value.refundReported)
      ? value.refundReported.filter((x): x is string => typeof x === "string")
      : [],
    amountFormat: value.amountFormat === "decimal" ? "decimal" : null,
  };
}

async function query<T extends Row>(tx: Tx | Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

interface SourceRow {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  archived_at: unknown;
  org_archived_at: unknown;
  source_timezone: string;
  org_timezone: string;
  secret_ref: string | null;
  cursor: string | null;
}

async function loadSource(db: Db, dataSourceId: string): Promise<SourceRow | undefined> {
  const [row] = await query<SourceRow & Row>(
    db,
    sql`select ds.id, ds.organization_id, ds.name, ds.status::text as status, ds.archived_at,
               o.archived_at as org_archived_at, ds.source_timezone, o.timezone as org_timezone,
               ds.secret_ref, ds.cursor
        from public.data_sources ds
        join public.organizations o on o.id = ds.organization_id
        where ds.id = ${dataSourceId}::uuid and ds.provider = 'awish_grpc'`,
  );
  return row;
}

/** Inloggningsuppgifterna ur Vault (systemrollen). null = inte sparade. */
export async function readCredentials(
  db: Db,
  source: { id: string; organization_id: string; secret_ref: string | null },
): Promise<AwishCredentials | null> {
  if (!source.secret_ref) return null;
  assertSecretRefInNamespace(source.organization_id, source.secret_ref);
  const [row] = await query<{ creds: unknown }>(
    db,
    sql`select private.awish_read_credentials(${source.id}::uuid) as creds`,
  );
  const c = (row?.creds ?? null) as Record<string, unknown> | null;
  if (
    !c ||
    typeof c.appId !== "string" ||
    typeof c.appSecret !== "string" ||
    typeof c.appKey !== "string"
  ) {
    return null;
  }
  return { appId: c.appId, appSecret: c.appSecret, appKey: c.appKey };
}

function defaultConnect(creds: AwishCredentials, options: AwishConnectOptions = {}): AwishApi {
  return createAwishClient(creds, { ...awishClientConfigFromEnv(), ...options });
}

/** Skriver läget om det inte har ändrats av någon annan sedan `expected` lästes. */
async function writeState(
  db: Db | Tx,
  source: { id: string; organization_id: string },
  state: AwishSyncState,
  expected?: string | null,
): Promise<boolean> {
  const text = JSON.stringify(state);
  const updated = await query<{ id: string }>(
    db,
    expected === undefined
      ? sql`update public.data_sources set cursor = ${text}
            where organization_id = ${source.organization_id}::uuid and id = ${source.id}::uuid
            returning id`
      : sql`update public.data_sources set cursor = ${text}
            where organization_id = ${source.organization_id}::uuid and id = ${source.id}::uuid
              and cursor is not distinct from ${expected}
            returning id`,
  );
  return updated.length > 0;
}

/** Högsta Awish-id (som tal) som redan finns i källan. */
async function maxKnownId(tx: Db, source: SourceRow): Promise<string | null> {
  const [row] = await query<{ max: string | null }>(
    tx,
    sql`select max(o.external_id::numeric)::text as max
        from public.orders o
        where o.organization_id = ${source.organization_id}::uuid
          and o.data_source_id = ${source.id}::uuid
          and o.external_id ~ '^[0-9]{1,30}$'`,
  );
  return row?.max ?? null;
}

/**
 * Alla automater (högst MAX_MACHINE_PAGES sidor). Antalet sidor som i paging.ts:
 * last_page, annars total, annars has_more, annars tills en sida inte är full.
 */
export async function fetchMachines(api: AwishApi): Promise<AwishGrpcMachine[]> {
  const all: AwishGrpcMachine[] = [];
  let perPage: number | null = null;
  for (let page = 1; page <= MAX_MACHINE_PAGES; page += 1) {
    const res = await api.machines({ currentPage: page, perPage: AWISH_PER_PAGE });
    all.push(...res.items.map((m) => ({ id: m.id, name: m.name, machineNo: m.machineNo })));
    if (res.items.length === 0) break;
    perPage ??= res.perPage && res.perPage > 0 ? res.perPage : res.items.length;
    const last =
      res.lastPage !== null && res.lastPage > 0
        ? res.lastPage
        : res.total !== null && res.total > 0
          ? Math.ceil(res.total / perPage)
          : null;
    if (last !== null) {
      if (page >= last) break;
    } else if (res.hasMore === false || res.items.length < perPage) {
      break;
    }
  }
  return all;
}

/** Belopp utan decimalpunkt ("400") på en betald order. */
function integerPaidAmount(orders: readonly AwishGrpcOrder[]): AwishGrpcOrder | undefined {
  return orders.find(
    (o) => statusKind(o.status) === "paid" && !o.isFree && /^\s*\d+\s*$/.test(o.amount),
  );
}

/** Fel som stoppar en körning med ett eget meddelande (läget sparas inte). */
class AwishSyncStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwishSyncStop";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof AwishSyncStop) return error.message;
  if (error instanceof AwishApiError) return error.message;
  if (error instanceof Error && error.name === "ImportValidationError") return error.message;
  return "Binderlab kunde inte spara orderna från Awish. Synken försöker igen om tio minuter.";
}

/**
 * Synkar en datakälla av typen awish_grpc. Kastar inte för fel från Awish eller
 * importen: resultatet har ok=false och meddelandet, och läget sparas.
 */
export async function syncAwishSource(
  deps: AwishSyncDeps,
  input: {
    dataSourceId: string;
    trigger?: "schedule" | "manual";
    actorUserId?: string | null;
    /** Absolut tidpunkt (ms) då anropen till Awish måste vara klara (syncAllAwishSources). */
    deadlineAt?: number;
  },
): Promise<AwishSyncResult> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const deadlineAt = input.deadlineAt ?? started.getTime() + (deps.timeBudgetMs ?? TIME_BUDGET_MS);
  const trigger = input.trigger ?? "schedule";
  const source = await loadSource(deps.db, input.dataSourceId);
  const base = {
    organizationId: source?.organization_id ?? "",
    dataSourceId: input.dataSourceId,
    importId: null,
    pages: 0,
    fetched: 0,
    summary: null,
    otherSourceDuplicates: 0,
  };
  if (!source || source.archived_at !== null || source.org_archived_at !== null) {
    return {
      ...base,
      ok: false,
      skipped: "archived",
      message: "Datakällan finns inte eller är arkiverad.",
      historyDone: false,
    };
  }
  const before = parseState(source.cursor);
  if (source.status === "paused") {
    return {
      ...base,
      ok: true,
      skipped: "paused",
      message: "Datakällan är pausad.",
      historyDone: before.paging.historyDone,
    };
  }
  if (before.leaseUntil && Date.parse(before.leaseUntil) > started.getTime()) {
    return {
      ...base,
      ok: true,
      skipped: "locked",
      message: "En synk pågår redan.",
      historyDone: before.paging.historyDone,
    };
  }
  const leased: AwishSyncState = {
    ...before,
    leaseUntil: new Date(started.getTime() + LEASE_MS).toISOString(),
  };
  const leasedText = JSON.stringify(leased);
  if (!(await writeState(deps.db, source, leased, source.cursor))) {
    return {
      ...base,
      ok: true,
      skipped: "locked",
      message: "En synk pågår redan.",
      historyDone: before.paging.historyDone,
    };
  }

  const finish = async (
    result: Omit<AwishSyncResult, "organizationId" | "dataSourceId" | "skipped">,
    paging: SyncCursor,
    refundReported: string[],
    extra: { amountFormat?: "decimal" | null; pagingFields?: string[] } = {},
  ): Promise<AwishSyncResult> => {
    const at = now();
    const lastRun: AwishLastRun = {
      at: at.toISOString(),
      ok: result.ok,
      message: result.message,
      pages: result.pages,
      fetched: result.fetched,
      imported: result.summary?.new ?? 0,
      durationMs: at.getTime() - started.getTime(),
      trigger,
      ...(extra.pagingFields ? { pagingFields: extra.pagingFields } : {}),
    };
    const state: AwishSyncState = {
      v: 1,
      paging,
      leaseUntil: null,
      lastRun,
      lastSuccessAt: result.ok ? at.toISOString() : before.lastSuccessAt,
      refundReported: refundReported.slice(-MAX_REFUND_REPORTED),
      amountFormat: extra.amountFormat ?? before.amountFormat,
    };
    try {
      // Bara om läget är det vi låste med. Har någon sparat ett nytt AppId under
      // körningen (läget nollställt) skrivs inte det gamla kontots sidor tillbaka;
      // då sparas bara senaste körningen ovanpå det nya läget.
      if (!(await writeState(deps.db, source, state, leasedText))) {
        const [current] = await query<{ cursor: string | null }>(
          deps.db,
          sql`select cursor from public.data_sources
              where organization_id = ${source.organization_id}::uuid and id = ${source.id}::uuid`,
        );
        const fresh = parseState(current?.cursor ?? null);
        await writeState(
          deps.db,
          source,
          { ...fresh, leaseUntil: null, lastRun },
          current?.cursor ?? null,
        );
        return {
          ...result,
          organizationId: source.organization_id,
          dataSourceId: source.id,
          skipped: null,
        };
      }
      if (result.ok) {
        await deps.db.execute(
          sql`update public.data_sources set last_synced_at = now()
              where organization_id = ${source.organization_id}::uuid and id = ${source.id}::uuid`,
        );
      }
    } catch (error) {
      console.error("[awish] läget kunde inte sparas", error);
    }
    return {
      ...result,
      organizationId: source.organization_id,
      dataSourceId: source.id,
      skipped: null,
    };
  };

  let creds: AwishCredentials | null;
  try {
    creds = await readCredentials(deps.db, source);
  } catch (error) {
    return finish(
      { ...base, ok: false, message: errorMessage(error), historyDone: false },
      before.paging,
      before.refundReported,
    );
  }
  if (!creds) {
    const r = await finish(
      {
        ...base,
        ok: false,
        message: "AppId, AppSecret och AppKey är inte sparade. Spara dem under Datakällor.",
        historyDone: before.paging.historyDone,
      },
      before.paging,
      before.refundReported,
    );
    return { ...r, skipped: "no_credentials" };
  }

  const clock = () => now().getTime();
  const api = (deps.connect ?? defaultConnect)(creds, { deadlineAt, clock });
  let pages = 0;
  let fetched = 0;
  try {
    const machines = await fetchMachines(api);
    const known = await maxKnownId(deps.db, source);
    const collected = await collectOrders({
      fetchPage: async (page) => {
        const res = await api.orders({ currentPage: page, perPage: AWISH_PER_PAGE });
        return {
          items: res.items,
          total: res.total,
          perPage: res.perPage,
          lastPage: res.lastPage,
          hasMore: res.hasMore,
        };
      },
      cursor: before.paging,
      maxKnownId: known,
      now: started,
      sourceTimezone: source.source_timezone,
      maxPages: deps.maxPages ?? MAX_ORDER_PAGES,
      deadlineAt,
      clock,
      isOutOfTime: (e) => e instanceof AwishApiError && e.kind === "budget",
    });
    pages = collected.pages;
    fetched = collected.orders.length;

    // Beloppsformatet: så länge inget belopp med decimalpunkt har setts i källan
    // stoppas körningen på ett betalt heltalsbelopp (kan vara öre, se AwishSyncState).
    const amountFormat =
      before.amountFormat ??
      (collected.orders.some((o) => /^\s*\d+\.\d+\s*$/.test(o.amount)) ? "decimal" : null);
    const integer = amountFormat === null ? integerPaidAmount(collected.orders) : undefined;
    if (integer) {
      throw new AwishSyncStop(
        `Awish skickade beloppet "${integer.amount.trim().slice(0, 20)}" utan decimaler (order ${integer.id}). ` +
          "Det är inte bekräftat om det är kronor eller öre, så inget importerades. Se docs/awish-api.md (Belopp).",
      );
    }

    const outcome = await importOrders(deps.db, source, {
      orders: collected.orders,
      machines,
      refundReported: before.refundReported,
      actorUserId: input.actorUserId ?? null,
      trigger,
      pages,
    });
    return finish(
      {
        ok: true,
        message: null,
        importId: outcome.importId,
        pages,
        fetched,
        summary: outcome.summary,
        otherSourceDuplicates: outcome.otherSourceDuplicates,
        historyDone: collected.cursor.historyDone,
      },
      collected.cursor,
      outcome.refundReported,
      { amountFormat, pagingFields: collected.pagingFields },
    );
  } catch (error) {
    if (!(error instanceof AwishApiError) && !(error instanceof AwishSyncStop)) {
      console.error("[awish] synken misslyckades", error);
    }
    return finish(
      {
        ...base,
        ok: false,
        message: errorMessage(error),
        pages,
        fetched,
        historyDone: before.paging.historyDone,
      },
      before.paging,
      before.refundReported,
    );
  } finally {
    api.close();
  }
}

interface ImportOutcome {
  importId: string | null;
  summary: ImportSummary | null;
  otherSourceDuplicates: number;
  refundReported: string[];
}

/** Tolkar och importerar orderna i en transaktion (samma lås som filimporten). */
async function importOrders(
  db: Db,
  source: SourceRow,
  input: {
    orders: AwishGrpcOrder[];
    machines: AwishGrpcMachine[];
    refundReported: string[];
    actorUserId: string | null;
    trigger: "schedule" | "manual";
    pages: number;
  },
): Promise<ImportOutcome> {
  const org = source.organization_id;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`binderlab:import:${source.id}`}, 0))`,
    );

    // Källautomaterna: nya läggs i kön, namn och maskinnummer följer Awish.
    if (input.machines.length > 0) {
      const payload = input.machines.map((m) => ({
        external_id: m.id,
        external_name: m.name.trim() || null,
        external_device_no: m.machineNo.trim() || null,
      }));
      await tx.execute(
        sql`insert into public.source_machines
              (organization_id, data_source_id, external_id, external_name, external_device_no)
            select ${org}::uuid, ${source.id}::uuid, r.external_id, r.external_name, r.external_device_no
            from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
              as r(external_id text, external_name text, external_device_no text)
            on conflict (organization_id, data_source_id, external_id) do update
              set external_name = excluded.external_name,
                  external_device_no = excluded.external_device_no
              where source_machines.external_name is distinct from excluded.external_name
                 or source_machines.external_device_no is distinct from excluded.external_device_no`,
      );
    }

    // Order som redan finns i källan går inte genom pipelinen igen (dubbletter), utom
    // en återbetald order som inte har loggats förut: den blir en konflikt en gång.
    const ids = [...new Set(input.orders.map((o) => o.id))];
    const stored = new Set(
      ids.length === 0
        ? []
        : (
            await query<{ external_id: string }>(
              tx,
              sql`select o.external_id from public.orders o
                  where o.organization_id = ${org}::uuid and o.data_source_id = ${source.id}::uuid
                    and o.external_id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`,
            )
          ).map((r) => r.external_id),
    );
    const reported = new Set(input.refundReported);
    const newlyReported: string[] = [];
    let storedDuplicates = 0;
    let skippedUnpaid = 0;
    const batch: AwishGrpcOrder[] = [];
    for (const o of input.orders) {
      const paid = statusKind(o.status) === "paid" && !o.isFree;
      if (!stored.has(o.id)) {
        // Obetalda, gratis-, test- och återbetalda order som inte finns i källan
        // importeras aldrig. De läses om varje körning (sena betalningar) och skulle
        // annars loggas som "ej betald" i varje import; de räknas bara.
        if (paid) batch.push(o);
        else skippedUnpaid += 1;
      } else if (statusKind(o.status) === "refund" && !reported.has(o.id)) {
        batch.push(o);
        newlyReported.push(o.id);
      } else {
        storedDuplicates += 1;
      }
    }
    const mapped = mapAwishOrders({
      orders: batch,
      machines: input.machines,
      sourceTimezone: source.source_timezone,
    });
    // En betald order som inte går att tolka loggas en gång, inte vid varje körning.
    const errors = mapped.errors.filter((e) => {
      if (e.isPaid === false || e.externalId === undefined) return true;
      if (reported.has(e.externalId)) return false;
      newlyReported.push(e.externalId);
      return true;
    });
    const parsed = { ...mapped, errors };

    // Samma försäljning i en annan Awish-källa (t.ex. en uppladdad CSV med andra
    // ordernummer): samma betaltid (sekund) och belopp.
    const paidNew = parsed.rows.filter((r) => r.isPaid);
    const elsewhere = await sameSaleElsewhere(tx, source, paidNew);
    const rows = parsed.rows.filter((r) => !(r.isPaid && elsewhere.has(r.externalId)));
    const otherSourceDuplicates = parsed.rows.length - rows.length;
    const fetched = { ...parsed, rows };

    const refundReported = [...input.refundReported, ...newlyReported];
    const worthImport =
      rows.some((r) => r.isPaid) ||
      parsed.errors.some((e) => e.isPaid !== false) ||
      newlyReported.length > 0;
    if (!worthImport) {
      return { importId: null, summary: null, otherSourceDuplicates, refundReported };
    }

    const ctx = {
      organizationId: org,
      dataSourceId: source.id,
      organizationTimezone: source.org_timezone,
    };
    const classification = await classify(tx, ctx, fetched);
    const sha256 = sha256Hex(JSON.stringify(batch.map((o) => [o.id, o.status, o.amount])));
    const newCount = classification.summary.new;
    const [created] = await query<{ id: string }>(
      tx,
      sql`insert into public.imports (
            organization_id, data_source_id, trigger, file_name, file_sha256, storage_path,
            parser_version, mapping, status, started_at, created_by
          ) values (
            ${org}::uuid, ${source.id}::uuid, 'schedule',
            ${`Awish API · ${newCount} ${newCount === 1 ? "ny order" : "nya order"}${input.trigger === "manual" ? " · Synka nu" : ""}`},
            ${sha256}, ${`${org}/${source.id}/awish-grpc-${sha256}.json`},
            ${`${fetched.parserVersion}+${IMPORT_PIPELINE_VERSION}`},
            ${JSON.stringify({ ...(fetched.mapping ?? {}), pages: input.pages, fetched: input.orders.length, storedDuplicates, otherSourceDuplicates, skippedUnpaid })}::jsonb,
            'running', clock_timestamp(), ${input.actorUserId}::uuid
          )
          returning id`,
    );
    if (!created) throw new Error("Importen kunde inte skapas.");
    const outcome = await commitClassification(tx, ctx, created.id, classification);
    const extra = storedDuplicates + otherSourceDuplicates;
    const s: ImportSummary = {
      ...outcome.summary,
      total: outcome.summary.total + extra,
      duplicate: outcome.summary.duplicate + extra,
    };
    await tx.execute(
      sql`update public.imports
          set rows_total = ${s.total}, rows_new = ${s.new}, rows_duplicate = ${s.duplicate},
              rows_conflict = ${s.conflict}, rows_error = ${s.error},
              status = 'succeeded', finished_at = clock_timestamp()
          where organization_id = ${org}::uuid and id = ${created.id}::uuid`,
    );
    return { importId: created.id, summary: s, otherSourceDuplicates, refundReported };
  });
}

/** Ordernummer (av de givna) vars betaltid och belopp redan finns i en annan Awish-källa. */
async function sameSaleElsewhere(
  tx: Tx,
  source: SourceRow,
  rows: ReadonlyArray<{ externalId: string; paidAtUtc: Date; amountOre: number }>,
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const payload = rows.map((r) => ({
    external_id: r.externalId,
    ordered_at: r.paidAtUtc.toISOString(),
    amount_ore: r.amountOre,
  }));
  const found = await query<{ external_id: string }>(
    tx,
    sql`select distinct r.external_id
        from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          as r(external_id text, ordered_at timestamptz, amount_ore bigint)
        where exists (
          select 1 from public.orders o
          join public.data_sources ds on ds.organization_id = o.organization_id and ds.id = o.data_source_id
          where o.organization_id = ${source.organization_id}::uuid
            and o.data_source_id <> ${source.id}::uuid
            and ds.provider in ('awish_csv', 'awish_web', 'awish_extension', 'awish_grpc')
            and o.ordered_at = r.ordered_at and o.amount_ore = r.amount_ore
        )`,
  );
  return new Set(found.map((r) => r.external_id));
}

/** Alla aktiva awish_grpc-källor (cron). En källa i taget; ett fel stoppar inte de andra. */
export async function syncAllAwishSources(
  deps: AwishSyncDeps,
): Promise<{ sources: AwishSyncResult[] }> {
  const sources = await query<{ id: string }>(
    deps.db,
    sql`select ds.id from public.data_sources ds
        join public.organizations o on o.id = ds.organization_id
        where ds.provider = 'awish_grpc' and ds.archived_at is null and o.archived_at is null
          and ds.status <> 'paused' and ds.secret_ref is not null
        order by ds.last_synced_at asc nulls first, ds.created_at`,
  );
  // En gemensam tidsgräns för hela körningen; varje källa får en lika stor del av det
  // som återstår. En källa som inte hinner börja tas nästa körning (den som synkades
  // längst sedan går först).
  const now = deps.now ?? (() => new Date());
  const deadlineAt = now().getTime() + (deps.timeBudgetMs ?? TIME_BUDGET_MS);
  const results: AwishSyncResult[] = [];
  for (const [index, s] of sources.entries()) {
    const left = deadlineAt - now().getTime();
    if (left < MIN_SOURCE_MS) {
      results.push({
        organizationId: "",
        dataSourceId: s.id,
        ok: true,
        skipped: "deferred",
        message: "Ingen tid kvar i den här körningen; källan synkas nästa gång.",
        importId: null,
        pages: 0,
        fetched: 0,
        summary: null,
        otherSourceDuplicates: 0,
        historyDone: false,
      });
      continue;
    }
    const share = Math.max(MIN_SOURCE_MS, Math.floor(left / (sources.length - index)));
    try {
      results.push(
        await syncAwishSource(deps, {
          dataSourceId: s.id,
          trigger: "schedule",
          deadlineAt: Math.min(deadlineAt, now().getTime() + share),
        }),
      );
    } catch (error) {
      console.error("[awish] källan kunde inte synkas", error);
      results.push({
        organizationId: "",
        dataSourceId: s.id,
        ok: false,
        skipped: null,
        message: errorMessage(error),
        importId: null,
        pages: 0,
        fetched: 0,
        summary: null,
        otherSourceDuplicates: 0,
        historyDone: false,
      });
    }
  }
  return { sources: results };
}

export interface AwishConnectionTest {
  merchantTitle: string;
  merchantExpiresAt: string | null;
  machines: number;
  totalOrders: number | null;
  newestOrder: { id: string; payTime: string | null; status: string } | null;
}

/**
 * "Testa anslutningen": Merchant, Machines och Orders (sida 1, en order) utan att
 * importera något. Kastar AwishApiError med svenskt meddelande.
 */
export async function testAwishConnection(
  deps: Pick<AwishSyncDeps, "db" | "connect" | "now">,
  dataSourceId: string,
): Promise<AwishConnectionTest> {
  const source = await loadSource(deps.db, dataSourceId);
  if (!source) throw new AwishApiError("not_found", "Datakällan finns inte.");
  const creds = await readCredentials(deps.db, source);
  if (!creds) {
    throw new AwishApiError(
      "auth",
      "AppId, AppSecret och AppKey är inte sparade. Spara dem först.",
    );
  }
  const api = (deps.connect ?? defaultConnect)(creds, {
    deadlineMs: TEST_DEADLINE_MS,
    maxAttempts: 1,
  });
  const idOf = (text: string | undefined): bigint | null =>
    text !== undefined && /^\d{1,30}$/.test(text) ? BigInt(text) : null;
  try {
    const merchant = await api.merchant();
    const machines = await api.machines({ currentPage: 1, perPage: AWISH_PER_PAGE });
    const first = await api.orders({ currentPage: 1, perPage: 1 });
    let newest = first.items[0] ?? null;
    // Ordningen är okänd tills synken har sett den: är listan äldst först ligger den
    // nyaste på sista sidan. Vet synken att den är nyast först behövs inget mer anrop.
    const knownOrder = parseState(source.cursor).paging.order;
    if (knownOrder !== "desc" && first.total !== null && first.total > 1) {
      const last = await api.orders({ currentPage: first.total, perPage: 1 });
      const candidate = last.items[0];
      const a = idOf(candidate?.id);
      const b = idOf(newest?.id);
      if (candidate && (b === null || (a !== null && a > b))) newest = candidate;
    }
    return {
      merchantTitle: merchant.title,
      merchantExpiresAt: merchant.expiredAt,
      machines: machines.total ?? machines.items.length,
      totalOrders: first.total,
      newestOrder: newest
        ? { id: newest.id, payTime: newest.payTime, status: newest.status }
        : null,
    };
  } finally {
    api.close();
  }
}
