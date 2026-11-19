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

import {
  machineAges,
  machineAgeSummary,
  watchLines,
  type ChannelsWorking,
  type MachineAge,
  type ReachMember,
  type SyncSourceFacts,
  type WatchFacts,
  type WatchLine,
} from "@/analytics/watch";
import { wallClockIn } from "@/components/shell/period-state";
import { getServiceDb, type Db } from "@/db/client";
import { formatDateTime } from "@/lib/format";
import type { Viewer } from "@/server/data/core/loaders";
import { mailCanSend } from "@/server/mail/can-send";
import { pushStatus } from "@/server/notify/push";
import { smsStatus } from "@/server/notify/sms";

import { raiseAndNotify, safely } from "./failures";
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
  const [members, works, sync] = await Promise.all([
    loadReachMembers(db, orgId),
    channelsWorking(env),
    loadSyncFacts(db, orgId),
  ]);
  return {
    timeZone: org.timezone,
    facts: {
      reach: { members, works },
      selfCheck: { lastScheduledAt: iso(org.check_at), organizationCreatedAt: createdAt },
      sync,
      alertRun: { lastRunAt: iso(org.alert_at), organizationCreatedAt: createdAt },
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
  "Vakten: larmar när ett schemalagt jobb inte har körts i tid, när hämtningen från Awish står still eller när ingen nås av larmen. Stängs när det fungerar igen.";

/** Nycklarna vakten kan larma med (utom per källa, som har källans id i nyckeln). */
const FIXED_KEYS = ["larm-nar-ingen", "kontroll", "larmjobb"] as const;

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
        resolved += await resolveSystemAlert(db, orgId, `watch:${key}`, now);
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
