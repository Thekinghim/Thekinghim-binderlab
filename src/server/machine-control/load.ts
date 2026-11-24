/**
 * Data till sidan Styr automaten (/automater/<kod>/styr). Bara ägare och admin (andra får
 * null → 404). En demo läser aldrig Awish. Läsningarna mot Awish görs nu, var för sig, så
 * att ett fel i en av dem inte tar ner hela sidan.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getRoleFor, withUserDbFor } from "@/server/access";
import { AwishApiError } from "@/server/awish/grpc-client";
import { controlClientFor, awishMachineIdFor } from "@/server/awish/control/connect";
import {
  newIdempotencyKey,
  recentActionsFor,
  type AuditRow,
  type AwishActionKind,
} from "@/server/awish/control/guard";
import type { AwishMachineConfig } from "@/server/awish/control/types";
import { AwishNotConnectedError } from "@/server/awish/marketing";
import type { Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { isDemoOrganization } from "@/server/demo/guard";
import { safeErrorForLog } from "@/server/errors";

import { dbOf, MachineControlError, slotName, type MachineControlDeps } from "./common";
import { savedScheduleFor, storeHoursFor } from "./power-schedule";

export interface StyrMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface StyrSlot {
  readonly id: string;
  readonly name: string;
  readonly goodName: string | null;
  readonly count: number;
  readonly capacity: number;
  /** Kanalen har motoruppgifter (krävs för Mata ut). */
  readonly canShip: boolean;
  readonly fault: string | null;
}

export interface StyrLogRow {
  readonly id: string;
  readonly at: string;
  readonly who: string;
  readonly what: string;
  readonly status: "ok" | "failed" | "unknown" | "pending" | "blocked";
}

export type StyrPageData =
  | { kind: "demo"; machine: StyrMachine }
  | { kind: "not_linked"; machine: StyrMachine }
  | {
      kind: "ready";
      machine: StyrMachine;
      orgTimezone: string;
      /** null = Awish gick inte att läsa (meddelandet i `errors`). */
      online: boolean | null;
      lastSeenAt: string | null;
      versionBlocked: boolean;
      version: string | null;
      signFailed: boolean;
      slotVia: "web" | "api" | "api_then_web";
      config: AwishMachineConfig | null;
      slots: StyrSlot[];
      merchantTimezone: string | null;
      store: { storeName: string; on: string; off: string } | null;
      saved: Awaited<ReturnType<typeof savedScheduleFor>>;
      log: StyrLogRow[];
      errors: string[];
      /** Idempotensnycklar för knappar utan förhandsvisning (en per sidvisning). */
      keys: { reboot: string; shutdown: string };
    };

const KIND_TEXT: Partial<Record<AwishActionKind, string>> = {
  reboot: "Starta om",
  shutdown: "Stäng av",
  power_schedule_set: "Strömschema",
  power_schedule_clear: "Ta bort schema",
  shipment: "Mata ut",
  machine_config: "Skärm och reklam",
  slot_update: "Byt pack",
  replenish: "Fyll fullt",
  refill_push_api: "Påfyllning",
};

/** Svenskt fel för sidan; aldrig Awishs egen text. */
export function readError(error: unknown): string {
  if (error instanceof MachineControlError || error instanceof AwishNotConnectedError)
    return error.message;
  if (error instanceof AwishApiError) return error.message;
  return "Awish svarar inte just nu. Försök igen om en stund.";
}

export function logRows(rows: readonly AuditRow[]): StyrLogRow[] {
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    who: r.actorName ?? "Okänd",
    what: (KIND_TEXT[r.kind] ?? r.kind) + (r.reason ? ` · ${r.reason}` : ""),
    status: r.status,
  }));
}

/** Automaten med koden (under RLS), eller null. */
async function machineByCode(viewer: Viewer, code: string): Promise<StyrMachine | null> {
  return withUserDbFor(viewer.user, async (tx) => {
    const [row] = Array.from(
      await tx.execute(
        sql`select id::text as id, code, name from public.machines
            where organization_id = ${viewer.organization.id}::uuid
              and lower(code) = lower(${code}) and archived_at is null
            limit 1`,
      ),
    ) as { id: string; code: string; name: string }[];
    return row ?? null;
  });
}

