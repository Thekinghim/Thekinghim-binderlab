/**
 * Vakten (@/analytics/watch) mot databasen.
 *
 *   loadWatchFor(viewer)     raderna som visas på Hem och Drift (ägare och admin). Räknas
 *                            ur databasen varje gång sidan öppnas, så raden kommer fram även
 *                            när inget schemalagt jobb körs.
 *   syncWatchAlerts(db, …)   samma rader som larm (public.alerts, nyckel `watch:<rad>`):
 *                            skapas när raden finns, stängs när den är borta. Anropas av de
 *                            jobb som går (Awish-synken var femte minut, larmjobbet varje
 *                            dygn), så ett jobb som har stannat larmas av ett annat.
 *
 * Läses som systemroll med organisationen ur en kontrollerad session eller ett systemjobb,
 * aldrig ur indata: vem som nås av larm kräver andras prenumerationer och enheter, som
 * ingen användare får läsa under RLS. Raderna innehåller inga adresser eller namn.
 * Inget här kastar: vakten får aldrig stoppa sidan eller jobbet.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { cache } from "react";

import {
  AWISH_WATCH_KEYS,
  awishFreshnessText,
  awishStatusLines,
  machineAges,
  machineAgeSummary,
  ordersBannerText,
  syncBroken,
  watchLines,
  type AwishPathFacts,
  type AwishPathName,
  type AwishRouteName,
  type AwishStatusLine,
  type AwishWatchFacts,
  type ChannelsWorking,
  type CronAnswer,
  type MachineAge,
  type ReachMember,
  type SyncSourceFacts,
  type WatchFacts,
  type WatchLine,
} from "@/analytics/watch";
import { wallClockIn } from "@/components/shell/period-state";
import { getServiceDb, type Db } from "@/db/client";
import { formatDateTime, formatTime } from "@/lib/format";
import type { Viewer } from "@/server/data/core/loaders";
import { mailCanSend } from "@/server/mail/can-send";
import { pushStatus } from "@/server/notify/push";
import { smsStatus } from "@/server/notify/sms";

import { raiseAndNotify, safely } from "./failures";
import { notifySystemAlert } from "./notify";
import { resolveSystemAlert } from "./system-alerts";

type Env = Readonly<Record<string, string | undefined>>;

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Vilka kanaler som går att skicka i från den här miljön. */
export async function channelsWorking(env: Env = process.env): Promise<ChannelsWorking> {
  const push = await pushStatus(env).catch(() => ({ configured: false }));
  return { email: mailCanSend(env), push: push.configured, sms: smsStatus(env).configured };
}

/** Ägare och admin med sina kanaler och enheter. Utan sparad rad gäller standarden. */
export async function loadReachMembers(db: Db, orgId: string): Promise<ReachMember[]> {
  const rows = Array.from(
    await db.execute(
      sql`select coalesce(a.active, true) as active,
                 coalesce(a.channels, array['push', 'email']::text[]) as channels,
                 (u.email is not null and u.email <> '') as has_email,
                 (a.phone is not null) as has_phone,
                 (select count(*)::int from public.push_subscriptions p
                   where p.organization_id = m.organization_id and p.user_id = m.user_id
                     and p.disabled_at is null) as devices
          from public.memberships m
          join auth.users u on u.id = m.user_id
          left join public.alert_subscriptions a
            on a.organization_id = m.organization_id and a.user_id = m.user_id
          where m.organization_id = ${orgId}::uuid and m.role in ('owner', 'admin')`,
    ),
  ) as {
    active: boolean;
    channels: string[];
    has_email: boolean;
    has_phone: boolean;
    devices: number;
  }[];
  return rows.map((r) => ({
    active: Boolean(r.active),
    channels: r.channels ?? [],
    hasEmail: Boolean(r.has_email),
    hasPhone: Boolean(r.has_phone),
    devices: Number(r.devices),
  }));
}

interface CursorState {
  lastSuccessAt?: unknown;
  failures?: unknown;
  lastRun?: { at?: unknown; ok?: unknown; message?: unknown } | null;
}

function parseCursor(text: string | null): CursorState {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as CursorState) : {};
  } catch {
    return {};
  }
}

