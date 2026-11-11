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
 *     OFFLINE_ALERT_MINUTES, läget färskt), eller
 *   - ett offlinelarm är öppet för en automat med Awish-läge (så att det stängs när
 *     automaten är tillbaka).
 * Annars görs ingenting extra; en vanlig dag kostar det en fråga.
 *
 * "Slut i automat" går samma väg: när synken ser att ett fack just BLEV tomt (eller nådde
 * larmgränsen) utvärderas organisationen direkt (`stockOrgIds`). Bara ändringen räknas, så
 * ett fack som står tomt i en vecka kör inte larmjobbet var femte minut. Notisen följer de
 * tysta timmarna: bara "automaten står still" får väcka någon (WAKE_KINDS).
 */

import "server-only";

import { sql } from "drizzle-orm";

import { OFFLINE_ALERT_MINUTES, STALE_MINUTES } from "@/analytics/health/connectivity";
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
  const rows = Array.from(
    await db.execute(
      sql`select o.id from public.organizations o
          where o.id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
            and o.archived_at is null
            and (
              exists (
                select 1 from public.source_machines sm
                join public.data_sources ds
                  on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
                where sm.organization_id = o.id and sm.machine_id is not null
                  and ds.archived_at is null
                  and sm.awish_online = false and sm.awish_online_at is not null
                  and sm.awish_offline_since
                        <= ${now.toISOString()}::timestamptz - make_interval(mins => ${OFFLINE_ALERT_MINUTES})
                  and sm.awish_seen_at
                        >= ${now.toISOString()}::timestamptz - make_interval(mins => ${STALE_MINUTES})
              )
              or exists (
                select 1 from public.alerts a
                where a.organization_id = o.id and a.kind = 'machine_offline'
                  and a.status = 'open' and a.machine_id is not null
                  and exists (
                    select 1 from public.source_machines sm
                    where sm.organization_id = o.id and sm.machine_id = a.machine_id
                      and sm.awish_seen_at is not null
                  )
              )
            )`,
    ),
  ) as { id: string }[];
  return rows.map((r) => r.id);
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
  const due = [
    ...new Set([
      ...(await orgsNeedingOfflineEvaluation(db, orgIds, now)),
      ...(await activeOrgs(db, options.stockOrgIds ?? [])),
    ]),
  ];
  const organizations: EvaluationSummary[] = [];
  for (const orgId of due) {
    organizations.push(await evaluateOrganization(db, orgId, now));
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
