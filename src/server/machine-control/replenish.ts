/**
 * "Fyll facken fullt" (Awish ReplenishProductInventory): de valda facken sätts till sin
 * kapacitet. Ökningen dras från lagret vid nästa synk, som en påfyllning i Awish. Exakta
 * antal går genom Byt pack i fack (UpdateProduct).
 */

import "server-only";

import { z } from "zod";

import { runControlAction } from "@/server/awish/control/guard";
import type { AwishProductDetail } from "@/server/awish/control/types";
import type { Viewer } from "@/server/data/core/loaders";

import {
  idempotencyKeyOf,
  MachineControlError,
  outcome,
  preview,
  slotName,
  STALE_MESSAGE,
  withReadClient,
  type ControlOutcome,
  type ControlPreview,
  type MachineControlDeps,
} from "./common";

export const REPLENISH_WARNING =
  "Ökningen dras från lagret vid nästa synk, som en påfyllning i Awish.";

export const replenishInputSchema = z.object({
  machineId: z.uuid("Välj automat."),
  productIds: z
    .array(z.string().regex(/^\d{1,20}$/))
    .min(1, "Välj minst ett fack.")
    .max(200),
});

export interface ReplenishPlan {
  readonly lines: string[];
  readonly warnings: string[];
  readonly blocking: string | null;
  /** Facken som faktiskt ökar (redan fulla skickas inte). */
  readonly ids: string[];
  readonly added: number;
}

export function planReplenish(
  products: readonly AwishProductDetail[],
  productIds: readonly string[],
): ReplenishPlan {
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: string[] = [];
  const warnings: string[] = [];
  const ids: string[] = [];
  let added = 0;
  for (const id of [...new Set(productIds)]) {
    const p = byId.get(id);
    if (!p) throw new MachineControlError("Ett fack finns inte i automaten i Awish. Ladda om.");
    const name = slotName(p.channel?.name, p.id);
    if (p.capacity <= 0) {
      warnings.push(`${name} har ingen kapacitet i Awish och fylls inte.`);
      continue;
    }
    if (p.currentInventory >= p.capacity) {
      lines.push(`${name} är redan fullt (${p.capacity}).`);
      continue;
    }
    if (!p.goodId) warnings.push(`${name} har ingen vara i Awish.`);
    lines.push(`${name.replace(/^Fack /, "")} ${p.currentInventory} → ${p.capacity}`);
    ids.push(p.id);
    added += p.capacity - p.currentInventory;
  }
  if (ids.length > 0) warnings.unshift(REPLENISH_WARNING);
  return {
    lines,
    warnings,
    blocking: ids.length === 0 ? "Facken är redan fulla." : null,
    ids,
    added,
  };
}

async function computePlan(viewer: Viewer, raw: unknown, deps: MachineControlDeps) {
  const input = replenishInputSchema.parse(raw);
  return withReadClient(viewer, input.machineId, deps, async ({ api, machine }) => {
    const products = await api.productDetails(machine.awishMachineId);
    const plan = planReplenish(products, input.productIds);
    return {
      machine,
      plan,
      preview: preview(plan, { machineId: machine.id, ids: plan.ids, lines: plan.lines }),
    };
  });
}

export async function previewReplenishFor(
  viewer: Viewer,
  raw: unknown,
  deps: MachineControlDeps = {},
): Promise<ControlPreview> {
  return (await computePlan(viewer, raw, deps)).preview;
}

export async function applyReplenishFor(
  viewer: Viewer,
  raw: unknown,
  confirm: { fingerprint: string; idempotencyKey: unknown },
  deps: MachineControlDeps = {},
): Promise<ControlOutcome> {
  const idempotencyKey = idempotencyKeyOf(confirm.idempotencyKey);
  const { machine, plan, preview: now } = await computePlan(viewer, raw, deps);
  if (plan.blocking) throw new MachineControlError(plan.blocking);
  if (now.fingerprint !== confirm.fingerprint) throw new MachineControlError(STALE_MESSAGE);
  const run = deps.run ?? runControlAction;
  const r = await run(
    viewer,
    {
      kind: "replenish",
      machineId: machine.id,
      idempotencyKey,
      auditRequest: { ids: plan.ids, added: plan.added },
    },
    (api, ctx) =>
      api.replenishProductInventory({
        machineId: ctx.awishMachineId ?? machine.awishMachineId,
        ids: plan.ids,
      }),
    deps,
  );
  return outcome(
    r,
    () =>
      `Klart! ${plan.ids.length} ${plan.ids.length === 1 ? "fack är fullt" : "fack är fulla"} (+${plan.added} st).`,
  );
}
