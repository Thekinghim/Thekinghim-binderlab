/**
 * Starta om och Stäng av (Awish ControlPower REBOOT / SHUTDOWN). Fysiska åtgärder: bara
 * ägare och admin, automaten måste vara online, takten begränsas (spärren), och Stäng av
 * kräver dessutom att automatens kod skrivs och att en versionsändring hos Awish är
 * bekräftad. Awish kör det när ingen har rört skärmen på en minut.
 */

import "server-only";

import { z } from "zod";

import { runControlAction } from "@/server/awish/control/guard";
import type { Viewer } from "@/server/data/core/loaders";

import {
  dbOf,
  idempotencyKeyOf,
  machineFor,
  MachineControlError,
  outcome,
  requireOperator,
  typedMatches,
  type ControlOutcome,
  type MachineControlDeps,
} from "./common";

const powerInputSchema = z.object({
  machineId: z.uuid("Välj automat."),
  method: z.enum(["REBOOT", "SHUTDOWN"]),
  typed: z.string().max(40).optional(),
  idempotencyKey: z.string(),
});

export const REBOOT_TEXT =
  "Den startar om när ingen har rört skärmen på en minut. Försäljningen stannar ett par minuter.";
export const SHUTDOWN_TEXT =
  "Den går inte att starta på distans. Någon måste slå på den i butiken.";

export async function controlPowerFor(
  viewer: Viewer,
  raw: unknown,
  deps: MachineControlDeps = {},
): Promise<ControlOutcome> {
  const input = powerInputSchema.parse(raw);
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  await requireOperator(viewer);
  const machine = await machineFor(dbOf(deps), viewer.organization.id, input.machineId, deps);
  const shutdown = input.method === "SHUTDOWN";
  if (shutdown && !typedMatches(input.typed, machine.code)) {
    throw new MachineControlError(`Skriv ${machine.code} för att stänga av.`);
  }
  const run = deps.run ?? runControlAction;
  const r = await run(
    viewer,
    {
      kind: shutdown ? "shutdown" : "reboot",
      machineId: machine.id,
      physical: true,
      requireOnline: true,
      requireAckedVersion: shutdown,
      idempotencyKey,
      auditRequest: { method: input.method },
    },
    (api, ctx) =>
      api.controlPower({
        machineId: ctx.awishMachineId ?? machine.awishMachineId,
        method: input.method,
      }),
    deps,
  );
  return outcome(r, () =>
    shutdown
      ? `Skickat. ${machine.code} stängs av när ingen har rört skärmen på en minut.`
      : `Skickat. ${machine.code} startar om inom ett par minuter.`,
  );
}
