/**
 * Påminnelse om obetalda belopp från utbetalningarna från Nayax (det dagliga jobbet).
 *
 * Har en rad (butik, bolag, partner eller moms) något kvar att betala mer än
 * organization_settings.payout_reminder_days dagar efter att pengarna kom, öppnas ett larm
 * (public.alerts, typen payout_unpaid, nyckeln "payout_unpaid:<org>"): det syns i Att göra
 * och skickas som push/e-post till dem som valt notiser (samma inställningar som andra
 * larm). Samma öppna larm räknas upp, inte ett nytt varje dag; det stängs när allt är
 * betalt. 0 dagar = av.
 *
 * Texten säger bara hur många belopp det gäller, inte summan: larmen syns också för
 * läsaren, som inte ska se partnerns andel.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { addDays } from "@/domain";
import { businessToday } from "@/server/data/core/loaders";
import { raiseAndNotify } from "@/server/monitoring/failures";
import { resolveSystemAlert } from "@/server/monitoring/system-alerts";

import { loadPayOverviewTx } from "./balances";

export function reminderKey(orgId: string): string {
  return `payout_unpaid:${orgId}`;
}

/** Påminnelsen för en organisation. Ger antalet obetalda belopp som är för gamla. */
export async function remindUnpaidTx(
  db: Db,
  org: { readonly id: string; readonly timezone: string },
  now: Date,
): Promise<number> {
  const [settings] = Array.from(
    await db.execute(sql`
      select payout_reminder_days as days from public.organization_settings
      where organization_id = ${org.id}::uuid`),
  ) as { days: number }[];
  const days = settings?.days ?? 7;
  if (days <= 0) {
    await resolveSystemAlert(db, org.id, reminderKey(org.id), now);
    return 0;
  }
  const today = businessToday(now, org.timezone);
  const cutoff = addDays(today, -days);
  const overview = await db.transaction((tx) => loadPayOverviewTx(tx, org.id));
  const late = overview.payouts.flatMap((p) =>
    p.paidOn !== null && p.paidOn <= cutoff
      ? p.lines.filter((l) => l.kind !== "owner" && l.leftOre > 0)
      : [],
  );
  if (late.length === 0) {
    await resolveSystemAlert(db, org.id, reminderKey(org.id), now);
    return 0;
  }
  await raiseAndNotify(db, {
    organizationId: org.id,
    kind: "payout_unpaid",
    key: reminderKey(org.id),
    severity: "warning",
    title:
      late.length === 1
        ? "Du har 1 obetalt belopp från Nayax"
        : `Du har ${late.length} obetalda belopp från Nayax`,
    detail: `Pengarna kom för mer än ${days} dagar sedan. Öppna Utbetalningar och markera det du betalat.`,
    rule: `Ett belopp från en utbetalning är inte markerat som betalt ${days} dagar efter att pengarna kom.`,
    link: "/pengar/utbetalningar",
    figures: [{ key: "unpaid", label: "Obetalda belopp", value: late.length }],
    now,
  });
  return late.length;
}

/** Alla organisationer med utbetalningar. */
export async function remindUnpaidForAll(db: Db, now: Date = new Date()): Promise<number> {
  const orgs = Array.from(
    await db.execute(sql`
      select distinct o.id, o.timezone from public.organizations o
      join public.payout_allocations a on a.organization_id = o.id and a.superseded_at is null
      where o.archived_at is null and not o.is_demo`),
  ) as { id: string; timezone: string }[];
  let total = 0;
  for (const org of orgs) {
    try {
      total += await remindUnpaidTx(db, org, now);
    } catch (error) {
      console.error(
        "[utbetalningar] påminnelse",
        org.id,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return total;
}
