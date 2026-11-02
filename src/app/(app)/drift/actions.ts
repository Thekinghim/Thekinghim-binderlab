"use server";

/**
 * Server actions för Drift. Varje action kontrollerar rollen mot databasen
 * (requireContextRole) och skriver som användaren med RLS (withUserDb).
 *
 * - acknowledgeAlert: kvittera ett larm (ägare, admin). Inga fler påminnelser.
 * - saveAlertSubscription: egna larminställningar (alla roller; påfyllaren bara automater och lager).
 * - savePushDevice / removePushDevice: den här webbläsarens push-prenumeration.
 * - sendTestAlert: ett provlarm till sig själv i de valda kanalerna.
 * - syncRefills: påfyllningar som sparats offline, idempotent per klient-id.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { AlertDelivery } from "@/analytics/alerts";
import * as s from "@/db/schema";
import { getServerEnv } from "@/lib/env";
import {
  validateSubscription,
  type FieldErrors,
  type SubscriptionInput,
} from "@/server/alerts/subscriptions";
import { ALL_ROLES, OPERATOR_ROLES, requireContextRole } from "@/server/data/core";
import { dispatchDelivery, type Channel, type ChannelResult } from "@/server/notify";
import { isAllowedPushEndpoint } from "@/server/notify/push-endpoint";
import { createRateLimiter } from "@/server/rate-limit";
import { resolveAppBaseUrl } from "@/server/request-info";
import { withUserDb } from "@/server/session";

const uuid = z.string().uuid();

/**
 * Provlarm: högst 3 per 10 minuter per användare och 20 per organisation. Varje provlarm
 * skickar e-post (och sms när en leverantör kopplas på) på bolagets bekostnad.
 */
const testAlertLimiter = createRateLimiter({ limit: 3, windowMs: 10 * 60_000 });

function pgMessage(error: unknown): string | null {
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = e?.code ?? e?.cause?.code;
  const message = e?.cause?.message ?? e?.message;
  if (code === "22023" || code === "BL004" || code === "BL020") return message ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Larm
// ---------------------------------------------------------------------------

export async function acknowledgeAlert(alertId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireContextRole(OPERATOR_ROLES);
  if (!uuid.safeParse(alertId).success) return { ok: false, error: "Okänt larm." };
  const updated = await withUserDb((tx) =>
    tx
      .update(s.alerts)
      .set({ acknowledgedAt: new Date() })
      .where(
        and(
          eq(s.alerts.organizationId, ctx.organization.id),
          eq(s.alerts.id, alertId),
          isNull(s.alerts.acknowledgedAt),
        ),
      )
      .returning({ id: s.alerts.id }),
  );
  revalidatePath("/drift", "layout");
  return updated.length > 0
    ? { ok: true }
    : { ok: false, error: "Larmet är redan kvitterat eller finns inte." };
}

// ---------------------------------------------------------------------------
// Prenumeration
// ---------------------------------------------------------------------------

export interface SaveSubscriptionResult {
  readonly ok: boolean;
  readonly errors?: FieldErrors;
}

export async function saveAlertSubscription(
  input: SubscriptionInput,
): Promise<SaveSubscriptionResult> {
  const ctx = await requireContextRole(ALL_ROLES);
  const machineIds = await withUserDb(async (tx) =>
    (
      await tx
        .select({ id: s.machines.id })
        .from(s.machines)
        .where(
          and(eq(s.machines.organizationId, ctx.organization.id), isNull(s.machines.archivedAt)),
        )
    ).map((m) => m.id),
  );
  const result = validateSubscription(input, { userId: ctx.user.id, role: ctx.role, machineIds });
  if (!result.ok) return { ok: false, errors: result.errors };
  const r = result.row;
  const values = {
    kinds: r.kinds,
    machineIds: r.machineIds,
    minSeverity: r.minSeverity,
    channels: r.channels,
    phone: r.phone,
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    deliveryWindows: r.deliveryWindows,
    criticalDuringQuiet: r.criticalDuringQuiet,
    notifyResolved: r.notifyResolved,
    reminders: r.reminders,
    active: r.active,
  };
  try {
    await withUserDb((tx) =>
      tx
        .insert(s.alertSubscriptions)
        .values({ organizationId: ctx.organization.id, userId: ctx.user.id, ...values })
        .onConflictDoUpdate({
          target: [s.alertSubscriptions.organizationId, s.alertSubscriptions.userId],
          set: values,
        }),
    );
  } catch (error) {
    return {
      ok: false,
      errors: { form: pgMessage(error) ?? "Inställningarna kunde inte sparas." },
    };
  }
  revalidatePath("/drift/larm");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Push-enheter
// ---------------------------------------------------------------------------

const pushInput = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine(isAllowedPushEndpoint, "Okänd push-tjänst."),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
  userAgent: z.string().max(300).optional(),
});

export async function savePushDevice(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireContextRole(ALL_ROLES);
  const parsed = pushInput.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error:
        "Webbläsaren gav en push-prenumeration som Binderlab inte kan använda (okänd push-tjänst).",
    };
  const p = parsed.data;
  try {
    await withUserDb((tx) =>
      tx
        .insert(s.pushSubscriptions)
        .values({
          organizationId: ctx.organization.id,
          userId: ctx.user.id,
          endpoint: p.endpoint,
          p256dh: p.keys.p256dh,
          authSecret: p.keys.auth,
          userAgent: p.userAgent ?? null,
        })
        .onConflictDoUpdate({
          target: [s.pushSubscriptions.organizationId, s.pushSubscriptions.endpoint],
          set: {
            p256dh: p.keys.p256dh,
            authSecret: p.keys.auth,
            userAgent: p.userAgent ?? null,
            disabledAt: null,
          },
        }),
    );
  } catch {
    return {
      ok: false,
      error: "Enheten är redan kopplad till en annan användare. Logga ut den först.",
    };
  }
  revalidatePath("/drift/larm");
  return { ok: true };
}

