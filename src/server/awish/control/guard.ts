/** Skyddet runt varje skrivning till Awish via API:t. */

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
  /** Standard OPERATOR_ROLES (ägare, admin). */
  roles?: readonly MembershipRole[];
  /** reboot, shutdown, shipment. */
  physical?: boolean;
  /** shipment, shutdown. */
  requireAckedVersion?: boolean;
  requireOnline?: boolean;
  /** uuid från förhandsvisningen. */
  idempotencyKey: string;
  reason?: string | null;
  /** Begäran utan personuppgifter, sign och timestamp. */
  auditRequest: Record<string, unknown>;
}

export type ControlActionFailure =
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

export type ControlActionResult<T> =
  | { ok: true; message: string; value: T; actionId: string; replayed: boolean }
  | { ok: false; message: string; actionId: string | null; kind: ControlActionFailure };

export interface AuditRow {
  id: string;
  kind: AwishActionKind;
  machineId: string | null;
  targetId: string | null;
  status: "pending" | "ok" | "failed" | "unknown" | "blocked";
  actorId: string | null;
  actorName: string | null;
  reason: string | null;
  awishMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export async function runControlAction<T>(
  viewer: Viewer,
  spec: ControlActionSpec,
  fn: (api: AwishControlApi, ctx: { awishMachineId: string | null; db: Db }) => Promise<T>,
  deps?: ControlDeps,
): Promise<ControlActionResult<T>> {
  void viewer;
  void spec;
  void fn;
  void deps;
  throw new Error("inte klart");
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function recentActionsFor(
  viewer: Viewer,
  filter: { machineId?: string; kinds?: AwishActionKind[]; limit?: number },
): Promise<AuditRow[]> {
  void viewer;
  void filter;
  throw new Error("inte klart");
}
