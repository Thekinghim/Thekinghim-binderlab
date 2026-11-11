/**
 * Prisråd på Lönsamhet: produkter som tjänar för lite, och organisationens mål.
 *
 * Samma räkning som punkten i Att göra (@/analytics/todos priceAdviceFor): priset i
 * automaten är det senaste köpet de senaste 30 dagarna, inköpspriset är dagens, och
 * marginalen är FÖRE butikernas andel. Hela organisationen, oavsett sidans period och
 * filter, så att sidan och Att göra alltid säger samma antal.
 *
 * Bara ett råd: priset ändras i automatens system. Här ändras bara målet
 * (organization_settings.target_margin_bp, ägare och admin). Ägare, admin och läsare läser.
 * Utan beroende på Next (användaren skickas in); ../actions.ts kopplar ihop med sessionen.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { priceAdviceFor } from "@/analytics/todos";
import {
  addDays,
  MAX_TARGET_MARGIN_BP,
  MIN_TARGET_MARGIN_BP,
  PRICE_ADVICE_WINDOW_DAYS,
  type PriceAdvice,
} from "@/domain";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { businessToday, loadMasterDataFor, type Viewer } from "@/server/data/core/loaders";
import {
  queryOrders,
  queryPrices,
  querySettings,
  queryTargetMarginBp,
} from "@/server/data/core/queries";
import { ECONOMY_ROLES } from "@/server/data/core/types";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

/** Ändrar målet: ägare och admin. */
export const TARGET_ROLES = ["owner", "admin"] as const;

export const ADVICE_MESSAGES = {
  forbidden: "Bara ägare och admin kan ändra målet.",
  invalid: "Ange ett mål mellan 1 och 90 procent.",
} as const;

export interface PriceAdviceRow extends PriceAdvice {
  readonly name: string;
}

export interface PriceAdviceView {
  /** Målet för marginalen före butikernas andel (bp). */
  readonly targetBp: number;
  /** Produkterna under målet, sämst marginal först. */
  readonly rows: readonly PriceAdviceRow[];
}

/** Prisråden för hela organisationen i dag. Ägare, admin och läsare. */
export async function loadPriceAdviceFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<PriceAdviceView> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const today = businessToday(now, viewer.organization.timezone);
  const range = { start: addDays(today, -(PRICE_ADVICE_WINDOW_DAYS - 1)), end: today };
  const [master, db] = await Promise.all([
    loadMasterDataFor(viewer, now),
    withUserDbFor(viewer.user, async (tx) => {
      const [orders, prices, settings, targetBp] = await Promise.all([
        queryOrders(tx, orgId, range, { storeId: null, machineId: null }),
        queryPrices(tx, orgId),
        querySettings(tx, orgId),
        queryTargetMarginBp(tx, orgId),
      ]);
      return { orders: orders.orders, prices, settings, targetBp };
    }),
  ]);
  const names = new Map(master.titles.map((t) => [t.id, t.name]));
  const rows = priceAdviceFor(
    { orders: db.orders, titles: master.titles, prices: db.prices, settings: db.settings },
    today,
    db.targetBp,
  ).map((r) => ({ ...r, name: names.get(r.titleId) ?? r.titleId }));
  return { targetBp: db.targetBp, rows };
}

const targetInput = z.object({
  targetMarginBp: z.number().int().min(MIN_TARGET_MARGIN_BP).max(MAX_TARGET_MARGIN_BP),
});

/** Sparar organisationens mål för marginalen (1–90 %). Ägare och admin. */
export async function setTargetMarginFor(
  viewer: Viewer,
  raw: { targetMarginBp: number },
): Promise<ActionResult<{ targetMarginBp: number }>> {
  const parsed = targetInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: ADVICE_MESSAGES.invalid };
  const { targetMarginBp } = parsed.data;
  const orgId = viewer.organization.id;
  try {
    await requireRoleFor(viewer.user, orgId, TARGET_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { ok: false, error: ADVICE_MESSAGES.forbidden };
    }
    throw error;
  }
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      // En rad per organisation; saknas den (äldre organisation) skapas den med målet.
      await tx.execute(
        sql`insert into public.organization_settings (organization_id, target_margin_bp)
            values (${orgId}::uuid, ${targetMarginBp})
            on conflict (organization_id) do update
              set target_margin_bp = excluded.target_margin_bp
              where public.organization_settings.target_margin_bp
                    is distinct from excluded.target_margin_bp`,
      );
      return { ok: true, data: { targetMarginBp } };
    });
  } catch (error) {
    if (pgErrorOf(error)?.code === "42501") return { ok: false, error: ADVICE_MESSAGES.forbidden };
    return { ok: false, error: dbErrorMessage(error) };
  }
}
