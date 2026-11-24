"use server";

/**
 * Server actions för Styr automaten. Tunna omslag: rollen kontrolleras här (ägare/admin) och
 * i tjänsterna mot databasen, indata valideras med zod i tjänsterna, och organisationen är
 * alltid den inloggades aktiva. Varje skrivning går genom spärren (runControlAction) och
 * kräver förhandsvisningens fingeravtryck och idempotensnyckel.
 */

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { AwishApiError } from "@/server/awish/grpc-client";
import { NewProductError } from "@/server/awish/goods";
import { AwishNotConnectedError } from "@/server/awish/marketing";
import { OPERATOR_ROLES, requireContextRole, requireViewer } from "@/server/data/core";
import { safeErrorForLog } from "@/server/errors";
import {
  FORBIDDEN_MESSAGE,
  MachineControlError,
  type ControlOutcome,
  type ControlPreview,
} from "@/server/machine-control/common";
import {
  applyMachineConfigFor,
  previewMachineConfigFor,
} from "@/server/machine-control/machine-config";
import { controlPowerFor, previewPowerFor } from "@/server/machine-control/power";
import {
  applyPowerScheduleFor,
  clearPowerScheduleFor,
  previewPowerScheduleFor,
} from "@/server/machine-control/power-schedule";
import { applyReplenishFor, previewReplenishFor } from "@/server/machine-control/replenish";
import { executeShipmentFor, previewShipmentFor } from "@/server/machine-control/shipment";
import {
  applySlotSwapFor,
  previewSlotSwapFor,
  slotSwapChoicesFor,
  type SlotSwapChoices,
} from "@/server/machine-control/slot-swap";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof AuthorizationError) {
    return {
      ok: false,
      error: error.reason === "unauthenticated" ? error.message : FORBIDDEN_MESSAGE,
    };
  }
  if (
    error instanceof MachineControlError ||
    error instanceof NewProductError ||
    error instanceof AwishNotConnectedError ||
    error instanceof AwishApiError
  ) {
    return { ok: false, error: error.message };
  }
  // Bara namn och meddelande loggas (aldrig parametrar, signatur eller inloggning).
  console.error("[styr]", safeErrorForLog(error));
  return { ok: false, error: "Det gick inte just nu. Försök igen om en stund." };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return requireViewer();
}

async function read<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return failure(error);
  }
}

async function write(
  fn: () => Promise<ControlOutcome>,
): Promise<ActionResult<{ message: string }>> {
  try {
    const r = await fn();
    revalidatePath("/automater/[automat]/styr", "page");
    return r.ok ? { ok: true, data: { message: r.message } } : { ok: false, error: r.message };
  } catch (error) {
    return failure(error);
  }
}

type Confirm = { fingerprint: string; idempotencyKey: string };

export async function previewPowerAction(raw: unknown) {
  return read<ControlPreview>(async () => previewPowerFor(await operator(), raw));
}
export async function controlPowerAction(raw: unknown) {
  return write(async () => controlPowerFor(await operator(), raw));
}

export async function previewPowerScheduleAction(raw: unknown) {
  return read<ControlPreview>(async () => previewPowerScheduleFor(await operator(), raw));
}
export async function applyPowerScheduleAction(raw: unknown, c: Confirm & { typed?: string }) {
  return write(async () => applyPowerScheduleFor(await operator(), raw, c));
}
export async function clearPowerScheduleAction(machineId: string, idempotencyKey: string) {
  return write(async () => clearPowerScheduleFor(await operator(), { machineId, idempotencyKey }));
}

export async function previewShipmentAction(raw: unknown) {
  return read<ControlPreview>(async () => previewShipmentFor(await operator(), raw));
}
export async function executeShipmentAction(
  raw: unknown,
  c: Confirm & { typed: string; reason: string },
) {
  return write(async () => executeShipmentFor(await operator(), raw, c));
}

export async function previewMachineConfigAction(raw: unknown) {
  return read<ControlPreview>(async () => previewMachineConfigFor(await operator(), raw));
}
export async function applyMachineConfigAction(raw: unknown, c: Confirm) {
  return write(async () => applyMachineConfigFor(await operator(), raw, c));
}

export async function slotSwapChoicesAction(machineId: string) {
  return read<SlotSwapChoices>(async () => slotSwapChoicesFor(await operator(), machineId));
}
export async function previewSlotSwapAction(raw: unknown) {
  return read(async () => previewSlotSwapFor(await operator(), raw));
}
export async function applySlotSwapAction(raw: unknown, c: Confirm & { confirmed: boolean }) {
  return write(async () => applySlotSwapFor(await operator(), raw, c));
}

export async function previewReplenishAction(raw: unknown) {
  return read<ControlPreview>(async () => previewReplenishFor(await operator(), raw));
}
export async function applyReplenishAction(raw: unknown, c: Confirm) {
  return write(async () => applyReplenishFor(await operator(), raw, c));
}