/** Awish-källorna som hämtas enligt schema: aktiva, med inloggning och minst en automat. */
export async function loadSyncFacts(db: Db, orgId: string): Promise<SyncSourceFacts[]> {
  const rows = Array.from(
    await db.execute(
      sql`select ds.id::text as id, ds.name, ds.cursor, ds.created_at
          from public.data_sources ds
          where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
            and ds.archived_at is null and ds.status = 'active' and ds.secret_ref is not null
          order by ds.created_at`,
    ),
  ) as { id: string; name: string | null; cursor: string | null; created_at: unknown }[];
  return rows.map((r) => {
    const c = parseCursor(r.cursor);
    const run = c.lastRun ?? null;
    const failed = run !== null && run.ok === false;
    return {
      id: r.id,
      name: r.name || "Awish",
      lastSuccessAt: typeof c.lastSuccessAt === "string" ? iso(c.lastSuccessAt) : null,
      lastRunAt: run && typeof run.at === "string" ? iso(run.at) : null,
      lastError: failed && typeof run.message === "string" ? run.message.slice(0, 200) : null,
      failures: Number.isInteger(c.failures) ? Number(c.failures) : failed ? 1 : 0,
      createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    };
  });
}

/**
 * Senaste anropet från pg_cron till jobbet och svaret (private.cron_calls). Bara anrop som
 * är äldre än tolv minuter: ett anrop får ta fem minuter, och svaret läses vid nästa tick.
 * null utan tabellen eller utan anrop (lokalt och i tester finns inget pg_cron).
 */
export async function loadCronAnswer(db: Db, job: string): Promise<CronAnswer | null> {
  return safely(
    "schemats svar",
    async () => {
      const [exists] = Array.from(
        await db.execute(sql`select to_regclass('private.cron_calls') is not null as ok`),
      ) as { ok: boolean }[];
      if (!exists?.ok) return null;
      const [row] = Array.from(
        await db.execute(
          sql`select called_at, status_code, coalesce(timed_out, false) as timed_out
              from private.cron_calls
              where job = ${job} and called_at < now() - interval '12 minutes'
              order by called_at desc limit 1`,
        ),
      ) as { called_at: unknown; status_code: number | null; timed_out: boolean }[];
      const calledAt = row ? iso(row.called_at) : null;
      if (!row || !calledAt) return null;
      return {
        calledAt,
        statusCode: row.status_code === null ? null : Number(row.status_code),
        timedOut: Boolean(row.timed_out),
      };
    },
    null,
  );
}

/**
 * Hälsan per Awish-väg för organisationens aktiva Awish-källor (public.awish_path_health)
 * och påfyllningarna som väntar på Awish. En pausad eller arkiverad källa räknas inte.
 */
