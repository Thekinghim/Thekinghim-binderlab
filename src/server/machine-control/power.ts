/**
 * Starta om och Stäng av (Awish ControlPower REBOOT / SHUTDOWN). Fysiska åtgärder: bara
 * ägare och admin, automaten måste vara online och takten begränsas (spärren). Båda kräver
 * en förhandsvisning på servern (previewPowerFor) vars bevis bekräftelsen skickar tillbaka
 * inom 10 minuter (confirm-token.ts). Stäng av kräver dessutom att automatens kod skrivs och
 * att en versionsändring hos Awish är bekräftad. Awish kör det när ingen har rört skärmen
 * på en minut.
 */

import "server-only";

import { z } from "zod";

import { newIdempotencyKey, runControlAction } from "@/server/awish/control/guard";
import type { Viewer } from "@/server/data/core/loaders";

import {
  dbOf,
  idempotencyKeyOf,
  machineFor,
  MachineControlError,
  outcome,
  requireOperator,
  STALE_MESSAGE,
  typedMatches,
  type ControlOutcome,
  type ControlPreview,
  type MachineControlDeps,
} from "./common";
import { issueConfirmToken, verifyConfirmToken } from "./confirm-token";
import { REBOOT_TEXT, SHUTDOWN_TEXT } from "./texts";

export { REBOOT_TEXT, SHUTDOWN_TEXT };

const powerPreviewSchema = z.object({
  machineId: z.uuid("Välj automat."),
  method: z.enum(["REBOOT", "SHUTDOWN"]),
});

const powerInputSchema = powerPreviewSchema.extend({
  typed: z.string().max(40).optional(),
  idempotencyKey: z.string(),
  /** Beviset från förhandsvisningen. */
  fingerprint: z.string().max(200),
});

function nowMs(deps: MachineControlDeps): number {
  return (deps.now?.() ?? new Date()).getTime();
}

/** Förhandsvisningen för Starta om / Stäng av, med beviset som bekräftelsen kräver. */
export async function previewPowerFor(
  viewer: Viewer,
  raw: unknown,
  deps: MachineControlDeps = {},
): Promise<ControlPreview> {
  const input = powerPreviewSchema.parse(raw);
  await requireOperator(viewer);
  const machine = await machineFor(dbOf(deps), viewer.organization.id, input.machineId, deps);
  const shutdown = input.method === "SHUTDOWN";
  const idempotencyKey = newIdempotencyKey();
  return {
    lines: [
      shutdown
        ? `${machine.code} stängs av och säljer inget förrän någon slår på den.`
        : `${machine.code} startar om.`,
    ],
    warnings: [],
    blocking: null,
    confirm: null,
    typed: shutdown ? machine.code : null,
    idempotencyKey,
    fingerprint: issueConfirmToken(
      {
        orgId: viewer.organization.id,
        userId: viewer.user.userId,
        machineId: machine.id,
        action: input.method,
        idempotencyKey,
      },
      nowMs(deps),
      deps.env,
    ),
  };
}

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
  const confirmed = verifyConfirmToken(
    input.fingerprint,
    {
      orgId: viewer.organization.id,
      userId: viewer.user.userId,
      machineId: machine.id,
      action: input.method,
      idempotencyKey,
    },
    nowMs(deps),
    deps.env,
  );
  if (!confirmed) throw new MachineControlError(STALE_MESSAGE);
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
