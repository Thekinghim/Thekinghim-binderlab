/**
 * Veckosammanfattningen (/api/cron/vecka, pg_cron måndagar 05:07, 06:07 och 07:07 UTC): en notis
 * (push) till varje ägare och admin som har den på och har en telefon med notiser.
 *
 * - När: måndag från 07:00 i organisationens tidszon (weeklyDue). Andra dagar och tider
 *   gör jobbet ingenting.
 * - Vem: ägare och admin i en organisation som inte är arkiverad och inte en demo, med
 *   minst en påslagen push-enhet, och med veckosammanfattningen på: profiles.weekly_summary,
 *   eller (när den inte är vald) "Notiser i mobilen" på.
 * - Vad: sålda pack och vår vinst (före butikernas andel) förra veckan mot veckan innan,
 *   bästa produkten och antalet i Att göra, på personens språk. Notisen öppnar Veckan
 *   (hela appen) eller Försäljning (enkel vy). Den enkla vyn har ingen Att göra-lista, så
 *   delägarens notis och sammanfattning nämner den inte.
 * - En gång: raden i weekly_summaries läggs före utskicket (unique per person och vecka,
 *   on conflict do nothing). Två körningar samma vecka, också samtidiga, skickar en notis.
 *   Bara en vecka där ingen telefon fick notisen (status failed) provas igen, och en rad
 *   som blivit liggande som pending (körningen dog mellan raden och utskicket) efter
 *   PENDING_RETRY_MINUTES, så att nästa körning samma måndag skickar den.
 *
 * Siffrorna läses under RLS som mottagaren (./summary.ts); raden och push-enheternas
 * status skrivs som systemroll. Utan konfigurerad push skickas och sparas ingenting.
 */

import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  weekPeriods,
  weeklyDue,
  weeklyHref,
  weeklyPushText,
  type WeeklySummary,
} from "@/app/(app)/veckan/_lib/model";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import type { MemberRole } from "@/db/schema";
import type { IsoDate } from "@/domain";
import { formatters, isLocale, messages, type Locale } from "@/i18n";
import type { Viewer } from "@/server/data/core/loaders";
import { loadTodoCountFor } from "@/server/data/todos";
import { errorText } from "@/server/monitoring/system-alerts";
import { getPushSender, type PushPayload, type PushSender } from "@/server/notify/push";

import { loadWeeklySummaryFor } from "./summary";

export type WeeklyRecipientStatus = "sent" | "failed" | "already" | "off" | "error";

export interface WeeklyOrgOutcome {
  readonly organizationId: string;
  readonly status: "ran" | "skipped";
  readonly reason?: "not_monday" | "not_yet" | "push_off";
  readonly week?: IsoDate;
  readonly sent?: number;
  readonly failed?: number;
  readonly already?: number;
  readonly off?: number;
  readonly errors?: number;
  readonly error?: string;
}

export interface WeeklyRunResult {
  readonly ranAt: string;
  readonly organizations: WeeklyOrgOutcome[];
}

interface RecipientRow {
  readonly organization_id: string;
  readonly user_id: string;
  readonly email: string;
  readonly role: string;
  readonly view_mode: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly locale: string | null;
  readonly weekly_summary: boolean | null;
  readonly alert_push: boolean | null;
}

/** Siffrorna som sparas med raden (öre och antal, inga texter). */
export function weeklyFigures(summary: WeeklySummary): Record<string, unknown> {
  return {
    week: summary.week,
    last: { packs: summary.lastFigures.packs, profitOre: summary.lastFigures.profitOre },
    previous: {
      packs: summary.previousFigures.packs,
      profitOre: summary.previousFigures.profitOre,
    },
    best: summary.best
      ? {
          titleId: summary.best.titleId,
          name: summary.best.name,
          packs: summary.best.packs,
          profitOre: summary.best.profitOre,
        }
      : null,
    todos: summary.todos,
  };
}

/** Veckosammanfattningen är på: personens val, annars "Notiser i mobilen". */
export function weeklyEnabled(pref: boolean | null, alertPush: boolean | null): boolean {
  return pref ?? alertPush === true;
}

