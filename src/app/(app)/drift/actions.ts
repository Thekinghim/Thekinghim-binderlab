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
 * - undoRefills: Ångra efter Klar i Fyll på (egna, 30 minuter).
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { and, eq, isNull } from "drizzle-orm";
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
import { DEMO_MESSAGES, isDemoFor } from "@/server/demo/guard";
import { dispatchDelivery, type Channel, type ChannelResult } from "@/server/notify";
import { isAllowedPushEndpoint } from "@/server/notify/push-endpoint";
import { createRateLimiter } from "@/server/rate-limit";
import { resolveAppBaseUrl } from "@/server/request-info";
import {
  FIELD_REFILL_ROLES,
  syncRefillsFor,
  undoRefillsFor,
  type RefillSyncResult,
} from "@/server/data/field-refills";
import { pushMachinesToAwish } from "@/server/awish/web-service";
import { withUserDb } from "@/server/session";

import { currentViewer } from "../lager/_lib/session";

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
  endpoint: z.string().url().max(2000).refine(isAllowedPushEndpoint, "Okänd push-tjänst."),
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
  if (await isDemoFor({ userId: ctx.user.id, email: ctx.user.email }, ctx.organization.id)) {
    return { ok: false, results: [], error: DEMO_MESSAGES.email };
  }
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

export type { RefillSyncResult };

/**
 * Tar emot påfyllningar från kön i webbläsaren (Påfyllning och Fyll på). Varje påfyllning
 * sparas i en egen transaktion via register_refill_once: samma klient-id igen ger
 * "duplicate" och inget nytt. Ett avvisat inskick (t.ex. för lite i vårt lager) kommer
 * tillbaka med ett svenskt felmeddelande och stannar i kön tills användaren tar bort det.
 * Logiken finns i @/server/data/field-refills (testbar utan Next).
 */
export async function syncRefills(
  items: unknown,
): Promise<{ ok: boolean; results: RefillSyncResult[]; awish?: AwishPushStatus }> {
  await requireContextRole(FIELD_REFILL_ROLES);
  const viewer = await currentViewer();
  const result = await syncRefillsFor(viewer, items);
  let awish: AwishPushStatus | undefined;
  if (result.savedMachineIds.length > 0) {
    revalidatePath("/", "layout");
    // Skicka de påfyllda automaternas antal till Awish. Bäst-möjligt: påfyllningen är
    // redan sparad i Binderlab, så ett fel här får aldrig fälla hela inskicket.
    try {
      const pushed = await pushMachinesToAwish(viewer.organization.id, result.savedMachineIds);
      awish = summariseAwishPush(pushed);
    } catch {
      awish = { state: "error", message: "Kunde inte skicka till Awish just nu." };
    }
  }
  return { ok: result.ok, results: result.results, awish };
}

/** Kort status om Awish-push, för Fyll på. */
export interface AwishPushStatus {
  state: "off" | "sent" | "partial" | "error";
  message: string;
}

function summariseAwishPush(
  pushed: Awaited<ReturnType<typeof pushMachinesToAwish>>,
): AwishPushStatus | undefined {
  if (pushed.status === "off") {
    // Push avstängd eller ingen inloggning: inget att visa i appen.
    return undefined;
  }
  const errors = pushed.machines.filter((m) => m.status === "error");
  const noMachine = pushed.machines.filter((m) => m.status === "no_awish_machine");
  const slots = pushed.machines.reduce((n, m) => n + m.slotsUpdated, 0);
  if (errors.length > 0) {
    return {
      state: "partial",
      message: `Sparat i Binderlab. Till Awish gick det inte: ${errors[0]?.error ?? "okänt fel"}. Skriv antalet i Awish den här gången.`,
    };
  }
  if (noMachine.length > 0 && slots === 0) {
    return {
      state: "partial",
      message: "Sparat i Binderlab. Automaten är inte kopplad till Awish ännu.",
    };
  }
  if (slots === 0) {
    return { state: "sent", message: "Sparat. Awish hade redan rätt antal." };
  }
  return { state: "sent", message: `Sparat och skickat till Awish (${slots} fack).` };
}

/** Ångra efter Klar i Fyll på: motbokar egna påfyllningar (klient-id) från de senaste 30 minuterna. */
export async function undoRefills(
  clientIds: unknown,
): Promise<{ ok: true; packs: number } | { ok: false; error: string }> {
  await requireContextRole(FIELD_REFILL_ROLES);
  const result = await undoRefillsFor(await currentViewer(), clientIds);
  if (result.ok && result.packs > 0) revalidatePath("/", "layout");
  return result;
}
