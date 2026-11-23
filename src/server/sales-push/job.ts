/**
 * Notis vid varje försäljning: körs av Awish-cronen (/api/cron/awish, var femte minut)
 * efter synken, när orderna redan är sparade (synkens transaktion är klar).
 *
 * - Vem: medlemmar med knappen på (profiles.sale_push_since) och minst en påslagen
 *   push-enhet, i organisationer som inte är arkiverade och inte en demo. Bara ägare, admin
 *   och läsare (ECONOMY_ROLES), samma roller som får läsa orderna (orders_select) och ser
 *   Senaste köp på Hem. Påfyllaren får ingen notis: hon ser bara summerade antal per titel
 *   och automat, aldrig enskilda köp med tid. Butiksportalens användare (role = store)
 *   aldrig. Rollen läses vid varje utskick, så en ändrad roll gäller direkt.
 * - Vilka order: från Awish-API:t (awish_grpc), inte testköp, köpta det senaste dygnet,
 *   sparade under den senaste timmen (SALE_PENDING_MINUTES) och efter att personen slog på
 *   knappen. Bara "levande" köp: köpta högst SALE_LIVE_MARGIN_MINUTES före källans förra
 *   import (historik som hämtas i senare körningar blir ingen hög), och i källans första
 *   import bara köp från de sista SALE_FIRST_IMPORT_MINUTES (den första hämtningen och
 *   historiken blir inga notiser, men en helt ny automats första köp blir det).
 * - Testköp: bara order som redan är markerade (orders.test_purchase_at) när jobbet kör.
 *   Testköp markeras för hand efteråt, så ett testköp vid automaten ger i praktiken en
 *   notis inom fem minuter. Awish egna test-, gratis- och obetalda order hämtas aldrig.
 * - En gång: raden i sale_notifications läggs före utskicket (unique per organisation och
 *   order, on conflict do nothing returning). Bara den körning som fick raderna skickar;
 *   två samtidiga körningar och omförsök skickar inget mer. Ett utskick som misslyckas
 *   provas inte igen (en försäljningsnotis är färskvara).
 * - Hur mycket: högst en notis per person och körning. Ett köp blir "Sålt: titel", flera en
 *   grupperad notis och fler än SALE_PUSH_CAP en sammanfattning (./message.ts). Högst
 *   SALE_CLAIM_LIMIT order per organisation och körning: en större hög (bara efter ett långt
 *   avbrott) blir två sammanfattningar i två körningar.
 * - Tid: jobbet har SALE_PUSH_BUDGET_MS. Ingen ny organisation tas om hand efter det (dess
 *   köp väntar till nästa körning), och mottagarna skickas till SALE_PUSH_PARALLEL åt gången.
 * - Tyst på natten (profiles.sale_push_quiet): 22–07 i organisationens tidszon skickas
 *   inget till personen; köpen räknas som omhändertagna och kommer inte senare.
 * - Enheter som push-tjänsten inte känner igen (404/410) stängs av, som för larmen.
 *
 * Kastar aldrig: ett fel loggas och räknas, och synken påverkas inte.
 */

import "server-only";

