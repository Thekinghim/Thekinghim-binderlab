/**
 * Skärm och reklam (Awish UpdateMachineConfig). API:t ändrar bara reklamen: reklam i vila,
 * autouppspelning, bildspel och bytesintervallen. Volym och ljusstyrka går bara att läsa
 * (de ändras på automaten). Bara fälten som ändras skickas.
 */

import "server-only";

import { z } from "zod";

import { runControlAction } from "@/server/awish/control/guard";
import type { AwishMachineConfig, AwishMachineConfigInput } from "@/server/awish/control/types";
import type { Viewer } from "@/server/data/core/loaders";

import {
  idempotencyKeyOf,
  MachineControlError,
  outcome,
  preview,
  STALE_MESSAGE,
  withReadClient,
  type ControlOutcome,
  type ControlPreview,
  type MachineControlDeps,
} from "./common";

export const MIN_INTERVAL_S = 5;
export const MAX_INTERVAL_S = 300;

const interval = (label: string) =>
  z.coerce
    .number({ message: `Skriv sekunder för ${label}.` })
    .int(`${label}: hela sekunder.`)
    .min(MIN_INTERVAL_S, `${label}: minst ${MIN_INTERVAL_S} s.`)
    .max(MAX_INTERVAL_S, `${label}: högst ${MAX_INTERVAL_S} s.`);

export const machineConfigInputSchema = z.object({
  machineId: z.uuid("Välj automat."),
  standbyAdsEnabled: z.boolean(),
  standbyAdsAutoplay: z.boolean(),
  carouselAdsEnabled: z.boolean(),
  standbyAdsSwitchInterval: interval("Reklam i vila"),
  carouselAdsSwitchInterval: interval("Bildspel"),
});
export type MachineConfigInput = z.output<typeof machineConfigInputSchema>;

type Editable = Omit<AwishMachineConfigInput, "machineId">;

const LABELS: Record<keyof Editable, string> = {
  standbyAdsEnabled: "Reklam i vila",
  standbyAdsAutoplay: "Spela upp automatiskt",
  carouselAdsEnabled: "Bildspel",
  standbyAdsSwitchInterval: "Byt bild i vila var",
  carouselAdsSwitchInterval: "Byt bild i bildspelet var",
};

function show(v: boolean | number): string {
  if (typeof v === "boolean") return v ? "på" : "av";
  return `${v} s`;
}

export interface MachineConfigPlan {
  readonly lines: string[];
  readonly unchanged: boolean;
  readonly change: Editable;
}

/** Bara det som skiljer sig från nuvarande inställning. */
export function planMachineConfig(
  current: AwishMachineConfig | null,
  input: MachineConfigInput,
): MachineConfigPlan {
  const change: Editable = {};
  const lines: string[] = [];
  for (const key of Object.keys(LABELS) as (keyof Editable)[]) {
    const next = input[key];
    const before = current ? current[key] : undefined;
    if (before === next) continue;
    (change as Record<string, unknown>)[key] = next;
    lines.push(
      before === undefined
        ? `${LABELS[key]}: ${show(next)}.`
        : `${LABELS[key]}: ${show(before)} → ${show(next)}.`,
    );
  }
  const unchanged = lines.length === 0;
  return { lines: unchanged ? ["Inget att ändra."] : lines, unchanged, change };
}

async function computePlan(viewer: Viewer, raw: unknown, deps: MachineControlDeps) {
  const input = machineConfigInputSchema.parse(raw);
  return withReadClient(viewer, input.machineId, deps, async ({ api, machine }) => {
    const detail = await api.machineDetail(machine.awishMachineId);
    const plan = planMachineConfig(detail.config, input);
    return {
      machine,
      plan,
      preview: preview(
        { lines: plan.lines, blocking: plan.unchanged ? "Inget att ändra." : null },
        { machineId: machine.id, change: plan.change },
      ),
    };
  });
}

export async function previewMachineConfigFor(
  viewer: Viewer,
  raw: unknown,
  deps: MachineControlDeps = {},
): Promise<ControlPreview> {
  return (await computePlan(viewer, raw, deps)).preview;
}

export async function applyMachineConfigFor(
  viewer: Viewer,
  raw: unknown,
  confirm: { fingerprint: string; idempotencyKey: unknown },
  deps: MachineControlDeps = {},
): Promise<ControlOutcome> {
  const idempotencyKey = idempotencyKeyOf(confirm.idempotencyKey);
  const { machine, plan, preview: now } = await computePlan(viewer, raw, deps);
  if (plan.unchanged) throw new MachineControlError("Inget att ändra.");
  if (now.fingerprint !== confirm.fingerprint) throw new MachineControlError(STALE_MESSAGE);
  const run = deps.run ?? runControlAction;
  const r = await run(
    viewer,
    {
      kind: "machine_config",
      machineId: machine.id,
      idempotencyKey,
      auditRequest: { ...plan.change },
    },
    (api, ctx) =>
      api.updateMachineConfig({
        machineId: ctx.awishMachineId ?? machine.awishMachineId,
        ...plan.change,
      }),
    deps,
  );
  return outcome(r, () => `Sparat. ${machine.code} visar reklamen som du valde.`);
}
