import { headers } from "next/headers";
import QRCode from "qrcode";
import { sql } from "drizzle-orm";

import { getServiceDb } from "@/db/client";
import { getServerEnv } from "@/lib/env";
import { withUserDbFor, type SessionUser } from "@/server/access";
import { listMachineStaff } from "@/server/data/machine-staff";
import { resolveAppBaseUrl } from "@/server/request-info";

import { StaffAccess } from "./staff-access";

/**
 * Kortet "Påfyllare i butiken" på automatens sida (ägare och admin): personalen som får
 * fylla på, och QR-koden till inloggningen med mobilnummer (/m).
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
  const link = `${resolveAppBaseUrl(getServerEnv(), await headers())}/m`;
  const qrSvg = await QRCode.toString(link, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });
  return (
    <StaffAccess
      machineId={machineId}
      staff={staff.filter((s) => s.machineIds.includes(machineId))}
      machines={(Array.from(machines) as { id: string; code: string; name: string }[]).map((m) => ({
        id: m.id,
        label: `${m.code} ${m.name}`,
      }))}
      link={link}
      qrSvg={qrSvg}
    />
  );
}
