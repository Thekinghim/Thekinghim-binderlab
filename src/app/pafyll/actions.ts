"use server";

/**
 * Server actions för påfyllaren i butiken. Databasen avgör allt (staff_can_fill i
 * register_refill_once och undo_field_refills); här bara indata, Awish och svaret.
 */

import { redirect } from "next/navigation";
import { z } from "zod";

import { getServiceDb } from "@/db/client";
import { setOwnPin, skipPinChange } from "@/server/auth/phone-login";
import { validateNewPin } from "@/server/auth/phone";
import { summariseAwishPush } from "@/server/awish/push-status";
import { pushMachinesToAwish, recordAwishPushFailure } from "@/server/awish/web-service";
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
    return {
      ok: false,
      error: rejected[0]?.error ?? "Påfyllningen kunde inte sparas. Försök igen.",
    };
  }
  const savedIds = new Set(saved.map((r) => r.clientId));
  const packs = items
    .filter((it) => savedIds.has(it.clientId))
    .reduce((n, it) => n + it.quantity, 0);

  let awish: StaffAwish = "off";
  if (result.savedMachineIds.length > 0) {
    try {
      const pushed = await pushMachinesToAwish(orgId, [machineId], { withPending: false });
      const summary = summariseAwishPush(pushed, [machineId]);
      awish =
        summary === undefined || summary.state === "off"
          ? "off"
          : summary.state === "sent"
            ? "pushed"
            : "pending";
    } catch {
      await recordAwishPushFailure(orgId, [machineId]).catch(() => {});
      awish = "pending";
    }
  }
  return {
    ok: true,
    packs,
    clientIds: [...savedIds],
    awish,
    warnings: rejected.map((r) => r.error ?? "En rad kunde inte sparas."),
  };
}

/** Ångra (egna påfyllningar, 30 minuter). */
export async function staffUndo(
  raw: unknown,
): Promise<{ ok: true; packs: number } | { ok: false; error: string }> {
  const staff = await requireStaff();
  const parsed = z.object({ orgId: uuid, clientIds: z.array(uuid).min(1).max(100) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Inget att ångra." };
  if (!staff.machines.some((m) => m.organizationId === parsed.data.orgId)) {
    return { ok: false, error: "Inget att ångra." };
  }
  return undoRefillItems(staff.user, parsed.data.orgId, parsed.data.clientIds);
}

export interface PinState {
  error?: string;
}

/** Egen PIN-kod (två gånger). */
export async function staffSetPin(_prev: PinState, form: FormData): Promise<PinState> {
  const staff = await requireStaff();
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
