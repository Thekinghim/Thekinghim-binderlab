/**
 * Order som ägaren måste ta hand om för hand, från Awish-synken:
 *
 *   återbetald efter importen   Awish har markerat en order som redan är importerad som
 *                               återbetald. Ordern ändras aldrig av synken (försäljningen
 *                               ligger kvar i siffrorna och i butikens andel) tills
 *                               återbetalningen förs in på ett ärende i Inkorg.
 *   betald men oläslig          en betald order som inte går att tolka (betaltid saknas,
 *                               okänt beloppsformat). Den saknas i försäljningen.
 *
 * Förr blev båda en rad i importloggen, en gång, och sedan ingenting. Nu blir varje order
 * ett larm (public.alerts, typen order_attention) som syns i Att göra och på Drift och
 * står kvar tills den är hanterad:
 *
 *   order_refund:<källa>:<order>   stängs när ett ärende med återbetalning finns för ordern
 *   order_error:<källa>:<order>    stängs när ordern finns i försäljningen
 *
 * Larmet skapas ur det synken ser i varje körning (inte ur "loggat en gång"-listan), så ett
 * tillfälligt fel när larmet ska sparas tappar inget: nästa körning skapar det. Ett larm
 * som är hanterat skapas inte igen. Systemroll; kastar aldrig (synken ska inte stoppas).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { raiseAndNotify, safely } from "@/server/monitoring/failures";
import { clip } from "@/server/monitoring/system-alerts";

/** Det synken såg i en körning. */
export interface OrderAttention {
  /** Order som finns i försäljningen och som Awish nu säger är återbetalda (Awish order-id). */
  readonly refunded: readonly string[];
  /** Betalda order som inte gick att tolka. */
  readonly unreadable: readonly { readonly externalId: string | null; readonly message: string }[];
}

export const NO_ATTENTION: OrderAttention = { refunded: [], unreadable: [] };

interface SourceRef {
  readonly organization_id: string;
  readonly id: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,60}$/;

export function refundKey(sourceId: string, externalId: string): string {
  return `order_refund:${sourceId}:${externalId}`;
}

export function errorKey(sourceId: string, externalId: string | null): string {
  return `order_error:${sourceId}:${externalId && SAFE_ID.test(externalId) ? externalId : "okant"}`;
}

function kr(ore: number): string {
  const whole = Math.trunc(ore / 100);
  const rest = Math.abs(ore % 100);
  const text = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return rest === 0 ? `${text} kr` : `${text},${String(rest).padStart(2, "0")} kr`;
}

const REFUND_RULE =
  "Awish säger att en order som redan är importerad har återbetalats. Stängs när ett ärende med återbetalning finns för ordern.";
const ERROR_RULE =
  "Awish skickade en betald order som inte gick att läsa. Stängs när ordern finns i försäljningen.";

