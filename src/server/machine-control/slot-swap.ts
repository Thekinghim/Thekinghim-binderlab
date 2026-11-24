/**
 * "Byt pack i fack" från Styr automaten. Samma plan och regler som Ny produkt → Lägg i fack
 * (planSlotChange: ett fack med pack byter aldrig vara och sänks aldrig utan bekräftelse).
 *
 * Skrivvägen väljs av organisationens flagga (slotWriterFor): webbpanelen som i dag, eller
 * API:t (UpdateProduct, signerat, genom spärren med loggrad). API-vägen körs under samma
 * Awish-lås per organisation som webbvägen, så att en påfyllning inte skriver över bytet.
 * Efter skrivningen läses facket igen; visar Awish inte ändringen än är skrivningen ändå
 * gjord (loggen säger ok) och användaren ombeds titta i Awish.
 */

import "server-only";

import type { Db } from "@/db/client";
import { slotWriterFor, type SlotWriter } from "@/server/awish/control/slot-writer";
import { runControlAction } from "@/server/awish/control/guard";
import {
  planFingerprint,
  planSlotChange,
  slotChangeInputSchema,
  type AwishGoodSummary,
  type AwishSlot,
  type SlotChangePlan,
} from "@/server/awish/goods";
import {
  applySlotChangeFor,
  loggedInClient,
  previewSlotChangeFor,
  slotChoicesFor as webSlotChoicesFor,
  withAwishWriteLock,
} from "@/server/awish/new-product";
import type { AwishWebProduct } from "@/server/awish/web-client";
import type { Viewer } from "@/server/data/core/loaders";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";

import {
  dbOf,
  idempotencyKeyOf,
  machineFor,
  MachineControlError,
  outcome,
  requireOperator,
  STALE_MESSAGE,
  type ControlledMachine,
  type ControlOutcome,
  type ControlPreview,
  type MachineControlDeps,
} from "./common";

export interface SlotSwapDeps extends MachineControlDeps {
  /** Awishs varor att välja bland (testerna ger en lista). */
  listGoods?: (viewer: Viewer) => Promise<AwishGoodSummary[]>;
}

/** Ett fack ur skrivvägen som AwishSlot (felstatus finns bara när källan uppger den). */
export function toSlot(p: AwishWebProduct & { floorStatus?: string | null }): AwishSlot {
  return {
    id: p.id,
    channelName: p.channelName,
    goodId: p.goodId,
    goodName: p.goodName,
    status: p.status,
    floorStatus: p.floorStatus ?? null,
    currentInventory: p.currentInventory,
    capacity: p.capacity,
  };
}

/** Varorna som redan ligger i facken (reserv när varulistan inte går att läsa). */
export function goodsInSlots(slots: readonly AwishSlot[]): AwishGoodSummary[] {
  const seen = new Map<number, string>();
  for (const s of slots) if (s.goodId !== null && s.goodName) seen.set(s.goodId, s.goodName);
  return [...seen].map(([id, name]) => ({ id, name, priceOre: null, thumb: null }));
}

function sortSlots(slots: AwishSlot[]): AwishSlot[] {
  return [...slots].sort(
    (a, b) =>
      (a.channelName ?? "").localeCompare(b.channelName ?? "", "sv", { numeric: true }) ||
      a.id - b.id,
  );
}

async function writerFor(
  viewer: Viewer,
  deps: MachineControlDeps,
): Promise<{ db: Db; writer: SlotWriter }> {
  await requireOperator(viewer);
  const db = dbOf(deps);
  if (await isDemoOrganization(db, viewer.organization.id))
    throw new MachineControlError(DEMO_MESSAGES.integrations);
  const writer = await (deps.slotWriter ?? slotWriterFor)(db, viewer.organization.id, deps);
  return { db, writer };
}

async function defaultGoods(viewer: Viewer): Promise<AwishGoodSummary[]> {
  const { client } = await loggedInClient(viewer, {});
  return client.allGoods();
}

export interface SlotSwapChoices {
  readonly via: "api" | "web";
  readonly slots: AwishSlot[];
  readonly goods: AwishGoodSummary[];
}

export async function slotSwapChoicesFor(
  viewer: Viewer,
  machineId: string,
  deps: SlotSwapDeps = {},
): Promise<SlotSwapChoices> {
  const { db, writer } = await writerFor(viewer, deps);
  try {
    if (writer.via === "web") {
      const c = await webSlotChoicesFor(viewer, machineId);
      return { via: "web", slots: c.slots, goods: c.goods };
    }
    const machine = await machineFor(db, viewer.organization.id, machineId, deps);
    const slots = sortSlots((await writer.slots(machine.awishMachineId)).map(toSlot));
    let goods: AwishGoodSummary[];
    try {
      goods = await (deps.listGoods ?? defaultGoods)(viewer);
    } catch {
      goods = goodsInSlots(slots);
    }
    return {
      via: "api",
      slots,
      goods: [...goods].sort((a, b) => a.name.localeCompare(b.name, "sv")),
    };
  } finally {
    writer.close();
  }
}

