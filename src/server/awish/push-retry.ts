/**
 * "Försök igen" i Fyll på, bundet till en given användare (testbart utan Next): skickar
 * antalen till Awish en gång till för automater vars sändning inte gick fram. Rollen
 * kontrolleras mot databasen (ägare, admin, påfyllare); sändningen körs sedan som
 * systemrollen med organisationen ur den kontrollerade sessionen, aldrig ur förfrågan.
 * En automat som inte väntar, eller som hör till en annan organisation, skickas aldrig.
 */

import "server-only";

import { z } from "zod";

import { requireRoleFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { FIELD_REFILL_ROLES } from "@/server/data/field-refills";
import { isDemoFor } from "@/server/demo/guard";

import { summariseAwishPush, type AwishPushStatus } from "./push-status";
import { retryPendingAwishPushes, type WebPushDeps } from "./web-service";

const input = z.object({ machineId: z.string().uuid().optional() }).optional();

export interface AwishRetryStatus {
  /** Beskedet om försöket; saknas när ingen automat väntade eller push är avstängd. */
  readonly awish?: AwishPushStatus;
  /** Automater som fortfarande väntar. */
  readonly pending: string[];
  /** Sant när den efterfrågade automaten (eller alla) inte väntar längre. */
  readonly cleared: boolean;
}

export async function retryAwishPushFor(
  viewer: Viewer,
  raw: unknown,
  deps: WebPushDeps = {},
): Promise<AwishRetryStatus> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, FIELD_REFILL_ROLES);
  const parsed = input.safeParse(raw);
  const machineId = parsed.success ? (parsed.data?.machineId ?? null) : null;
  // Demo för kunder: inga anrop till Awish.
  if (await isDemoFor(viewer.user, orgId)) return { pending: [], cleared: true };
  const out = await retryPendingAwishPushes(orgId, machineId ? [machineId] : null, deps);
  const awish = out.push ? summariseAwishPush(out.push) : undefined;
  return {
    ...(awish ? { awish } : {}),
    pending: out.pending,
    cleared: machineId ? !out.pending.includes(machineId) : out.pending.length === 0,
  };
}
