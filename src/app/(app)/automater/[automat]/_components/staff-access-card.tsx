import { sql } from "drizzle-orm";

import { getServiceDb } from "@/db/client";
import { withUserDbFor, type SessionUser } from "@/server/access";
import { listMachineStaff } from "@/server/data/machine-staff";

import { StaffAccess } from "./staff-access";

/**
 * Kortet "Påfyllare i butiken" på automatens sida (ägare och admin): personalen som får
 * fylla på. QR-koden (/m/<nyckel>) visas när kontot skapas och med "Ny QR-kod".
 */
export async function StaffAccessCard({
  user,
  orgId,
  machineId,
}: {
  user: SessionUser;
  orgId: string;
  machineId: string;
}) {
  const [staff, machines] = await Promise.all([
    listMachineStaff(user, orgId, getServiceDb),
    withUserDbFor(user, (tx) =>
      tx.execute(sql`select id, code, name from public.machines
        where organization_id = ${orgId}::uuid and archived_at is null order by code`),
    ),
  ]);
  return (
    <StaffAccess
      machineId={machineId}
      staff={staff.filter((s) => s.machineIds.includes(machineId))}
      machines={(Array.from(machines) as { id: string; code: string; name: string }[]).map((m) => ({
        id: m.id,
        label: `${m.code} ${m.name}`,
      }))}
    />
  );
}
