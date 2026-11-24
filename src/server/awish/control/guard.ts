/**
 * Spärren som varje skrivning till Awish går igenom (roll, demo, avstängning, idempotens,
 * takt, signering, version, online, loggrad).
 *
 * STUBB: signaturerna följer designen (§2.7). Paket P1 skriver kropparna; filen ersätts då.
 */

import "server-only";

import type { Db } from "@/db/client";
import type { MembershipRole } from "@/db/schema";
import type { Viewer } from "@/server/data/core/loaders";

import type { ControlDeps } from "./connect";
import type { AwishControlApi } from "./types";

export type AwishActionKind =
  | "reboot"
  | "shutdown"
  | "power_schedule_set"
  | "power_schedule_clear"
  | "shipment"
  | "machine_config"
  | "slot_update"
  | "replenish"
  | "refill_push_api"
  | "good_create"
  | "good_update"
  | "good_delete"
  | "category_create"
  | "category_update"
  | "category_delete"
  | "products_batch"
  | "member_create"
  | "member_update"
  | "member_delete"
  | "merchant_update"
  | "banner_create"
  | "banner_update"
  | "banner_delete"
  | "pickup_code_create"
  | "sign_probe";

export interface ControlActionSpec {
  kind: AwishActionKind;
  machineId?: string | null;
  targetId?: string | null;
  roles?: readonly MembershipRole[];
  physical?: boolean;
  requireAckedVersion?: boolean;
  requireOnline?: boolean;
  idempotencyKey: string;
  reason?: string | null;
  auditRequest: Record<string, unknown>;
}

export type ControlActionResult<T> =
  | { ok: true; message: string; value: T; actionId: string; replayed: boolean }
  | {
      ok: false;
      message: string;
      actionId: string | null;
      kind:
        | "forbidden"
        | "demo"
        | "disabled"
        | "not_connected"
        | "sign_failed"
        | "version_unacknowledged"
        | "offline"
        | "rate_limited"
        | "awish"
        | "unknown_outcome"
        | "invalid";
    };

export interface AuditRow {
  id: string;
  kind: AwishActionKind;
  status: "pending" | "ok" | "failed" | "unknown" | "blocked";
  actorName: string | null;
  machineId: string | null;
  targetId: string | null;
  reason: string | null;
  awishMessage: string | null;
  createdAt: Date;
}

export async function runControlAction<T>(
  _viewer: Viewer,
  _spec: ControlActionSpec,
  _fn: (api: AwishControlApi, ctx: { awishMachineId: string | null; db: Db }) => Promise<T>,
  _deps?: ControlDeps,
): Promise<ControlActionResult<T>> {
  throw new Error("inte klart");
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function recentActionsFor(
  _viewer: Viewer,
  _filter: { machineId?: string; kinds?: AwishActionKind[]; limit?: number },
): Promise<AuditRow[]> {
  throw new Error("inte klart");
}