/** Skapar larmen för det synken såg (hanterade order hoppas över). Ger antalet som finns öppna. */
export async function raiseOrderAttention(
  db: Db,
  source: SourceRef,
  attention: OrderAttention,
  now: Date = new Date(),
): Promise<number> {
  if (attention.refunded.length === 0 && attention.unreadable.length === 0) return 0;
  return safely(
    "larm om order att hantera",
    async () => {
      let raised = 0;
      const org = source.organization_id;
      const refunded = [...new Set(attention.refunded)].filter((id) => SAFE_ID.test(id));
      if (refunded.length > 0) {
        const orders = Array.from(
          await db.execute(
            sql`select o.id::text as id, o.external_id, o.amount_ore,
                       coalesce(nullif(m.code, ''), m.name) as machine,
                       exists (select 1 from public.incidents i
                                where i.organization_id = o.organization_id
                                  and i.order_id = o.id and i.refunded_ore > 0) as handled
                from public.orders o
                left join public.machines m
                  on m.organization_id = o.organization_id and m.id = o.machine_id
                where o.organization_id = ${org}::uuid and o.data_source_id = ${source.id}::uuid
                  and o.external_id in (select jsonb_array_elements_text(${JSON.stringify(refunded)}::jsonb))`,
          ),
        ) as {
          id: string;
          external_id: string;
          amount_ore: number | string;
          machine: string | null;
          handled: boolean;
        }[];
        for (const o of orders) {
          if (o.handled) continue;
          const where = o.machine ? ` i ${o.machine}` : "";
          await raiseAndNotify(db, {
            organizationId: org,
            kind: "order_attention",
            key: refundKey(source.id, o.external_id),
            severity: "warning",
            title: clip(`Order ${o.external_id}${where} återbetalades i Awish`, 300),
            detail: `Försäljningen på ${kr(Number(o.amount_ore))} ligger kvar i siffrorna och i butikens andel. För in återbetalningen på ett ärende i Inkorg, så dras den av.`,
            rule: REFUND_RULE,
            link: `/inkorg/nytt?order=${encodeURIComponent(o.id)}`,
            now,
          });
          raised += 1;
        }
      }
      const seen = new Set<string>();
      for (const e of attention.unreadable) {
        const key = errorKey(source.id, e.externalId);
        if (seen.has(key)) continue;
        seen.add(key);
        const id = e.externalId && SAFE_ID.test(e.externalId) ? e.externalId : null;
        if (id) {
          // Finns ordern i försäljningen nu är den inläst: inget larm.
          const [found] = Array.from(
            await db.execute(
              sql`select 1 as x from public.orders o
                  where o.organization_id = ${org}::uuid and o.data_source_id = ${source.id}::uuid
                    and o.external_id = ${id} limit 1`,
            ),
          );
          if (found) continue;
        }
        await raiseAndNotify(db, {
          organizationId: org,
          kind: "order_attention",
          key,
          severity: "warning",
          title: id
            ? `Order ${id} från Awish kunde inte läsas`
            : "En betald order från Awish kunde inte läsas",
          detail: `Ordern är betald i Awish men finns inte i Binderlab, så den saknas i försäljningen och i butikens andel. Fel: ${clip(e.message, 300)} Kontrollera ordern i Awish.`,
          rule: ERROR_RULE,
          link: "/datakallor",
          now,
        });
        raised += 1;
      }
      return raised;
    },
    0,
  );
}

/**
 * Stänger larmen för order som är hanterade: återbetalningen finns på ett ärende, eller
 * ordern finns i försäljningen. `sourceId` utelämnat = alla källor i organisationen (när
 * ett ärende sparas i Inkorg). Ger antalet stängda.
 */
export async function resolveOrderAttention(
  db: Db,
  organizationId: string,
  options: { readonly sourceId?: string; readonly now?: Date } = {},
): Promise<number> {
  return safely(
    "stänga larm om order",
    async () => {
      const at = (options.now ?? new Date()).toISOString();
      const source = options.sourceId ?? null;
      const rows = Array.from(
        await db.execute(sql`
          update public.alerts a
          set status = 'closed', closed_at = ${at}::timestamptz
          where a.organization_id = ${organizationId}::uuid
            and a.status = 'open' and a.alert_group = 'system' and a.kind = 'order_attention'
            and (${source}::text is null or split_part(a.incident_key, ':', 2) = ${source}::text)
            and (
              (a.incident_key like 'order\\_refund:%' and exists (
                select 1 from public.orders o
                join public.incidents i
                  on i.organization_id = o.organization_id and i.order_id = o.id
                 and i.refunded_ore > 0
                where o.organization_id = a.organization_id
                  and o.data_source_id::text = split_part(a.incident_key, ':', 2)
                  and o.external_id = split_part(a.incident_key, ':', 3)))
              or
              (a.incident_key like 'order\\_error:%' and exists (
                select 1 from public.orders o
                where o.organization_id = a.organization_id
                  and o.data_source_id::text = split_part(a.incident_key, ':', 2)
                  and o.external_id = split_part(a.incident_key, ':', 3)))
            )
          returning a.id`),
      );
      return rows.length;
    },
    0,
  );
}