export async function loadStyrPage(
  viewer: Viewer,
  code: string,
  deps: MachineControlDeps = {},
): Promise<StyrPageData | null> {
  const role = await getRoleFor(viewer.user, viewer.organization.id);
  if (!role || !(OPERATOR_ROLES as readonly string[]).includes(role)) return null;
  const machine = await machineByCode(viewer, code);
  if (!machine) return null;

  const db = dbOf(deps);
  const orgId = viewer.organization.id;
  if (await isDemoOrganization(db, orgId)) return { kind: "demo", machine };
  const awishId = await (deps.awishIdFor ?? awishMachineIdFor)(db, orgId, machine.id);
  if (!awishId) return { kind: "not_linked", machine };

  const now = deps.now?.() ?? new Date();
  const errors: string[] = [];
  const keep = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((error: unknown) => {
      console.error("[styr]", safeErrorForLog(error));
      const msg = readError(error);
      if (!errors.includes(msg)) errors.push(msg);
      return fallback;
    });

  const [seen, store, saved, log] = await Promise.all([
    db.execute(
      sql`select awish_online, awish_seen_at from public.source_machines
          where organization_id = ${orgId}::uuid and machine_id = ${machine.id}::uuid
          order by awish_seen_at desc nulls last limit 1`,
    ),
    storeHoursFor(db, orgId, machine.id, now),
    savedScheduleFor(db, orgId, machine.id),
    recentActionsFor(viewer, { machineId: machine.id, limit: 20 }).catch((error: unknown) => {
      console.error("[styr] logg", safeErrorForLog(error));
      return [] as AuditRow[];
    }),
  ]);
  const seenRow = (Array.from(seen)[0] ?? {}) as {
    awish_online?: boolean | null;
    awish_seen_at?: Date | string | null;
  };

  let base: Omit<
    Extract<StyrPageData, { kind: "ready" }>,
    "kind" | "machine" | "store" | "saved" | "log" | "errors" | "keys" | "orgTimezone"
  > = {
    online: null,
    lastSeenAt: seenRow.awish_seen_at ? new Date(seenRow.awish_seen_at).toISOString() : null,
    versionBlocked: false,
    version: null,
    signFailed: false,
    slotVia: "web",
    config: null,
    slots: [],
    merchantTimezone: null,
  };

  try {
    const { api, state } = await (deps.client ?? controlClientFor)(db, orgId, deps);
    try {
      const [detail, products, merchant] = await Promise.all([
        keep(api.machineDetail(awishId), null),
        keep(api.productDetails(awishId), []),
        keep(api.merchantDetail(), null),
      ]);
      base = {
        ...base,
        online: detail ? detail.isOnline : null,
        version: state.version,
        versionBlocked:
          state.versionChangedAt !== null &&
          (state.versionAcknowledgedAt === null ||
            state.versionAcknowledgedAt < state.versionChangedAt),
        signFailed: state.signStatus === "failed",
        slotVia: state.slotWritesVia,
        config: detail?.config ?? null,
        merchantTimezone: merchant?.timezone ?? null,
        slots: [...products]
          .sort(
            (a, b) =>
              (a.channel?.name ?? "").localeCompare(b.channel?.name ?? "", "sv", {
                numeric: true,
              }) || a.id.localeCompare(b.id, "sv", { numeric: true }),
          )
          .map((p) => ({
            id: p.id,
            name: slotName(p.channel?.name, p.id).replace(/^Fack /, ""),
            goodName: p.goodName,
            count: p.currentInventory,
            capacity: p.capacity,
            canShip: Boolean(p.channel?.addr && p.channel.motorId),
            fault: p.floorStatus && p.floorStatus !== "ERR_NORMAL" ? p.floorStatus : null,
          })),
      };
    } finally {
      api.close();
    }
  } catch (error) {
    console.error("[styr]", safeErrorForLog(error));
    errors.push(readError(error));
  }

  return {
    kind: "ready",
    machine,
    orgTimezone: viewer.organization.timezone,
    ...base,
    store,
    saved,
    log: logRows(log),
    errors,
    keys: {
      reboot: newIdempotencyKey(),
      shutdown: newIdempotencyKey(),
    },
  };
}
