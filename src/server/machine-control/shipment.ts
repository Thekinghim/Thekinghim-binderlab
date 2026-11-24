/**
 * "Mata ut ett pack" (Awish ExecuteShipment): motorn i ett fack snurrar och ett pack faller
 * ut utan betalning. Den farligaste åtgärden, så allt krävs: ägare eller admin, aldrig i en
 * demo, automaten online, versionsändring bekräftad, en anledning (syns i loggen), automatens
 * kod skriven, och takten begränsad (spärren). Lagret ändras inte automatiskt.
 *
 * Parametrarna kommer ur fackets kanal i Awish: addr, motor_id och floor_type. `code`
 * skickas bara när kanalens namn är ett tal (oklart i dokumentationen vad det betyder).
 */

import "server-only";

import { z } from "zod";

import { runControlAction } from "@/server/awish/control/guard";
import type { AwishProductDetail, AwishShipmentInput } from "@/server/awish/control/types";
import type { Viewer } from "@/server/data/core/loaders";

import {
  idempotencyKeyOf,
  MachineControlError,
  outcome,
  preview,
  slotName,
  STALE_MESSAGE,
  typedMatches,
  withReadClient,
  type ControlOutcome,
  type ControlPreview,
  type MachineControlDeps,
} from "./common";

export const SHIPMENT_TEXT =
  "Motorn snurrar och ett pack faller ut. Ingen betalning registreras. Awish kör det bara när automaten är i underhållsläge.";
export const MIN_REASON = 5;
export const MAX_REASON = 300;

export const shipmentInputSchema = z.object({
  machineId: z.uuid("Välj automat."),
  productId: z.string().regex(/^\d{1,20}$/, "Välj fack."),
});

/** Anledningen: krävs, minst 5 tecken, högst 300, utan radbrytningar i loggen. */
export function cleanReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (reason.length < MIN_REASON)
    throw new MachineControlError("Skriv varför (minst 5 tecken). Det syns i loggen.");
  if (reason.length > MAX_REASON)
    throw new MachineControlError(`Anledningen får vara högst ${MAX_REASON} tecken.`);
  return reason;
}

/** Fackets kanal → ExecuteShipment (utan machineId). Kastar när kanalen saknas. */
export function shipmentParams(
  product: Pick<AwishProductDetail, "id" | "channel">,
): Omit<AwishShipmentInput, "machineId"> {
  const ch = product.channel;
  if (!ch || !ch.addr.trim() || !ch.motorId.trim()) {
    throw new MachineControlError(
      `${slotName(ch?.name, product.id)} saknar motoruppgifter i Awish. Det går inte att mata ut.`,
    );
  }
  return {
    addr: ch.addr,
    motorIds: [ch.motorId],
    floorType: ch.floorType,
    ...(/^\d+$/.test(ch.name) ? { code: ch.name } : {}),
  };
}

export interface ShipmentPlan {
  readonly lines: string[];
  readonly warnings: string[];
  readonly blocking: string | null;
  readonly params: Omit<AwishShipmentInput, "machineId"> | null;
  readonly slot: string;
}

export function planShipment(args: {
  product: AwishProductDetail;
  online: boolean;
  code: string;
}): ShipmentPlan {
  const { product } = args;
  const slot = slotName(product.channel?.name, product.id);
  let params: ShipmentPlan["params"] = null;
  let blocking: string | null = null;
  try {
    params = shipmentParams(product);
  } catch (error) {
    blocking = error instanceof Error ? error.message : String(error);
  }
  if (!args.online) blocking ??= "Automaten är offline. Det går bara när den är online.";
  const warnings: string[] = [];
  if (product.currentInventory <= 0) warnings.push(`${slot} är tomt enligt Awish.`);
  if (product.floorStatus && product.floorStatus !== "ERR_NORMAL")
    warnings.push(`${slot} har ett fel i Awish (${product.floorStatus}).`);
  return {
    lines: [
      `${args.code}: ett ${product.goodName ? `pack ${product.goodName}` : "pack"} matas ut ur ${slot}.`,
      "Lagret ändras inte. Räkna facket efteråt.",
    ],
    warnings,
    blocking,
    params,
    slot,
  };
}

async function computePlan(viewer: Viewer, raw: unknown, deps: MachineControlDeps) {
  const input = shipmentInputSchema.parse(raw);
  return withReadClient(viewer, input.machineId, deps, async ({ api, machine }) => {
    const [detail, products] = await Promise.all([
      api.machineDetail(machine.awishMachineId),
      api.productDetails(machine.awishMachineId),
    ]);
    const product = products.find((p) => p.id === input.productId);
    if (!product) throw new MachineControlError("Facket finns inte i automaten i Awish. Ladda om.");
    const plan = planShipment({ product, online: detail.isOnline, code: machine.code });
    return {
      input,
      machine,
      plan,
      preview: preview(
        { lines: plan.lines, warnings: plan.warnings, blocking: plan.blocking },
        { machineId: machine.id, productId: product.id, params: plan.params },
        machine.code,
      ),
    };
  });
}

export async function previewShipmentFor(
  viewer: Viewer,
  raw: unknown,
  deps: MachineControlDeps = {},
): Promise<ControlPreview> {
  return (await computePlan(viewer, raw, deps)).preview;
}

export async function executeShipmentFor(
  viewer: Viewer,
  raw: unknown,
  confirm: { fingerprint: string; idempotencyKey: unknown; typed: unknown; reason: unknown },
  deps: MachineControlDeps = {},
): Promise<ControlOutcome> {
  const idempotencyKey = idempotencyKeyOf(confirm.idempotencyKey);
  const reason = cleanReason(confirm.reason);
  const { input, machine, plan, preview: now } = await computePlan(viewer, raw, deps);
  if (!typedMatches(confirm.typed, machine.code))
    throw new MachineControlError(`Skriv ${machine.code} för att mata ut.`);
  if (plan.blocking || !plan.params) throw new MachineControlError(plan.blocking ?? STALE_MESSAGE);
  if (now.fingerprint !== confirm.fingerprint) throw new MachineControlError(STALE_MESSAGE);
  const params = plan.params;
  const run = deps.run ?? runControlAction;
  const r = await run(
    viewer,
    {
      kind: "shipment",
      machineId: machine.id,
      targetId: input.productId,
      physical: true,
      requireOnline: true,
      requireAckedVersion: true,
      idempotencyKey,
      reason,
      auditRequest: { productId: input.productId, slot: plan.slot, ...params },
    },
    (api, ctx) =>
      api.executeShipment({ machineId: ctx.awishMachineId ?? machine.awishMachineId, ...params }),
    deps,
  );
  return outcome(r, () => "Skickat. Kontrollera att packet kom ut.");
}