/** Så länge får en körning på sig att skicka innan en annan körning tar över raden. */
export const PENDING_RETRY_MINUTES = 10;

/** Raden får tas om: misslyckad, eller pending som ingen körning längre arbetar med. */
const RETRYABLE = sql`(${s.weeklySummaries.status} = 'failed'
  or (${s.weeklySummaries.status} = 'pending'
      and ${s.weeklySummaries.updatedAt} < now() - make_interval(mins => ${PENDING_RETRY_MINUTES})))`;

async function sendTo(
  db: Db,
  sender: PushSender,
  r: RecipientRow,
  week: IsoDate,
  now: Date,
): Promise<WeeklyRecipientStatus> {
  if (!weeklyEnabled(r.weekly_summary, r.alert_push)) return "off";
  const [existing] = await db
    .select({ retry: sql<boolean>`${RETRYABLE}` })
    .from(s.weeklySummaries)
    .where(
      and(
        eq(s.weeklySummaries.organizationId, r.organization_id),
        eq(s.weeklySummaries.userId, r.user_id),
        eq(s.weeklySummaries.weekStart, week),
      ),
    );
  if (existing && !existing.retry) return "already";

  const viewMode = r.view_mode === "simple" ? "simple" : "full";
  const viewer: Viewer = {
    user: { userId: r.user_id, email: r.email },
    organization: {
      id: r.organization_id,
      name: r.name,
      slug: r.slug,
      timezone: r.timezone,
      role: r.role as MemberRole,
      viewMode,
    },
  };
  // Att göra finns inte i den enkla vyn: delägarens notis nämner den inte.
  const summary = await loadWeeklySummaryFor(viewer, weekPeriods(week), now, {
    todos: viewMode === "simple" ? undefined : () => loadTodoCountFor(viewer, now),
  });
  const locale: Locale = isLocale(r.locale) ? r.locale : "sv";
  const text = weeklyPushText(summary, messages(locale), formatters(locale));
  const url = weeklyHref(week, viewMode);
  const values = {
    locale,
    title: text.title,
    body: text.body,
    url,
    figures: weeklyFigures(summary),
  };

  // Raden först: bara den körning som får raden skickar. En misslyckad vecka tas om.
  const [claimed] = await db
    .insert(s.weeklySummaries)
    .values({
      organizationId: r.organization_id,
      userId: r.user_id,
      weekStart: week,
      status: "pending",
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        s.weeklySummaries.organizationId,
        s.weeklySummaries.userId,
        s.weeklySummaries.weekStart,
      ],
      // updated_at stämplas av triggern: en samtidig körning ser raden som nyss tagen.
      set: { status: "pending", ...values },
      setWhere: RETRYABLE,
    })
    .returning({ id: s.weeklySummaries.id });
  if (!claimed) return "already";

  const devices = await db
    .select({
      id: s.pushSubscriptions.id,
      endpoint: s.pushSubscriptions.endpoint,
      p256dh: s.pushSubscriptions.p256dh,
      auth: s.pushSubscriptions.authSecret,
    })
    .from(s.pushSubscriptions)
    .where(
      and(
        eq(s.pushSubscriptions.organizationId, r.organization_id),
        eq(s.pushSubscriptions.userId, r.user_id),
        isNull(s.pushSubscriptions.disabledAt),
      ),
    );
  const payload: PushPayload = {
    title: text.title,
    body: text.body,
    url,
    tag: `vecka-${week}`,
    severity: "info",
    lang: locale,
  };
  const ok: string[] = [];
  const gone: string[] = [];
  for (const d of devices) {
    const out = await sender
      .send({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, payload)
      .catch(() => ({ ok: false as const, gone: false, detail: "fel" }));
    if (out.ok) ok.push(d.id);
    else if (out.gone) gone.push(d.id);
  }
  const status = ok.length > 0 ? "sent" : "failed";
  await db
    .update(s.weeklySummaries)
    .set({ status, devices: ok.length, sentAt: ok.length > 0 ? now : null })
    .where(eq(s.weeklySummaries.id, claimed.id));
  if (gone.length > 0) {
    await db
      .update(s.pushSubscriptions)
      .set({
        disabledAt: now,
        lastFailureAt: now,
        failureCount: sql`${s.pushSubscriptions.failureCount} + 1`,
      })
      .where(inArray(s.pushSubscriptions.id, gone));
  }
  if (ok.length > 0) {
    await db
      .update(s.pushSubscriptions)
      .set({ lastSuccessAt: now, failureCount: 0 })
      .where(inArray(s.pushSubscriptions.id, ok));
  }
  return status;
}

