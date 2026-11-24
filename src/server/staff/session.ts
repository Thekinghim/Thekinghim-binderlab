/**
 * Påfyllare i butiken (rollen machine_refiller): sessionen och automaterna. Behörigheten
 * avgörs i databasen (private.staff_can_fill i staff_my_machines, staff_fill_data och
 * påfyllningsfunktionerna); här bara vart personen skickas.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getServiceDb } from "@/db/client";
import { listOrganizationsFor, withUserDbFor, type SessionUser } from "@/server/access";
import { staffSessionState } from "@/server/auth/phone-login";
import { getSessionUser, requireUser } from "@/server/session";

export interface StaffMachine {
  readonly organizationId: string;
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly storeName: string | null;
}

export async function queryStaffMachines(user: SessionUser): Promise<StaffMachine[]> {
  const rows = await withUserDbFor(user, (tx) =>
    tx.execute(
      sql`select organization_id, machine_id, code, name, store_name from public.staff_my_machines()`,
    ),
  );
  return (
    Array.from(rows) as {
      organization_id: string;
      machine_id: string;
      code: string;
      name: string;
      store_name: string | null;
    }[]
  ).map((r) => ({
    organizationId: r.organization_id,
    machineId: r.machine_id,
    code: r.code,
    name: r.name,
    storeName: r.store_name,
  }));
}

export const getStaffMachines = cache(async (): Promise<StaffMachine[]> =>
  queryStaffMachines(await requireUser()),
);

export interface StaffContext {
  readonly user: SessionUser;
  readonly machines: StaffMachine[];
  readonly mustChangePin: boolean;
}

/**
 * För /pafyll: inloggad påfyllare i butiken. Avstängt eller oanvänt i 90 dagar: utloggad
 * (/pafyll/ut). Den som inte har mobilinloggning skickas till appen.
 */
export const requireStaff = cache(async (): Promise<StaffContext> => {
  const user = await requireUser();
  const state = await staffSessionState(getServiceDb, user.userId);
  if (state.state === "expired") redirect("/pafyll/ut");
  if (state.state === "none") redirect("/");
  return { user, machines: await getStaffMachines(), mustChangePin: state.mustChangePin };
});

/**
 * En inloggad som BARA är påfyllare i butiken (inget medlemskap med en approll) skickas
 * till /pafyll. Anropas där appen och portalen annars visar "Inget medlemskap".
 */
export async function redirectStaffToRefill(): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  const machines = await queryStaffMachines(user);
  if (machines.length > 0 && (await listOrganizationsFor(user)).length === 0) {
    redirect("/pafyll");
  }
}
