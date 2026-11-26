"use server";

/**
 * Server actions för påfyllaren i butiken. Databasen avgör allt (staff_can_fill i
 * register_refill_once och undo_field_refills); här bara indata, Awish och svaret.
 */

import { redirect } from "next/navigation";
import { z } from "zod";

import { getServiceDb } from "@/db/client";
import { checkOwnPin, setOwnPin, skipPinChange } from "@/server/auth/phone-login";
import { validateNewPin } from "@/server/auth/phone";
import { summariseAwishPush } from "@/server/awish/push-status";
import { pushRefillToAwish } from "@/server/awish/control/refill-push";
import { recordAwishPushFailure } from "@/server/awish/web-service";
import { expireAppData } from "@/server/data/core";
import { saveRefillItems, undoRefillItems } from "@/server/data/field-refills";
import { requireStaff } from "@/server/staff/session";

const uuid = z.string().uuid();
const submitInput = z.object({
  orgId: uuid,
  machineId: uuid,
  items: z
    .array(
      z.object({
        clientId: uuid,
        titleId: uuid,
        quantity: z.number().int().min(1).max(500),
      }),
    )
    .min(1)
    .max(100),
});

export type StaffAwish = "pushed" | "pending" | "off";

export type StaffSubmitResult =
  | { ok: true; packs: number; clientIds: string[]; awish: StaffAwish; warnings: string[] }
  | { ok: false; error: string };

/** Skickar automatens antal till Awish (bara den här automaten). */
async function pushToAwish(orgId: string, machineId: string, actorId: string): Promise<StaffAwish> {
  try {
    const pushed = await pushRefillToAwish(orgId, [machineId], {
      withPending: false,
      actorId,
    });
    const summary = summariseAwishPush(pushed, [machineId]);
    return summary === undefined || summary.state === "off"
      ? "off"
      : summary.state === "sent"
        ? "pushed"
        : "pending";
  } catch {
    await recordAwishPushFailure(orgId, [machineId]).catch(() => {});
    return "pending";
  }
}

/** "Klart – jag har fyllt på": sparar varje rad och skickar automatens antal till Awish. */
export async function staffSubmitRefill(raw: unknown): Promise<StaffSubmitResult> {
  const staff = await requireStaff();
  const parsed = submitInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Lägg i minst ett pack först." };
  const { orgId, machineId, items } = parsed.data;
  if (!staff.machines.some((m) => m.organizationId === orgId && m.machineId === machineId)) {
    return { ok: false, error: "Du kan inte fylla på den här automaten." };
  }
  const occurredAt = new Date().toISOString();
  const result = await saveRefillItems(
    staff.user,
    orgId,
    items.map((it) => ({ ...it, machineId, fromWarehouse: true, occurredAt })),
  );
  const saved = result.results.filter((r) => r.status !== "rejected");
  const rejected = result.results.filter((r) => r.status === "rejected");
  if (saved.length === 0) {
    // Databasens text är skriven för appen: personalen får en enkel mening.
    return {
      ok: false,
      error: "Påfyllningen kunde inte sparas. Försök igen eller säg till ägaren.",
    };
  }
  // Ägarens Hem (sparat läge: flottan, rutten, lagret) räknas om vid nästa sida.
  expireAppData(orgId);
  const savedIds = new Set(saved.map((r) => r.clientId));
  const packs = items
    .filter((it) => savedIds.has(it.clientId))
    .reduce((n, it) => n + it.quantity, 0);

  const awish: StaffAwish =
    result.savedMachineIds.length > 0
      ? await pushToAwish(orgId, machineId, staff.user.userId)
      : "off";
  return {
    ok: true,
    packs,
    clientIds: [...savedIds],
    awish,
    warnings: rejected.map(() => "En rad kunde inte sparas."),
  };
}

/** Ångra (egna påfyllningar, 30 minuter). Sedan får Awish automatens antal igen. */
export async function staffUndo(
  raw: unknown,
): Promise<{ ok: true; packs: number } | { ok: false; error: string }> {
  const staff = await requireStaff();
  const parsed = z
    .object({ orgId: uuid, machineId: uuid, clientIds: z.array(uuid).min(1).max(100) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Inget att ångra." };
  const { orgId, machineId, clientIds } = parsed.data;
  if (!staff.machines.some((m) => m.organizationId === orgId && m.machineId === machineId)) {
    return { ok: false, error: "Inget att ångra." };
  }
  const result = await undoRefillItems(staff.user, orgId, clientIds);
  if (result.ok && result.packs > 0) {
    expireAppData(orgId);
    await pushToAwish(orgId, machineId, staff.user.userId);
  }
  return result;
}

export interface PinState {
  error?: string;
}

/**
 * Egen PIN-kod (två gånger). Utom direkt efter en PIN-kod från ägaren krävs den nuvarande
 * koden, så att den som lånar en inloggad telefon inte kan låsa ute personen.
 */
export async function staffSetPin(_prev: PinState, form: FormData): Promise<PinState> {
  const staff = await requireStaff();
  if (!staff.mustChangePin) {
    const current = String(form.get("current") ?? "").replace(/\s/g, "");
    if (
      !/^\d{6}$/.test(current) ||
      !(await checkOwnPin(getServiceDb, staff.user.userId, current))
    ) {
      return { error: "Fel nuvarande PIN-kod." };
    }
  }
  const pin = String(form.get("pin") ?? "");
  const again = String(form.get("again") ?? "");
  const problem = validateNewPin(pin);
  if (problem) return { error: problem };
  if (pin !== again) return { error: "PIN-koderna är inte lika. Skriv samma kod två gånger." };
  if (!(await setOwnPin(getServiceDb, staff.user.userId, pin))) {
    return { error: "Kunde inte spara. Försök igen." };
  }
  redirect("/pafyll");
}

/** Hoppa över: behåll PIN-koden från ägaren. */
export async function staffSkipPin(): Promise<void> {
  const staff = await requireStaff();
  await skipPinChange(getServiceDb, staff.user.userId);
  redirect("/pafyll");
}
