/**
 * Offlinelarmet direkt efter Awish-synken.
 *
 * Larmjobbet (/api/cron/larm) körs bara en gång om dagen på Vercel Hobby, men en automat
 * som är offline ska larma inom minuter. Därför utvärderar Awish-cronen (var femte minut)
 * larmen för de organisationer där anslutningen kräver det, och skickar utskicken som är på
 * tur. Samma larmjobb (evaluateOrganization): samma incidenter, samma prenumerationer och
 * tysta timmar, så inget larmar två gånger.
 *
 * En organisation utvärderas bara när
 *   - en kopplad automat är offline enligt regeln (sedd online förut, offline minst
 *     OFFLINE_ALERT_MINUTES, läget färskt, och inte bara medan strömmen är av enligt
 *     butikens strömtider plus marginalen efter på-tiden, se @/analytics/health/power), eller
 *   - ett offlinelarm är öppet för en automat med Awish-läge (så att det stängs när
 *     automaten är tillbaka).
 * Annars görs ingenting extra; en vanlig dag kostar det en fråga.
 *
 * "Slut i automat" går samma väg: när synken ser att ett fack just BLEV tomt (eller nådde
 * larmgränsen) utvärderas organisationen direkt (`stockOrgIds`). Bara ändringen räknas, så
 * ett fack som står tomt i en vecka kör inte larmjobbet var femte minut. Notisen följer de
 * tysta timmarna: bara "automaten står still" får väcka någon (WAKE_KINDS). En sådan körning
 * skickar inga påminnelser om andra larm (evaluateOrganization med reminders: false).
 */

import "server-only";

import { sql } from "drizzle-orm";

import {
  EMPTY_CONNECTIVITY,
  OFFLINE_ALERT_MINUTES,
  offlineSinceMs,
  STALE_MINUTES,
} from "@/analytics/health/connectivity";
import { powerHoursOf } from "@/analytics/health/power";
import type { Db } from "@/db/client";
import { deliverDue, type DeliverySummary } from "@/server/alerts/deliver";
import { evaluateOrganization, type EvaluationSummary } from "@/server/alerts/evaluate";

/** Organisationerna (av de givna) som behöver larmjobbet nu för anslutningens skull. */
export async function orgsNeedingOfflineEvaluation(
  db: Db,
  orgIds: readonly string[],
  now: Date,
): Promise<string[]> {
  const ids = [...new Set(orgIds.filter((id) => id !== ""))];
  if (ids.length === 0) return [];
  const idList = JSON.stringify(ids);
  // Automater som kan vara offline enligt regeln, med butikens strömtider (aktuell placering,
  // dagens datum i organisationens tidszon). Strömtiderna prövas nedan med samma regel som
  // maskinhälsan (offlineSinceMs): offline medan strömmen är av enligt tiderna väcker inte
  // larmjobbet var femte minut hela natten.
  const candidates = Array.from(
    await db.execute(
      sql`select sm.organization_id as org_id, sm.awish_online, sm.awish_seen_at,
                 sm.awish_online_at, sm.awish_offline_since, sm.awish_back_online_at,
                 p.power_on_time, p.power_off_time, o.timezone
          from public.source_machines sm
          join public.organizations o on o.id = sm.organization_id
          join public.data_sources ds
            on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
          left join lateral (
            select st.power_on_time, st.power_off_time
            from public.machine_placements mp
            join public.stores st
              on st.organization_id = mp.organization_id and st.id = mp.store_id
            where mp.organization_id = sm.organization_id and mp.machine_id = sm.machine_id
              and mp.valid_from <= (${now.toISOString()}::timestamptz at time zone o.timezone)::date
              and (mp.valid_to is null
                   or mp.valid_to >= (${now.toISOString()}::timestamptz at time zone o.timezone)::date)
            order by mp.valid_from desc
            limit 1
          ) p on true
          where sm.organization_id in (select jsonb_array_elements_text(${idList}::jsonb)::uuid)
            and o.archived_at is null
            and sm.machine_id is not null
            and ds.archived_at is null
            and sm.awish_online = false and sm.awish_online_at is not null
            and sm.awish_offline_since
                  <= ${now.toISOString()}::timestamptz - make_interval(mins => ${OFFLINE_ALERT_MINUTES})
            and sm.awish_seen_at
                  >= ${now.toISOString()}::timestamptz - make_interval(mins => ${STALE_MINUTES})`,
    ),
  ) as Record<string, unknown>[];
  const out = new Set<string>();
  for (const r of candidates) {
    const state = {
      ...EMPTY_CONNECTIVITY,
      online: false,
      seenAt: isoOf(r.awish_seen_at),
      onlineAt: isoOf(r.awish_online_at),
      offlineSince: isoOf(r.awish_offline_since),
      backOnlineAt: isoOf(r.awish_back_online_at),
      power: powerHoursOf(
        r.power_on_time as string | null,
        r.power_off_time as string | null,
        typeof r.timezone === "string" ? r.timezone : undefined,
      ),
    };
    if (offlineSinceMs(state, now) !== null) out.add(String(r.org_id));
  }
  // Ett öppet offlinelarm för en automat med Awish-läge: utvärdera, så att det stängs när
  // automaten är tillbaka (eller när strömmen är av enligt butikens tider).
  const open = Array.from(
    await db.execute(
      sql`select o.id from public.organizations o
          where o.id in (select jsonb_array_elements_text(${idList}::jsonb)::uuid)
            and o.archived_at is null
            and exists (
              select 1 from public.alerts a
              where a.organization_id = o.id and a.kind = 'machine_offline'
                and a.status = 'open' and a.machine_id is not null
                and exists (
                  select 1 from public.source_machines sm
                  where sm.organization_id = o.id and sm.machine_id = a.machine_id
                    and sm.awish_seen_at is not null
                )
            )`,
    ),
  ) as { id: string }[];
  for (const r of open) out.add(String(r.id));
  return ids.filter((id) => out.has(id));
}

function isoOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Organisationerna (av de givna) som finns och inte är arkiverade. */
async function activeOrgs(db: Db, orgIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(orgIds.filter((id) => id !== ""))];
  if (ids.length === 0) return [];
  const rows = Array.from(
    await db.execute(
      sql`select o.id from public.organizations o
          where o.id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
            and o.archived_at is null`,
    ),
  ) as { id: string }[];
  return rows.map((r) => r.id);
}

type Dispatcher = NonNullable<Parameters<typeof deliverDue>[1]["dispatch"]>;

export interface OfflineAlertRun {
  readonly organizations: EvaluationSummary[];
  readonly deliveries: DeliverySummary | null;
}

/**
 * Utvärderar larmen för organisationerna som behöver det och skickar det som är på tur
 * (alltid, även när ingen organisation behövde utvärderas).
 * Utan `baseUrl` köas utskicken (larmjobbet skickar dem senare). Kastar inte för en
 * organisation som misslyckas (evaluateOrganization loggar i alert_runs).
 */
export async function runOfflineAlerts(
  db: Db,
  orgIds: readonly string[],
  options: {
    now?: Date;
    baseUrl: string | null;
    dispatch?: Dispatcher;
    /**
     * Organisationer där ett fack just blev tomt i synken (AwishSyncResult.stockDropped):
     * de utvärderas också, så att "Slut i automat" kommer direkt och inte nästa morgon.
     */
    stockOrgIds?: readonly string[];
  },
): Promise<OfflineAlertRun> {
  const now = options.now ?? new Date();
  const offline = new Set(await orgsNeedingOfflineEvaluation(db, orgIds, now));
  const due = [...new Set([...offline, ...(await activeOrgs(db, options.stockOrgIds ?? []))])];
  const organizations: EvaluationSummary[] = [];
  for (const orgId of due) {
    // Bara ett fack som blev tomt: utan påminnelser. Annars påminns ägaren om varje annat
    // tomt fack varje gång något fack tar slut, och notisen "en automat, tryck för att fylla
    // på" blir "N automater behöver fyllas på". Påminnelserna kommer från det dagliga
    // larmjobbet (och, som förut, medan en automat är offline).
    organizations.push(
      await evaluateOrganization(db, orgId, now, offline.has(orgId) ? {} : { reminders: false }),
    );
  }
  // Utskicken som är på tur skickas i varje körning, även utan ny utvärdering: ett larm som
  // väntade över natten (tysta timmar) går ut när natten är slut, inte först när larmjobbet
  // körs nästa gång (en gång om dygnet). En vanlig körning kostar det en fråga.
  const deliveries =
    options.baseUrl === null
      ? null
      : await deliverDue(db, {
          now,
          baseUrl: options.baseUrl,
          ...(options.dispatch ? { dispatch: options.dispatch } : {}),
        });
  return { organizations, deliveries };
}