async function apiPlan(
  viewer: Viewer,
  db: Db,
  writer: SlotWriter,
  raw: unknown,
  deps: SlotSwapDeps,
): Promise<{ machine: ControlledMachine; plan: SlotChangePlan; fingerprint: string }> {
  const input = slotChangeInputSchema.parse(raw);
  const machine = await machineFor(db, viewer.organization.id, input.machineId, deps);
  const slots = (await writer.slots(machine.awishMachineId)).map(toSlot);
  const slot = slots.find((s) => s.id === input.productId);
  if (!slot) throw new MachineControlError("Facket finns inte i automaten i Awish. Ladda om.");
  let goods: AwishGoodSummary[];
  try {
    goods = await (deps.listGoods ?? defaultGoods)(viewer);
  } catch {
    goods = goodsInSlots(slots);
  }
  const good = goods.find((g) => g.id === input.goodId);
  if (!good) throw new MachineControlError("Varan finns inte i Awish. Ladda om.");
  const plan = planSlotChange({ slot, good, count: input.count });
  return { machine, plan, fingerprint: planFingerprint(plan, { machineId: machine.id }) };
}

export async function previewSlotSwapFor(
  viewer: Viewer,
  raw: unknown,
  deps: SlotSwapDeps = {},
): Promise<ControlPreview & { via: "api" | "web"; unchanged: boolean }> {
  const { db, writer } = await writerFor(viewer, deps);
  try {
    const p =
      writer.via === "web"
        ? await previewSlotChangeFor(viewer, raw)
        : await (async () => {
            const { plan, fingerprint } = await apiPlan(viewer, db, writer, raw, deps);
            return { ...plan, fingerprint };
          })();
    return {
      via: writer.via,
      lines: p.lines,
      warnings: p.warnings,
      blocking: p.blocking,
      confirm: p.confirm,
      unchanged: p.unchanged,
      typed: null,
      fingerprint: p.fingerprint,
      idempotencyKey: crypto.randomUUID(),
    };
  } finally {
    writer.close();
  }
}

export async function applySlotSwapFor(
  viewer: Viewer,
  raw: unknown,
  confirm: { fingerprint: string; idempotencyKey: unknown; confirmed: boolean },
  deps: SlotSwapDeps = {},
): Promise<ControlOutcome> {
  const idempotencyKey = idempotencyKeyOf(confirm.idempotencyKey);
  const { db, writer } = await writerFor(viewer, deps);
  try {
    if (writer.via === "web") {
      // Webbpanelen som i dag (lås per organisation, kontroll efteråt).
      const r = await applySlotChangeFor(viewer, raw, confirm.fingerprint, confirm.confirmed);
      return { ok: true, message: r.message, replayed: false };
    }
    return await withAwishWriteLock(db, viewer.organization.id, async () => {
      const { machine, plan, fingerprint } = await apiPlan(viewer, db, writer, raw, deps);
      if (plan.blocking) throw new MachineControlError(plan.blocking);
      if (fingerprint !== confirm.fingerprint) throw new MachineControlError(STALE_MESSAGE);
      if (plan.unchanged)
        return {
          ok: true as const,
          message: `${plan.slotName} har redan ${plan.to.goodName} ${plan.to.count} st.`,
          replayed: false,
        };
      if (plan.confirm && !confirm.confirmed)
        throw new MachineControlError(`Bekräfta först: ${plan.confirm}`);

      const run = deps.run ?? runControlAction;
      const r = await run(
        viewer,
        {
          kind: "slot_update",
          machineId: machine.id,
          targetId: String(plan.productId),
          idempotencyKey,
          auditRequest: {
            productId: plan.productId,
            from: plan.from,
            to: { goodId: plan.to.goodId, count: plan.to.count },
          },
        },
        async () => {
          await writer.setSlot(plan.productId, {
            goodId: plan.to.goodId,
            status: plan.status,
            currentInventory: plan.to.count,
          });
          // Skrivningen är gjord. En läsning som släpar efter gör den inte misslyckad.
          let shows = false;
          try {
            const after = (await writer.slots(machine.awishMachineId)).find(
              (s) => s.id === plan.productId,
            );
            shows =
              !!after &&
              after.goodId === plan.to.goodId &&
              after.currentInventory === plan.to.count;
          } catch {
            shows = false;
          }
          return { shows };
        },
        deps,
      );
      return outcome(r, (v) =>
        v.shows
          ? `Klart! ${plan.slotName}: ${plan.to.goodName} ${plan.to.count} st.`
          : `Skickat. Awish visar inte ändringen i ${plan.slotName} än. Titta i Awish om en stund.`,
      );
    });
  } finally {
    writer.close();
  }
}
