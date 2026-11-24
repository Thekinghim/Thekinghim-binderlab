"use server";

/**
 * Påfyllare i butiken på automatens sida: skapa, ny PIN-kod, stäng av / slå på och välja
 * automater. Ägare och admin (requireContextRole + kontroll mot databasen i
 * src/server/data/machine-staff.ts).
 */

import { revalidatePath } from "next/cache";

import { getServiceDb } from "@/db/client";
import { getAuthProvider } from "@/server/auth";
import { OPERATOR_ROLES, requireContextRole } from "@/server/data/core";
import {
  createMachineStaff,
  resetStaffPin,
  setStaffDisabled,
  setStaffMachines,
} from "@/server/data/machine-staff";

import { currentViewer } from "../_lib/session";

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
  return done(await createMachineStaff(user, orgId, input, deps));
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