import { inArray, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import { canSeeEconomy, ECONOMY_ROLES } from "@/server/data/core/types";
import type { MemberRole } from "@/db/schema";
import { errorText } from "@/server/monitoring/system-alerts";
import { getPushSender, type PushPayload, type PushSender } from "@/server/notify/push";

import { inQuietHours, salePushPayload, type SaleItem } from "./message";

/** Äldre köp än så blir ingen notis (sen import, omimport). */
export const SALE_MAX_AGE_HOURS = 24;
/** Så länge sparas raderna i sale_notifications (jobbet tittar bara på det senaste dygnet). */
export const SALE_NOTIFIED_KEEP_DAYS = 7;
/** Högst så många order tas om hand per organisation och körning (resten nästa körning). */
export const SALE_CLAIM_LIMIT = 500;
/** Order som sparades för längre sedan än så blir ingen notis (t.ex. efter ett avbrott). */
export const SALE_PENDING_MINUTES = 60;
/** Köp mer än så före källans förra import är historik, inte nya köp. */
export const SALE_LIVE_MARGIN_MINUTES = 60;
/** I källans första import: bara köp från de sista minuterna före importen. */
export const SALE_FIRST_IMPORT_MINUTES = 15;
/** Jobbets tid i cronen (som har 60 s totalt; synken får 40 s). */
export const SALE_PUSH_BUDGET_MS = 12_000;
/** Så många mottagare skickas samtidigt. */
export const SALE_PUSH_PARALLEL = 4;

/**
 * Rollerna som får notisen: de som får läsa orderna (ECONOMY_ROLES). Inte påfyllaren och
 * aldrig butiksportalen.
 */
export const SALE_PUSH_ROLES = ECONOMY_ROLES;

export interface SalePushOrgOutcome {
  readonly organizationId: string;
  /** Nya köp som togs om hand i körningen. */
  readonly orders: number;
  readonly sent: number;
  readonly failed: number;
  readonly quiet: number;
  /** Mottagare som inte hann få notisen inom jobbets tid. */
  readonly late: number;
  readonly error?: string;
}

export interface SalePushRunResult {
  readonly ranAt: string;
  readonly skipped?: "push_off";
  readonly organizations: SalePushOrgOutcome[];
}

interface RecipientRow {
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly view_mode: string;
  readonly timezone: string;
  readonly since: Date | string;
  readonly quiet: boolean;
  readonly org_name: string;
  /** Personen är medlem i flera organisationer (då står organisationen i notisen). */
  readonly multi_org: boolean;
}

interface ClaimedRow {
  readonly order_id: string;
  readonly title: string;
  readonly machine_name: string | null;
  readonly store_name: string | null;
  readonly amount_ore: string | number;
  readonly ordered_at: Date | string;
  readonly created_at: Date | string;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

/** Lägger raderna för organisationens nya köp och ger dem som blev nya (bara de skickas). */
async function claimNewSales(db: Db, orgId: string, since: Date, now: Date): Promise<ClaimedRow[]> {
  return db.transaction(async (tx) => {
    const claimed = Array.from(
      await tx.execute(
        sql`with candidates as (
              select o.id
              from public.orders o
              join public.data_sources ds
                on ds.organization_id = o.organization_id and ds.id = o.data_source_id
              join public.imports i on i.organization_id = o.organization_id and i.id = o.import_id
              where o.organization_id = ${orgId}::uuid
                and ds.provider = 'awish_grpc'
                and o.test_purchase_at is null
                and o.ordered_at >= ${now.toISOString()}::timestamptz - make_interval(hours => ${SALE_MAX_AGE_HOURS})
                and o.created_at >= ${since.toISOString()}::timestamptz
                and o.created_at >= ${now.toISOString()}::timestamptz - make_interval(mins => ${SALE_PENDING_MINUTES})
                -- Bara levande köp: inte historik från en senare sida, inte källans första
                -- hämtning (utom de sista minuternas köp, t.ex. en ny automats första köp).
                and o.ordered_at >= coalesce(
                  (select max(p.created_at) from public.imports p
                   where p.organization_id = o.organization_id
                     and p.data_source_id = o.data_source_id
                     and p.status = 'succeeded'
                     and p.created_at < i.created_at)
                    - make_interval(mins => ${SALE_LIVE_MARGIN_MINUTES}),
                  i.created_at - make_interval(mins => ${SALE_FIRST_IMPORT_MINUTES})
                )
                and not exists (
                  select 1 from public.sale_notifications n
                  where n.organization_id = o.organization_id and n.order_id = o.id
                )
              order by o.ordered_at, o.id
              limit ${SALE_CLAIM_LIMIT}
            )
            insert into public.sale_notifications (organization_id, order_id)
            select ${orgId}::uuid, c.id from candidates c
            on conflict (organization_id, order_id) do nothing
            returning order_id::text as order_id`,
      ),
    ) as unknown as { order_id: string }[];
    if (claimed.length === 0) return [];
    return Array.from(
      await tx.execute(
        sql`select o.id::text as order_id,
                   coalesce(t.name, nullif(btrim(o.raw_title), ''), 'Okänd titel') as title,
                   m.name as machine_name,
                   st.name as store_name,
                   o.amount_ore, o.ordered_at, o.created_at
            from public.orders o
            left join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
            left join public.machines m
              on m.organization_id = o.organization_id and m.id = o.machine_id
            left join lateral (
              -- Butiken där automaten stod den dagen (annars dess första placering).
              select mp.store_id from public.machine_placements mp
              where mp.organization_id = o.organization_id and mp.machine_id = o.machine_id
              order by (mp.valid_from <= o.business_date
                        and (mp.valid_to is null or mp.valid_to >= o.business_date)) desc,
                       mp.valid_from asc
              limit 1
            ) pl on true
            left join public.stores st on st.organization_id = o.organization_id and st.id = pl.store_id
            where o.organization_id = ${orgId}::uuid
              and o.id = any (${`{${claimed.map((c) => c.order_id).join(",")}}`}::uuid[])
            order by o.ordered_at, o.id`,
      ),
    ) as unknown as ClaimedRow[];
  });
}

/** Kör `fn` för varje sak, högst `limit` åt gången. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function sendToRecipient(
  db: Db,
  sender: PushSender,
  r: RecipientRow,
  sales: readonly ClaimedRow[],
  options: { now: Date },
): Promise<"sent" | "failed" | "quiet" | "none"> {
  const since = new Date(iso(r.since)).getTime();
  // Bara köp som sparades efter att personen slog på knappen.
  const mine = sales.filter((o) => new Date(iso(o.created_at)).getTime() >= since);
  if (mine.length === 0) return "none";
  if (r.quiet && inQuietHours(options.now, r.timezone)) return "quiet";

  const items: SaleItem[] = mine.map((o) => ({
    orderId: o.order_id,
    title: o.title,
    machineName: o.machine_name,
    storeName: o.store_name,
    amountOre: Number(o.amount_ore),
    orderedAt: iso(o.ordered_at),
  }));
  const payload: PushPayload = salePushPayload(items, {
    // Rollen avgör beloppen vid utskicket, aldrig valet (alla mottagare är ekonomiroller i dag).
    kronor: canSeeEconomy(r.role as MemberRole),
    timeZone: r.timezone,
    orgId: r.organization_id,
    orgName: r.multi_org ? r.org_name : null,
    simple: r.view_mode === "simple",
    now: options.now,
  });

  const devices = Array.from(
    await db.execute(
      sql`select id::text as id, endpoint, p256dh, auth_secret as auth
          from public.push_subscriptions
          where organization_id = ${r.organization_id}::uuid and user_id = ${r.user_id}::uuid
            and disabled_at is null`,
    ),
  ) as unknown as { id: string; endpoint: string; p256dh: string; auth: string }[];
  // Enheterna samtidigt: en långsam push-tjänst håller inte upp de andra.
  const outcomes = await Promise.all(
    devices.map((d) =>
      sender
        .send({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, payload)
        .catch(() => ({ ok: false as const, gone: false, detail: "fel" })),
    ),
  );
  const ok = devices.filter((_d, i) => outcomes[i]!.ok).map((d) => d.id);
  const gone = devices
    .filter((_d, i) => {
      const out = outcomes[i]!;
      return !out.ok && out.gone;
    })
    .map((d) => d.id);
  if (gone.length > 0) {
    await db
      .update(s.pushSubscriptions)
      .set({
        disabledAt: options.now,
        lastFailureAt: options.now,
        failureCount: sql`${s.pushSubscriptions.failureCount} + 1`,
      })
      .where(inArray(s.pushSubscriptions.id, gone));
  }
  if (ok.length > 0) {
    await db
      .update(s.pushSubscriptions)
      .set({ lastSuccessAt: options.now, failureCount: 0 })
      .where(inArray(s.pushSubscriptions.id, ok));
  }
  return ok.length > 0 ? "sent" : "failed";
}

export async function runSaleNotifications(
  db: Db,
  options: {
    readonly now?: Date;
    /** Tidsgränsen (ms sedan epoken). Standard: nu + SALE_PUSH_BUDGET_MS. */
    readonly deadline?: number;
    /** Bara de här organisationerna (tester). */
    readonly only?: readonly string[];
    /** Push-adaptern (tester). Standard: miljöns; null = push är inte konfigurerad. */
    readonly sender?: PushSender | null;
  } = {},
): Promise<SalePushRunResult> {
  const now = options.now ?? new Date();
  const deadline = options.deadline ?? Date.now() + SALE_PUSH_BUDGET_MS;
  const late = () => Date.now() >= deadline;
  const out: SalePushOrgOutcome[] = [];
  try {
    const sender = options.sender === undefined ? await getPushSender() : options.sender;
    if (!sender) return { ranAt: now.toISOString(), skipped: "push_off", organizations: [] };

    const only = options.only ? [...options.only] : null;
    const recipients = Array.from(
      await db.execute(
        sql`select m.organization_id::text as organization_id, m.user_id::text as user_id,
                   m.role::text as role, m.view_mode, o.timezone,
                   p.sale_push_since as since, p.sale_push_quiet as quiet,
                   o.name as org_name,
                   (select count(*) from public.memberships m2 where m2.user_id = m.user_id) > 1
                     as multi_org
            from public.memberships m
            join public.organizations o on o.id = m.organization_id
            join public.profiles p on p.organization_id = m.organization_id
              and p.user_id = m.user_id and p.anonymized_at is null
            where p.sale_push_since is not null
              and m.role::text = any (${`{${SALE_PUSH_ROLES.join(",")}}`}::text[])
              and o.archived_at is null and not o.is_demo
              and (${only === null} or o.id::text = any (${`{${(only ?? []).join(",")}}`}::text[]))
              and exists (
                select 1 from public.push_subscriptions d
                where d.organization_id = m.organization_id and d.user_id = m.user_id
                  and d.disabled_at is null
              )
            order by o.created_at, m.created_at`,
      ),
    ) as unknown as RecipientRow[];

    const byOrg = new Map<string, RecipientRow[]>();
    for (const r of recipients) {
      const list = byOrg.get(r.organization_id) ?? [];
      list.push(r);
      byOrg.set(r.organization_id, list);
    }

    for (const [organizationId, list] of byOrg) {
      // Slut på tid: organisationens köp tas inte om hand nu utan väntar till nästa körning.
      if (late()) {
        console.error("[försäljning] Tiden tog slut; resten nästa körning.");
        break;
      }
      const count = { sent: 0, failed: 0, quiet: 0, late: 0 };
      let orders = 0;
      let firstError: string | undefined;
      try {
        // Från den som slog på knappen först (de andra filtreras per person).
        const since = new Date(Math.min(...list.map((r) => new Date(iso(r.since)).getTime())));
        const sales = await claimNewSales(db, organizationId, since, now);
        orders = sales.length;
        await eachLimited(sales.length > 0 ? list : [], SALE_PUSH_PARALLEL, async (r) => {
          if (late()) {
            count.late += 1;
            return;
          }
          try {
            const status = await sendToRecipient(db, sender, r, sales, { now });
            if (status !== "none") count[status] += 1;
          } catch (error) {
            count.failed += 1;
            firstError ??= errorText(error);
            console.error("[försäljning] Notisen kunde inte skickas:", errorText(error));
          }
        });
      } catch (error) {
        firstError ??= errorText(error);
        console.error("[försäljning] Nya köp kunde inte läsas:", errorText(error));
      }
      out.push({
        organizationId,
        orders,
        ...count,
        ...(firstError ? { error: firstError } : {}),
      });
    }

    // Gamla rader behövs inte: jobbet tittar bara på det senaste dygnet.
    await db
      .execute(
        sql`delete from public.sale_notifications
            where created_at < ${now.toISOString()}::timestamptz - make_interval(days => ${SALE_NOTIFIED_KEEP_DAYS})`,
      )
      .catch((error: unknown) => {
        console.error("[försäljning] Gamla rader kunde inte tas bort:", errorText(error));
      });
  } catch (error) {
    console.error("[försäljning] Notisjobbet misslyckades:", errorText(error));
  }
  return { ranAt: now.toISOString(), organizations: out };
}