export async function loadAwishWatchFacts(db: Db, orgId: string): Promise<AwishWatchFacts> {
  const rows = Array.from(
    await db.execute(
      sql`select h.data_source_id::text as source_id, h.path, h.active_route, h.last_success_at,
                 h.last_success_route, h.last_attempt_at, h.last_error_at, h.last_error_kind,
                 h.last_error_code, h.failing_since, h.breaker_route, h.breaker_open_until,
                 h.fallback_since
          from public.awish_path_health h
          join public.data_sources ds
            on ds.organization_id = h.organization_id and ds.id = h.data_source_id
          where h.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
            and ds.archived_at is null and ds.status = 'active'
          order by h.path, ds.created_at`,
    ),
  ) as Record<string, unknown>[];
  const paths: AwishPathFacts[] = rows.map((r) => ({
    sourceId: String(r.source_id),
    path: r.path as AwishPathName,
    activeRoute: r.active_route as AwishRouteName,
    lastSuccessAt: iso(r.last_success_at),
    lastSuccessRoute: (r.last_success_route as AwishRouteName | null) ?? null,
    lastAttemptAt: iso(r.last_attempt_at),
    lastErrorAt: iso(r.last_error_at),
    lastErrorKind: (r.last_error_kind as string | null) ?? null,
    lastErrorCode: r.last_error_code === null ? null : Number(r.last_error_code),
    failingSince: iso(r.failing_since),
    breakerRoute: (r.breaker_route as AwishRouteName | null) ?? null,
    breakerOpenUntil: iso(r.breaker_open_until),
    fallbackSince: iso(r.fallback_since),
  }));
  // Automater vars senaste sändning till Awish felade (samma regel som Fyll på:
  // public.awish_push_pending), utan arkiverade.
  const [push] = Array.from(
    await db.execute(
      sql`select count(*)::int as pending, min(l.occurred_at) as oldest
          from (
            select distinct on (a.machine_id) a.machine_id, a.kind, a.occurred_at
            from public.automation_log a
            where a.organization_id = ${orgId}::uuid and a.machine_id is not null
              and a.kind in ('awish_push', 'awish_push_failed', 'awish_push_cleared')
            order by a.machine_id, a.occurred_at desc, a.created_at desc, a.id desc
          ) l
          join public.machines m on m.organization_id = ${orgId}::uuid and m.id = l.machine_id
          where l.kind = 'awish_push_failed' and m.archived_at is null`,
    ),
  ) as { pending: number; oldest: unknown }[];
  // Kopplade automater vars fack inte har lästs på 30 min (en automat kan fela medan de andra
  // läses: då ser vägen frisk ut). Arkiverade och pausade källor räknas inte.
  const linked = Array.from(
    await db.execute(
      sql`select l.awish_synced_at as read_at, k.created_at as linked_at
          from (
            select distinct on (sm.machine_id) sm.machine_id, sm.created_at
            from public.source_machines sm
            join public.data_sources ds
              on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
            where sm.organization_id = ${orgId}::uuid and sm.machine_id is not null
              and ds.provider = 'awish_grpc' and ds.archived_at is null and ds.status = 'active'
              and sm.external_id ~ '^[0-9]{1,30}$'
            order by sm.machine_id, sm.created_at
          ) k
          join public.machines m on m.organization_id = ${orgId}::uuid and m.id = k.machine_id
          left join public.stock_locations l
            on l.organization_id = ${orgId}::uuid and l.machine_id = k.machine_id
           and l.kind = 'machine' and l.archived_at is null
          where m.archived_at is null`,
    ),
  ) as { read_at: unknown; linked_at: unknown }[];
  return {
    paths,
    push: { pendingMachines: Number(push?.pending ?? 0), oldestAt: iso(push?.oldest ?? null) },
    linkedStock: linked.flatMap((r) => {
      const linkedAt = iso(r.linked_at);
      return linkedAt ? [{ readAt: iso(r.read_at), linkedAt }] : [];
    }),
  };
}

/** Allt vakten behöver om organisationen. `null` = finns inte, är arkiverad eller en demo. */
export async function loadWatchFacts(
  db: Db,
  orgId: string,
  env: Env = process.env,
): Promise<{ facts: WatchFacts; timeZone: string } | null> {
  const [org] = Array.from(
    await db.execute(
      sql`select o.timezone, o.is_demo, o.created_at,
                 (select max(r.ran_at) from public.self_check_runs r
                   where r.organization_id = o.id and r.trigger = 'schedule') as check_at,
                 (select max(r.ran_at) from public.alert_runs r
                   where r.organization_id = o.id and r.status = 'ok') as alert_at
          from public.organizations o
          where o.id = ${orgId}::uuid and o.archived_at is null`,
    ),
  ) as {
    timezone: string;
    is_demo: boolean;
    created_at: unknown;
    check_at: unknown;
    alert_at: unknown;
  }[];
  // En demo skickar aldrig något och körs inte av larmjobbet: där finns inget att vakta.
  if (!org || org.is_demo) return null;
  const createdAt = iso(org.created_at) ?? new Date(0).toISOString();
  const [members, works, sync, lastCall, awish] = await Promise.all([
    loadReachMembers(db, orgId),
    channelsWorking(env),
    loadSyncFacts(db, orgId),
    loadCronAnswer(db, "kontroll"),
    // Ett fel i hälsan stoppar inte resten av vakten.
    safely("Awish-hälsan", () => loadAwishWatchFacts(db, orgId), null),
  ]);
  return {
    timeZone: org.timezone,
    facts: {
      reach: { members, works },
      selfCheck: {
        lastScheduledAt: iso(org.check_at),
        organizationCreatedAt: createdAt,
        lastCall,
      },
      sync,
      alertRun: { lastRunAt: iso(org.alert_at), organizationCreatedAt: createdAt },
      awish,
    },
  };
}

function whenIn(timeZone: string, now: Date) {
  return (at: string) =>
    formatDateTime(wallClockIn(new Date(at), timeZone), { now: wallClockIn(now, timeZone) });
}

