"use server";

/**
 * Påfyllare i butiken på automatens sida: skapa, ny PIN-kod, stäng av / slå på och välja
 * automater. Ägare och admin (requireContextRole + kontroll mot databasen i
 * src/server/data/machine-staff.ts).
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import QRCode from "qrcode";

import { getServiceDb } from "@/db/client";
import { getServerEnv } from "@/lib/env";
import { getAuthProvider } from "@/server/auth";
import { OPERATOR_ROLES, requireContextRole } from "@/server/data/core";
import {
  createMachineStaff,
  resetStaffPin,
  rotateStaffQr,
  setStaffDisabled,
  setStaffMachines,
} from "@/server/data/machine-staff";

import { resolveAppBaseUrl } from "@/server/request-info";

import { currentViewer } from "../_lib/session";

export interface StaffQr {
  link: string;
  svg: string;
}

/** Länken /m/<nyckel> och QR-koden för den (visas en gång, nyckeln sparas bara som hash). */
async function qrFor(token: string): Promise<StaffQr> {
  const link = `${resolveAppBaseUrl(getServerEnv(), await headers())}/m/${token}`;
  const svg = await QRCode.toString(link, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });
  return { link, svg };
}

async function context() {
  await requireContextRole(OPERATOR_ROLES);
  const viewer = await currentViewer();
  return {
    user: viewer.user,
    orgId: viewer.organization.id,
    deps: { db: getServiceDb, provider: await getAuthProvider() },
  };
}

function done<T>(result: T): T {
  revalidatePath("/automater", "layout");
  return result;
}

export async function createStaffAction(input: unknown) {
  const { user, orgId, deps } = await context();
  const r = await createMachineStaff(user, orgId, input, deps);
  if (!r.ok) return r;
  return done({ ok: true as const, pin: r.pin, name: r.name, qr: await qrFor(r.qrToken) });
}

export async function rotateStaffQrAction(staffUserId: unknown) {
  const { user, orgId } = await context();
  const r = await rotateStaffQr(user, orgId, staffUserId, getServiceDb);
  if (!r.ok) return r;
  return done({ ok: true as const, qr: await qrFor(r.qrToken) });
}

export async function resetStaffPinAction(staffUserId: unknown) {
  const { user, orgId, deps } = await context();
  return done(await resetStaffPin(user, orgId, staffUserId, deps));
}

export async function setStaffDisabledAction(staffUserId: unknown, disabled: unknown) {
  const { user, orgId, deps } = await context();
  return done(await setStaffDisabled(user, orgId, staffUserId, disabled === true, deps));
}

export async function setStaffMachinesAction(staffUserId: unknown, machineIds: unknown) {
  const { user, orgId } = await context();
  return done(await setStaffMachines(user, orgId, staffUserId, machineIds, getServiceDb));
}