export async function runWeeklySummaries(
  db: Db,
  now: Date = new Date(),
  options: {
    /** Bara de här organisationerna (tester). */
    readonly only?: readonly string[];
    /** Push-adaptern (tester). Standard: miljöns; null = push är inte konfigurerad. */
    readonly sender?: PushSender | null;
  } = {},
): Promise<WeeklyRunResult> {
  const only = options.only ? [...options.only] : null;
  const rows = Array.from(
    await db.execute(
      sql`select m.organization_id::text as organization_id, m.user_id::text as user_id,
                 u.email::text as email, m.role::text as role, m.view_mode,
                 o.name, o.slug, o.timezone, p.locale, p.weekly_summary,
                 (a.active and 'push' = any(a.channels)) as alert_push
          from public.memberships m
          join public.organizations o on o.id = m.organization_id
          join auth.users u on u.id = m.user_id
          left join public.profiles p on p.organization_id = m.organization_id
            and p.user_id = m.user_id and p.anonymized_at is null
          left join public.alert_subscriptions a on a.organization_id = m.organization_id
            and a.user_id = m.user_id
          where m.role in ('owner', 'admin')
            and o.archived_at is null and not o.is_demo and u.email is not null
            and (${only === null} or o.id::text = any(string_to_array(${(only ?? []).join(",")}, ',')))
            and exists (
              select 1 from public.push_subscriptions d
              where d.organization_id = m.organization_id and d.user_id = m.user_id
                and d.disabled_at is null
            )
          order by o.created_at, m.created_at`,
    ),
  ) as unknown as RecipientRow[];

  const byOrg = new Map<string, RecipientRow[]>();
  for (const r of rows) {
    const list = byOrg.get(r.organization_id) ?? [];
    list.push(r);
    byOrg.set(r.organization_id, list);
  }

  let sender: PushSender | null | undefined = options.sender;
  const out: WeeklyOrgOutcome[] = [];
  for (const [organizationId, recipients] of byOrg) {
    // Ett fel i en organisation (t.ex. en tidszon som Node inte känner till) får inte stoppa
    // de andra: den räknas som ett fel och nästa organisation körs.
    let due: ReturnType<typeof weeklyDue>;
    try {
      due = weeklyDue(now, recipients[0]!.timezone);
    } catch (error) {
      console.error("[vecka] Kunde inte räkna ut veckan:", errorText(error));
      out.push({ organizationId, status: "ran", errors: 1, error: errorText(error) });
      continue;
    }
    if (!due.due) {
      out.push({ organizationId, status: "skipped", reason: due.reason });
      continue;
    }
    if (sender === undefined) sender = await getPushSender();
    if (!sender) {
      out.push({ organizationId, status: "skipped", reason: "push_off" });
      continue;
    }
    const count = { sent: 0, failed: 0, already: 0, off: 0, error: 0 };
    let firstError: string | undefined;
    for (const r of recipients) {
      try {
        count[await sendTo(db, sender, r, due.week, now)] += 1;
      } catch (error) {
        count.error += 1;
        firstError ??= errorText(error);
        console.error("[vecka] Kunde inte skicka veckosammanfattningen:", errorText(error));
      }
    }
    out.push({
      organizationId,
      status: "ran",
      week: due.week,
      sent: count.sent,
      failed: count.failed,
      already: count.already,
      off: count.off,
      errors: count.error,
      ...(firstError ? { error: firstError } : {}),
    });
  }
  return { ranAt: now.toISOString(), organizations: out };
}