/** Raderna för organisationen just nu. */
export async function watchFor(
  db: Db,
  orgId: string,
  now: Date = new Date(),
  env: Env = process.env,
): Promise<WatchLine[]> {
  const loaded = await loadWatchFacts(db, orgId, env);
  if (!loaded) return [];
  return watchLines(loaded.facts, now, whenIn(loaded.timeZone, now));
}

/**
 * Raderna som den inloggade ser på Hem och Drift. Bara ägare och admin (det är de som kan
 * göra något åt det). Ett fel ger inga rader och skrivs i serverloggen.
 */
export async function loadWatchFor(viewer: Viewer, now: Date = new Date()): Promise<WatchLine[]> {
  const role = viewer.organization.role;
  if (role !== "owner" && role !== "admin") return [];
  return safely("vakten", () => watchFor(getServiceDb(), viewer.organization.id, now), []);
}

/** Datans ålder per kopplad automat (senast sedd i en hämtning från Awish). */
export async function loadMachineAges(
  db: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<MachineAge[]> {
  const rows = Array.from(
    await db.execute(
      sql`select m.id::text as id, coalesce(nullif(m.code, ''), m.name) as label,
                 max(sm.awish_seen_at) as seen_at
          from public.source_machines sm
          join public.data_sources ds
            on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
          join public.machines m
            on m.organization_id = sm.organization_id and m.id = sm.machine_id
          where sm.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
            and ds.archived_at is null and ds.status = 'active' and m.archived_at is null
          group by m.id, m.code, m.name
          order by coalesce(nullif(m.code, ''), m.name)`,
    ),
  ) as { id: string; label: string; seen_at: unknown }[];
  return machineAges(
    rows.map((r) => ({ machineId: r.id, label: r.label, seenAt: iso(r.seen_at) })),
    now,
  );
}

/** Raden om datans ålder på Hem, för alla som ser Hem. null utan Awish-automater. */
export async function loadMachineAgeFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<{ stale: boolean; text: string; ages: MachineAge[] } | null> {
  return safely(
    "datans ålder",
    async () => {
      const ages = await loadMachineAges(getServiceDb(), viewer.organization.id, now);
      const summary = machineAgeSummary(ages);
      return summary ? { ...summary, ages } : null;
    },
    null,
  );
}

const WATCH_RULE =
  "Vakten: larmar när ett schemalagt jobb inte har körts i tid, när hämtningen från Awish står still, när varken Open API eller webbpanelen fungerar på en väg, eller när ingen nås av larmen. Stängs när det fungerar igen.";

/** Nycklarna vakten kan larma med (utom per källa, som har källans id i nyckeln). */
const FIXED_KEYS = ["larm-nar-ingen", "kontroll", "larmjobb", ...AWISH_WATCH_KEYS] as const;

/** Beskedet när en Awish-väg fungerar igen (en push, se resolveWithRecovery). */
const RECOVERY_TITLE: Readonly<Record<string, string>> = {
  "awish:stock": "Lagret läses från Awish igen",
  "awish:machines": "Automaternas status kommer från Awish igen",
  "awish:push": "Alla påfyllningar har nått Awish",
};

function recoveryTitle(key: string): string | null {
  if (key.startsWith("synk:")) return "Försäljningen hämtas från Awish igen";
  return RECOVERY_TITLE[key] ?? null;
}

/**
 * Stänger larmet och skickar EN push om att det fungerar igen, till ägare och admin, om
 * larmet hade aviserats (samma regel som larmjobbet: inget "löst" om inget sades). Bara för
 * Awish-raderna; de andra stängs tyst som förut. Ger antalet stängda.
 */
async function resolveWithRecovery(db: Db, orgId: string, key: string, now: Date): Promise<number> {
  const title = recoveryTitle(key);
  if (!title) return resolveSystemAlert(db, orgId, `watch:${key}`, now);
  const closed = Array.from(
    await db.execute(
      sql`update public.alerts
          set status = 'closed', closed_at = ${now.toISOString()}::timestamptz
          where organization_id = ${orgId}::uuid and incident_key = ${`watch:${key}`}
            and alert_group = 'system' and status = 'open'
          returning id::text as id, notify_count, severity::text as severity`,
    ),
  ) as { id: string; notify_count: number; severity: "critical" | "warning" | "info" }[];
  for (const c of closed) {
    if (Number(c.notify_count) === 0) continue;
    await safely(
      "push om att Awish fungerar igen",
      () =>
        notifySystemAlert(
          db,
          c.id,
          {
            organizationId: orgId,
            kind: "job_failed",
            key: `watch:${key}`,
            // Samma allvar som larmet: den som fick larmet får också beskedet.
            severity: c.severity,
            title,
            detail: "Det fungerar igen. Binderlab har hämtat det som saknades.",
            rule: WATCH_RULE,
            link: "/datakallor#awish-halsa",
            now,
          },
          { reason: "resolved", roles: ["owner", "admin"] },
        ),
      0,
    );
  }
  if (key.startsWith("awish:")) await markAwishAlerted(db, orgId, key, null);
  return closed.length;
}

/** alerted_at på hälsoraderna för vägen (null när larmet har stängts). Kastar inte. */
async function markAwishAlerted(
  db: Db,
  orgId: string,
  key: string,
  at: Date | null,
): Promise<void> {
  const path = key.slice("awish:".length);
  await safely(
    "Awish-hälsans larmtid",
    async () => {
      await db.execute(
        sql`update public.awish_path_health
            set alerted_at = ${at ? at.toISOString() : null}::timestamptz
            where organization_id = ${orgId}::uuid and path = ${path}
              and alerted_at is distinct from ${at ? at.toISOString() : null}::timestamptz
              and (${at === null}::boolean or alerted_at is null)`,
      );
    },
    undefined,
  );
}

export interface WatchAlertOutcome {
  readonly raised: number;
  readonly resolved: number;
}

/**
 * Larmar för raderna som finns och stänger larmen för dem som är borta. `only` begränsar
 * till vissa rader (Awish-synken larmar inte om sig själv när den just har gått bra, men
 * den larmar om kontrollen och larmjobbet). Kastar inte.
 */
export async function syncWatchAlerts(
  db: Db,
  orgId: string,
  now: Date = new Date(),
  env: Env = process.env,
): Promise<WatchAlertOutcome> {
  return safely(
    "vaktens larm",
    async () => {
      const loaded = await loadWatchFacts(db, orgId, env);
      if (!loaded) return { raised: 0, resolved: 0 };
      const lines = watchLines(loaded.facts, now, whenIn(loaded.timeZone, now));
      const open = new Set(lines.map((l) => l.key));
      let raised = 0;
      let resolved = 0;
      for (const line of lines) {
        if (line.key.startsWith("awish:")) await markAwishAlerted(db, orgId, line.key, now);
        await raiseAndNotify(db, {
          organizationId: orgId,
          kind: "job_failed",
          key: `watch:${line.key}`,
          severity: line.level,
          title: line.title,
          detail: line.detail,
          rule: WATCH_RULE,
          link: line.href,
          now,
        });
        raised += 1;
      }
      const keys = [...FIXED_KEYS, ...loaded.facts.sync.map((s) => `synk:${s.id}`)];
      for (const key of keys) {
        if (open.has(key)) continue;
        resolved += await resolveWithRecovery(db, orgId, key, now);
      }
      return { raised, resolved };
    },
    { raised: 0, resolved: 0 },
  );
}

/** Vakten för alla organisationer som inte är arkiverade eller demos. Kastar inte. */
export async function syncWatchAlertsForAll(
  db: Db,
  now: Date = new Date(),
  env: Env = process.env,
): Promise<WatchAlertOutcome> {
  const orgs = await safely(
    "vaktens organisationer",
    async () =>
      Array.from(
        await db.execute(
          sql`select id::text as id from public.organizations
              where archived_at is null and is_demo = false order by created_at`,
        ),
      ) as { id: string }[],
    [],
  );
  let raised = 0;
  let resolved = 0;
  for (const o of orgs) {
    const r = await syncWatchAlerts(db, o.id, now, env);
    raised += r.raised;
    resolved += r.resolved;
  }
  return { raised, resolved };
}

// ---------------------------------------------------------------------------
// Hem och Drift: hur färsk datan från Awish är, och reservvägen
// ---------------------------------------------------------------------------

export interface AwishFreshness {
  /** "Försäljning 14:52 · Lager 14:50 (via webbpanelen)", null utan Awish-källa. */
  readonly text: string | null;
  /** Försäljningen har inte hämtats på 30 min (bannern på Hem), annars null. */
  readonly banner: string | null;
  /** Vägar där reservvägen fungerar just nu (ingen push, bara en rad). */
  readonly status: readonly AwishStatusLine[];
}

/** "14:52" i dag, annars datum och tid (organisationens tidszon). */
function clockIn(timeZone: string, now: Date) {
  return (at: string) => {
    const a = wallClockIn(new Date(at), timeZone);
    const n = wallClockIn(now, timeZone);
    return a.toDateString() === n.toDateString() ? formatTime(a) : formatDateTime(a, { now: n });
  };
}

/** Färskheten för organisationen (systemrollen; organisationen ur sessionen). */
export async function awishFreshnessFor(
  db: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<AwishFreshness> {
  const [org] = Array.from(
    await db.execute(
      sql`select o.timezone, o.is_demo,
                 -- Den automat som lästes längst sedan bestämmer: en automat som inte
                 -- läses får inte gömmas bakom de färska.
                 (select min(l.awish_synced_at) from public.stock_locations l
                   join public.machines m
                     on m.organization_id = l.organization_id and m.id = l.machine_id
                   where l.organization_id = o.id and l.machine_id is not null
                     and l.archived_at is null and m.archived_at is null
                     and exists (
                       select 1 from public.source_machines sm
                       join public.data_sources ds
                         on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
                       where sm.organization_id = o.id and sm.machine_id = l.machine_id
                         and ds.provider = 'awish_grpc' and ds.archived_at is null)) as stock_at
          from public.organizations o where o.id = ${orgId}::uuid`,
    ),
  ) as { timezone: string; is_demo: boolean | null; stock_at: unknown }[];
  if (!org) return { text: null, banner: null, status: [] };
  // En demo hämtar aldrig från Awish (avstängt): ingen varning om gammal data.
  if (org.is_demo === true) return { text: null, banner: null, status: [] };
  const [sync, awish] = await Promise.all([
    loadSyncFacts(db, orgId),
    loadAwishWatchFacts(db, orgId),
  ]);
  if (sync.length === 0) return { text: null, banner: null, status: [] };
  const clock = clockIn(org.timezone, now);
  // Den källa som släpar mest bestämmer (oftast finns bara en).
  const ordersAt = sync.reduce<string | null>(
    (oldest, s) =>
      s.lastSuccessAt === null
        ? oldest
        : oldest === null || s.lastSuccessAt < oldest
          ? s.lastSuccessAt
          : oldest,
    null,
  );
  const stockRows = awish.paths.filter((p) => p.path === "stock");
  const stockHealthAt = stockRows.reduce<string | null>(
    (best, p) => (p.lastSuccessAt && (!best || p.lastSuccessAt > best) ? p.lastSuccessAt : best),
    null,
  );
  const stockAt = iso(org.stock_at) ?? stockHealthAt;
  const stockVia = stockRows.some((p) => p.activeRoute === "webbpanelen")
    ? "webbpanelen"
    : (stockRows[0]?.activeRoute ?? null);
  const broken = sync.find((s) => syncBroken(s, now));
  return {
    text: awishFreshnessText({ ordersAt, stockAt, stockVia }, clock),
    banner: broken ? ordersBannerText(broken.lastSuccessAt, clock) : null,
    status: awishStatusLines(awish, clock),
  };
}

/**
 * Färskheten för den inloggade. Bannern och reservvägen bara för ägare och admin (de kan
 * göra något åt det). Ett fel ger null och skrivs i serverloggen.
 */
export async function loadAwishFreshnessFor(
  viewer: Viewer,
  now?: Date,
): Promise<AwishFreshness | null> {
  const role = viewer.organization.role;
  const operator = role === "owner" || role === "admin";
  // En gång per sidvisning (Hem läser den både för Live och bannern).
  if (now === undefined) return freshnessOnce(viewer.organization.id, operator);
  return loadFreshness(viewer.organization.id, operator, now);
}

function loadFreshness(
  orgId: string,
  operator: boolean,
  now: Date,
): Promise<AwishFreshness | null> {
  return safely(
    "Awish-färskheten",
    async () => {
      const f = await awishFreshnessFor(getServiceDb(), orgId, now);
      return operator ? f : { ...f, banner: null, status: [] };
    },
    null,
  );
}

const freshnessOnce = cache((orgId: string, operator: boolean) =>
  loadFreshness(orgId, operator, new Date()),
);
