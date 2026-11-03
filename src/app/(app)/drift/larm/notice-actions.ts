"use server";

/**
 * Notiser i mobilen (managerpaket 8). Alla roller, var och en sina egna inställningar.
 *
 * - saveNotices: knappen "Notiser på/av" eller vilka typer.
 * - sendTestNotice: en provnotis till den inloggades telefoner (bara push).
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import type { AlertDelivery } from "@/analytics/alerts";
import * as s from "@/db/schema";
import { getServerEnv } from "@/lib/env";
import { saveNoticeChange } from "@/server/alerts/notice-service";
import type { NoticeState } from "@/server/alerts/notices";
import { ALL_ROLES, requireContextRole } from "@/server/data/core";
import { dispatchDelivery } from "@/server/notify";
import { createRateLimiter } from "@/server/rate-limit";
import { resolveAppBaseUrl } from "@/server/request-info";
import { withUserDb } from "@/server/session";

const changeInput = z.union([
  z.object({ on: z.boolean() }).strict(),
  z.object({ types: z.array(z.string().max(40)).max(10) }).strict(),
]);

export async function saveNotices(
  input: unknown,
): Promise<{ ok: true; state: NoticeState } | { ok: false; error: string }> {
  const ctx = await requireContextRole(ALL_ROLES);
  const parsed = changeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Det gick inte att spara. Försök igen." };
  try {
    const result = await withUserDb((tx) =>
      saveNoticeChange(
        tx,
        { orgId: ctx.organization.id, userId: ctx.user.id, role: ctx.role },
        parsed.data,
      ),
    );
    if (result.ok) revalidatePath("/drift/larm");
    return result;
  } catch (error) {
    console.error("[notiser] Kunde inte spara", error);
    return { ok: false, error: "Det gick inte att spara. Försök igen." };
  }
}

/** Högst 3 provnotiser per 10 minuter per person. */
const testLimiter = createRateLimiter({ limit: 3, windowMs: 10 * 60_000 });

export async function sendTestNotice(): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireContextRole(ALL_ROLES);
  const limit = testLimiter.consume([{ key: `user:${ctx.user.id}` }]);
  if (!limit.allowed) return { ok: false, error: "Vänta en stund och försök igen." };
  const devices = await withUserDb((tx) =>
    tx
      .select({
        id: s.pushSubscriptions.id,
        endpoint: s.pushSubscriptions.endpoint,
        p256dh: s.pushSubscriptions.p256dh,
        auth: s.pushSubscriptions.authSecret,
      })
      .from(s.pushSubscriptions)
      .where(
        and(
          eq(s.pushSubscriptions.organizationId, ctx.organization.id),
          eq(s.pushSubscriptions.userId, ctx.user.id),
          isNull(s.pushSubscriptions.disabledAt),
        ),
      ),
  );
  if (devices.length === 0) return { ok: false, error: "Slå på notiser i telefonen först." };
  const at = new Date().toISOString();
  const delivery: AlertDelivery = {
    userId: ctx.user.id,
    sendAt: at,
    deferred: false,
    subject: "Binderlab",
    items: [
      {
        incidentId: `prov@${at}`,
        key: "prov:notis",
        kind: "low_stock",
        severity: "info",
        reason: "new",
        machineId: null,
        titleId: null,
        title: "Binderlab",
        detail: "Notiserna fungerar.",
        at,
        evidence: {
          rule: "Provnotis.",
          period: null,
          orderIds: [],
          dates: [],
          titleIds: [],
          machineIds: [],
          storeIds: [],
          recipientIds: [],
          figures: [],
        },
        link: "/drift/larm",
      },
    ],
  };
  const h = await headers();
  const result = await dispatchDelivery(
    delivery,
    { userId: ctx.user.id, email: null, phone: null, channels: ["push"], pushDevices: devices },
    {
      baseUrl: resolveAppBaseUrl(getServerEnv(), h),
      timeZone: ctx.timeZone,
      organizationName: ctx.organization.name,
    },
  );
  if (result.goneDevices.length > 0) {
    await withUserDb((tx) =>
      tx
        .update(s.pushSubscriptions)
        .set({ disabledAt: new Date() })
        .where(
          and(
            eq(s.pushSubscriptions.organizationId, ctx.organization.id),
            eq(s.pushSubscriptions.userId, ctx.user.id),
            inArray(s.pushSubscriptions.id, result.goneDevices),
          ),
        ),
    ).catch(() => undefined);
  }
  return result.status === "sent" || result.status === "partial"
    ? { ok: true }
    : { ok: false, error: "Notisen kom inte fram. Slå av och på igen." };
}