export async function removePushDevice(id: string): Promise<{ ok: boolean }> {
  const ctx = await requireContextRole(ALL_ROLES);
  if (!uuid.safeParse(id).success) return { ok: false };
  await withUserDb((tx) =>
    tx
      .delete(s.pushSubscriptions)
      .where(
        and(
          eq(s.pushSubscriptions.organizationId, ctx.organization.id),
          eq(s.pushSubscriptions.id, id),
          eq(s.pushSubscriptions.userId, ctx.user.id),
        ),
      ),
  );
  revalidatePath("/drift/larm");
  return { ok: true };
}

/** Skickar ett provlarm till den inloggade i hennes kanaler. Inget sparas i larmloggen. */
export async function sendTestAlert(): Promise<{
  ok: boolean;
  results: ChannelResult[];
  error?: string;
}> {
  const ctx = await requireContextRole(ALL_ROLES);
  const limit = testAlertLimiter.consume([
    { key: `user:${ctx.user.id}` },
    { key: `org:${ctx.organization.id}`, limit: 20 },
  ]);
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil(limit.retryAfterMs / 60_000));
    return {
      ok: false,
      results: [],
      error: `Du har skickat flera provlarm i rad. Försök igen om ${minutes} min.`,
    };
  }
  const { channels, phone, devices } = await withUserDb(async (tx) => {
    const [sub] = await tx
      .select({ channels: s.alertSubscriptions.channels, phone: s.alertSubscriptions.phone })
      .from(s.alertSubscriptions)
      .where(
        and(
          eq(s.alertSubscriptions.organizationId, ctx.organization.id),
          eq(s.alertSubscriptions.userId, ctx.user.id),
        ),
      );
    const devices = await tx
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
      );
    return {
      channels: (sub?.channels ?? ["push", "email"]) as Channel[],
      phone: sub?.phone ?? null,
      devices,
    };
  });
  const at = new Date().toISOString();
  const delivery: AlertDelivery = {
    userId: ctx.user.id,
    sendAt: at,
    deferred: false,
    subject: "Provlarm från Binderlab",
    items: [
      {
        incidentId: `prov@${at}`,
        key: "prov:larm",
        kind: "machine_suspected_fault",
        severity: "info",
        reason: "new",
        machineId: null,
        titleId: null,
        title: "Provlarm från Binderlab",
        detail: "Så här ser ett larm ut i den här kanalen. Inget behöver göras.",
        at,
        evidence: {
          rule: "Provlarm som du skickade själv från Larminställningar.",
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
    { userId: ctx.user.id, email: ctx.user.email, phone, channels, pushDevices: devices },
    {
      baseUrl: resolveAppBaseUrl(getServerEnv(), h),
      timeZone: ctx.timeZone,
      organizationName: ctx.organization.name,
    },
  );
  return { ok: result.status === "sent" || result.status === "partial", results: result.results };
}

// ---------------------------------------------------------------------------
// Påfyllning från fältet
// ---------------------------------------------------------------------------

const refillItem = z.object({
  clientId: uuid,
  machineId: uuid,
  titleId: uuid,
  quantity: z.number().int().min(1).max(10000),
  fromWarehouse: z.boolean(),
  occurredAt: z.string().datetime({ offset: true }),
  note: z.string().max(500).optional(),
});

export interface RefillSyncResult {
  readonly clientId: string;
  readonly status: "saved" | "duplicate" | "rejected";
  readonly error?: string;
}

/**
 * Tar emot påfyllningar från kön i webbläsaren. Varje påfyllning sparas i en egen transaktion
 * via register_refill_once: samma klient-id igen ger "duplicate" och inget nytt. Ett avvisat
 * inskick (t.ex. för lite i centrallagret) kommer tillbaka med ett svenskt felmeddelande och
 * stannar i kön tills användaren tar bort det.
 */
export async function syncRefills(
  items: unknown,
): Promise<{ ok: boolean; results: RefillSyncResult[] }> {
  const ctx = await requireContextRole(["owner", "admin", "refiller"]);
  const list = z.array(z.unknown()).max(200).safeParse(items);
  if (!list.success) return { ok: false, results: [] };
  const results: RefillSyncResult[] = [];
  for (const raw of list.data) {
    const parsed = refillItem.safeParse(raw);
    const clientId =
      typeof raw === "object" && raw !== null && "clientId" in raw
        ? String((raw as { clientId: unknown }).clientId)
        : "";
    if (!parsed.success) {
      results.push({ clientId, status: "rejected", error: "Påfyllningen saknar uppgifter." });
      continue;
    }
    const it = parsed.data;
    try {
      const rows = await withUserDb((tx) =>
        tx.execute(sql`select stock_event_id, duplicate from public.register_refill_once(
          ${ctx.organization.id}::uuid, ${it.clientId}::uuid, ${it.machineId}::uuid, ${it.titleId}::uuid,
          ${it.quantity}::integer, ${it.fromWarehouse}::boolean, ${it.occurredAt}::timestamptz,
          ${it.note ?? null}::text)`),
      );
      const row = Array.from(rows)[0] as { duplicate?: boolean } | undefined;
      results.push({ clientId: it.clientId, status: row?.duplicate ? "duplicate" : "saved" });
    } catch (error) {
      results.push({
        clientId: it.clientId,
        status: "rejected",
        error: pgMessage(error) ?? "Påfyllningen kunde inte sparas. Försök igen.",
      });
    }
  }
  if (results.some((r) => r.status === "saved")) {
    revalidatePath("/", "layout");
  }
  return { ok: true, results };
}
