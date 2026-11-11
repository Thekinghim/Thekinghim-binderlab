/**
 * Butikens felanmälan plingar i telefonen direkt (runda 2, T4-2).
 *
 * Felanmälan från portalen hamnar i incidents och syns i Inkorgen, men förut fick ingen veta
 * det förrän någon öppnade appen. Nu skickas en push i samma anrop till ägare, admin och
 * automatens ansvariga. Trycket öppnar ärendet i Inkorgen, där butikens nummer ringer.
 *
 * Kör som systemroll (butiksanvändaren får inte läsa andras enheter): organisation, automat
 * och mottagare kommer ur ärendet i databasen, aldrig ur anropet. Kastar aldrig: en notis som
 * inte går fram får inte stoppa felanmälan.
 *
 * Vem får notisen:
 *   - ägare och admin, och automatens ansvariga (machines.responsible_user_id),
 *   - inte butiksanvändare och inte den som har Enkel vy (Inkorgen finns inte där),
 *   - inte den som har stängt av Notiser (prenumerationen av, eller utan push),
 *   - inget skickas från en demo.
 * Tysta timmar gäller inte: en butik som ringer in ett fel har öppet nu.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { faultPush } from "@/server/notify/content";
import { getPushSender, type PushSender } from "@/server/notify/push";

import { FAULT_LABEL, isFaultKind } from "./faults";

export interface FaultPushResult {
  /** Personer som notisen gick fram till (minst en enhet). */
  readonly sent: number;
  /** Personer som skulle ha fått den men där ingen enhet tog emot. */
  readonly failed: number;
  readonly skipped: "not_found" | "not_store_fault" | "demo" | "push_off" | "no_devices" | null;
}

type Row = Record<string, unknown>;
const list = async <T extends Row>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> =>
  Array.from(await db.execute(q)) as T[];

/** Skickar notisen om ett nyss gjort ärende från portalen. */
export async function notifyFaultReported(
  db: Db,
  incidentId: string,
  deps: { sender?: PushSender | null; now?: Date } = {},
): Promise<FaultPushResult> {
  const none = (skipped: FaultPushResult["skipped"]): FaultPushResult => ({
    sent: 0,
    failed: 0,
    skipped,
  });
  try {
    const [incident] = await list<{
      organization_id: string;
      machine_id: string;
      kind: string;
      is_demo: boolean;
      machine: string;
      responsible: string | null;
      store: string | null;
      phone: string | null;
    }>(
      db,
      sql`select i.organization_id::text as organization_id, i.machine_id::text as machine_id,
                 i.kind, o.is_demo,
                 case when m.name like m.code || '%' then m.name else m.code || ' ' || m.name end
                   as machine,
                 m.responsible_user_id::text as responsible, st.name as store, st.phone
          from public.incidents i
          join public.organizations o on o.id = i.organization_id
          join public.machines m on m.organization_id = i.organization_id and m.id = i.machine_id
          left join lateral (
            select s.name, s.phone
            from public.machine_placements p
            join public.stores s on s.organization_id = p.organization_id and s.id = p.store_id
            where p.organization_id = i.organization_id and p.machine_id = i.machine_id
              and p.valid_from <= (i.started_at at time zone o.timezone)::date
              and (p.valid_to is null or p.valid_to >= (i.started_at at time zone o.timezone)::date)
            order by p.valid_from desc limit 1
          ) st on true
          where i.id = ${incidentId}::uuid`,
    );
    if (!incident) return none("not_found");
    if (!isFaultKind(incident.kind)) return none("not_store_fault");
    if (incident.is_demo) return none("demo");

    const devices = await list<{
      id: string;
      user_id: string;
      role: string;
      endpoint: string;
      p256dh: string;
      auth_secret: string;
    }>(
      db,
      sql`select d.id::text as id, d.user_id::text as user_id, m.role::text as role,
                 d.endpoint, d.p256dh, d.auth_secret
          from public.memberships m
          join public.push_subscriptions d
            on d.organization_id = m.organization_id and d.user_id = m.user_id
           and d.disabled_at is null
          where m.organization_id = ${incident.organization_id}::uuid
            and m.role <> 'store' and m.view_mode <> 'simple'
            and (m.role in ('owner', 'admin') or m.user_id = ${incident.responsible}::uuid)
            and not exists (
              select 1 from public.alert_subscriptions a
              where a.organization_id = m.organization_id and a.user_id = m.user_id
                and (a.active = false or not ('push' = any (a.channels)))
            )
          order by d.user_id, d.created_at`,
    );
    if (devices.length === 0) return none("no_devices");
    const sender = deps.sender === undefined ? await getPushSender() : deps.sender;
    if (!sender) return none("push_off");

    const now = deps.now ?? new Date();
    const delivered = new Set<string>();
    const users = new Set<string>();
    const gone: string[] = [];
    const ok: string[] = [];
    for (const d of devices) users.add(d.user_id);
    // Alla enheter samtidigt: butiken väntar på svaret, och en trög enhet ska inte lägga sin
    // väntetid ovanpå de andras.
    const outcomes = await Promise.all(
      devices.map(async (d) => {
        const payload = faultPush({
          incidentId,
          machineId: incident.machine_id,
          place: incident.store ?? incident.machine,
          fault: FAULT_LABEL[incident.kind as keyof typeof FAULT_LABEL],
          phone: incident.phone,
          canOpenCase: d.role === "owner" || d.role === "admin",
        });
        try {
          return await sender.send(
            { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth_secret },
            payload,
          );
        } catch {
          return { ok: false as const, gone: false, detail: "fel" };
        }
      }),
    );
    devices.forEach((d, i) => {
      const out = outcomes[i];
      if (out?.ok) {
        delivered.add(d.user_id);
        ok.push(d.id);
      } else if (out?.gone) gone.push(d.id);
    });
    const ids = (v: readonly string[]) =>
      sql`(select jsonb_array_elements_text(${JSON.stringify(v)}::jsonb)::uuid)`;
    if (gone.length > 0) {
      await db.execute(
        sql`update public.push_subscriptions
            set disabled_at = ${now.toISOString()}::timestamptz,
                last_failure_at = ${now.toISOString()}::timestamptz,
                failure_count = failure_count + 1
            where id in ${ids(gone)}`,
      );
    }
    if (ok.length > 0) {
      await db.execute(
        sql`update public.push_subscriptions
            set last_success_at = ${now.toISOString()}::timestamptz, failure_count = 0
            where id in ${ids(ok)}`,
      );
    }
    return { sent: delivered.size, failed: users.size - delivered.size, skipped: null };
  } catch (error) {
    console.error(
      "[portal] notisen om felanmälan kunde inte skickas",
      error instanceof Error ? error.message : "fel",
    );
    return { sent: 0, failed: 0, skipped: null };
  }
}
