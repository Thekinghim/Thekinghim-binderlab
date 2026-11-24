/**
 * Påfyllningen till Awish: webbpanelen (som i dag) eller API:t, efter organisationens val
 * under Datakällor (awish_api_state.slot_writes_via):
 *
 *   web           pushMachinesToAwish (webbpanelen), standard
 *   api           pushMachinesViaApi (gRPC, signerat)
 *   api_then_web  API:t; automater som misslyckades (inte med okänt utfall) går via webbpanelen
 *
 * API:t används bara när signeringen är testad (sign_status 'ok'); annars webbpanelen.
 * Samma signatur som pushMachinesToAwish, så att anroparna bara byter import.
 */

import "server-only";

import { getServiceDb } from "@/db/client";

import { awishSourceOf } from "../marketing";
import { pushMachinesToAwish, type WebPushDeps, type WebPushResult } from "../web-service";
import { pushMachinesViaApi } from "./api-push";
import type { ControlDeps } from "./connect";
import { loadApiState } from "./state";

export type RefillPushDeps = WebPushDeps & { control?: ControlDeps };

/** Vägen för påfyllningen just nu. */
export async function refillPushVia(
  organizationId: string,
  deps: Pick<RefillPushDeps, "serviceDb"> = {},
): Promise<"web" | "api" | "api_then_web"> {
  const db = deps.serviceDb ?? getServiceDb();
  try {
    const source = await awishSourceOf(db, organizationId);
    if (!source) return "web";
    const state = await loadApiState(db, organizationId, source.id);
    if (!state || state.signStatus !== "ok") return "web";
    return state.slotWritesVia;
  } catch (error) {
    console.error(
      "[awish] kunde inte läsa påfyllningens väg",
      error instanceof Error ? error.name : "fel",
    );
    return "web";
  }
}

export async function pushRefillToAwish(
  organizationId: string,
  machineIds: readonly string[],
  deps: RefillPushDeps = {},
): Promise<WebPushResult> {
  const via = await refillPushVia(organizationId, deps);
  if (via === "web") return pushMachinesToAwish(organizationId, machineIds, deps);

  const api = await pushMachinesViaApi(organizationId, machineIds, {
    ...deps.control,
    serviceDb: deps.serviceDb,
    withPending: deps.withPending,
    dryRun: deps.dryRun,
  });
  if (via === "api") {
    return {
      status: api.status,
      ...(api.reason ? { reason: api.reason } : {}),
      machines: api.machines,
    };
  }
  // api_then_web: API:t avstängt → hela via webben; annars bara de som misslyckades.
  if (api.status === "off") return pushMachinesToAwish(organizationId, machineIds, deps);
  const unknown = new Set(api.unknownMachineIds);
  const retry = api.machines
    .filter((m) => m.status === "error" && !unknown.has(m.machineId))
    .map((m) => m.machineId);
  if (retry.length === 0) return { status: api.status, machines: api.machines };
  const web = await pushMachinesToAwish(organizationId, retry, { ...deps, withPending: false });
  if (web.status === "off") return { status: api.status, machines: api.machines };
  const byId = new Map(web.machines.map((m) => [m.machineId, m]));
  return {
    status: "done",
    machines: api.machines.map((m) => byId.get(m.machineId) ?? m),
  };
}
