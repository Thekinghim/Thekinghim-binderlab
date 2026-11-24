/**
 * Plan B för påfyllningen: samma sak som pushMachinesToAwish (web-service.ts) men via
 * Awishs gRPC-API (Products + UpdateProduct, signerat) i stället för webbpanelen.
 *
 * Samma regler: planen kommer från den rena planAwishPush (vi höjer bara, aldrig ner),
 * samma resultat (WebPushResult) och samma loggar (automation_log och väntande automater).
 * Varje automat får en rad i awish_actions (refill_push_api) med utfallet. Ingen
 * användare väntar på svaret här, så det är systemet som står som utförare.
 *
 * Används bara när organisationen har valt API under Datakällor (slot_writes_via) OCH
 * signeringen är testad (sign_status 'ok'); annars används webbpanelen (refill-push.ts).
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import { isDemoOrganization } from "@/server/demo/guard";
import { logAwishPushOutcomes, logAwishPushes, pendingAwishPushes } from "@/server/varde/log";

import { AwishApiError } from "../grpc-client";
import { AwishNotConnectedError } from "../marketing";
import type { AwishWebProduct } from "../web-client";
import type { MachinePushResult, WebPushResult } from "../web-service";
import { planAwishPush, type MachineTitleQuantity } from "../web-push";
import { apiFor, awishMachineIdFor, controlContextFor, type ControlDeps } from "./connect";
import { AwishUnknownOutcomeError, controlErrorMessage, isSignError } from "./errors";
import { updateApiState } from "./state";
import type { AwishProductDetail } from "./types";

export interface ApiPushDeps extends ControlDeps {
  serviceDb?: Db;
  withPending?: boolean;
  dryRun?: boolean;
}

/** WebPushResult plus automaterna där utfallet är okänt (ska inte provas via webben). */
export interface ApiPushResult extends WebPushResult {
  unknownMachineIds: string[];
}

type Row = Record<string, unknown>;

async function query<T extends Row>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute(q)) as T[];
}

/** Ett fack ur API:t i webbpanelens form (det planAwishPush tar). */
export function productToWebProduct(p: AwishProductDetail): AwishWebProduct {
  const total = p.channel?.total ?? 0;
  const capacity = p.capacity > 0 ? p.capacity : total > 0 ? total : null;
  return {
    id: Number(p.id),
    goodId: p.goodId !== null && /^\d+$/.test(p.goodId) ? Number(p.goodId) : null,
    goodName: p.goodName,
    status: p.status,
    currentInventory: p.currentInventory,
    capacity,
    channelName: p.channel?.name ? p.channel.name : null,
  };
}

/** Binderlabs antal per titel i automaten (samma fråga som webbvägen). */
async function machineTitleStock(
  db: Db,
  organizationId: string,
  machineId: string,
): Promise<MachineTitleQuantity[]> {
  const rows = await query<{ title_name: string; quantity: number; mystery: boolean | null }>(
    db,
    sql`select t.name as title_name, l.quantity,
               (t.own_product and exists (
                  select 1 from public.mystery_recipes r
                  where r.organization_id = t.organization_id and r.title_id = t.id)) as mystery
        from public.stock_locations loc
        join public.stock_levels l
          on l.organization_id = loc.organization_id and l.location_id = loc.id
        join public.titles t on t.organization_id = l.organization_id and t.id = l.title_id
        where loc.organization_id = ${organizationId}::uuid
          and loc.machine_id = ${machineId}::uuid
          and loc.kind = 'machine'
          and l.last_counted_at is not null
          and t.archived_at is null`,
  );
  return rows.map((r) => ({
    titleName: r.title_name,
    quantity: Number(r.quantity),
    ...(r.mystery === true ? { mystery: true } : {}),
  }));
}

async function machineCodes(
  db: Db,
  organizationId: string,
  machineIds: string[],
): Promise<Map<string, string | null>> {
  if (machineIds.length === 0) return new Map();
  const rows = await query<{ id: string; code: string | null }>(
    db,
    sql`select m.id::text as id, m.code from public.machines m
        where m.organization_id = ${organizationId}::uuid
          and m.id in (select jsonb_array_elements_text(${JSON.stringify(machineIds)}::jsonb)::uuid)`,
  );
  return new Map(rows.map((r) => [r.id, r.code]));
}

async function startAction(
  db: Db,
  orgId: string,
  machineId: string,
  awishMachineId: string,
  slots: number,
): Promise<string | null> {
  try {
    const [row] = await query<{ id: string }>(
      db,
      sql`insert into public.awish_actions
            (organization_id, actor_role, kind, machine_id, awish_machine_id, request,
             idempotency_key, status)
          values (${orgId}::uuid, 'system', 'refill_push_api', ${machineId}::uuid,
                  ${awishMachineId}, ${JSON.stringify({ slots })}::jsonb, ${randomUUID()},
                  'pending')
          returning id`,
    );
    return row?.id ?? null;
  } catch (error) {
    console.error(
      "[awish] kunde inte logga påfyllning via API",
      error instanceof Error ? error.name : "fel",
    );
    return null;
  }
}

async function finishAction(
  db: Db,
  orgId: string,
  id: string | null,
  status: "ok" | "failed" | "unknown",
  message: string | null,
  errorKind: string | null,
): Promise<void> {
  if (!id) return;
  await db
    .execute(
      sql`update public.awish_actions
          set status = ${status}, awish_message = ${message ? message.slice(0, 300) : null},
              error_kind = ${errorKind}, finished_at = now()
          where organization_id = ${orgId}::uuid and id = ${id}::uuid`,
    )
    .catch(() => undefined);
}

/**
 * Skickar automaternas lager till Awish via API:t. Samma kontrakt som pushMachinesToAwish.
 * En demo anropar aldrig Awish.
 */
export async function pushMachinesViaApi(
  organizationId: string,
  machineIds: readonly string[],
  deps: ApiPushDeps = {},
): Promise<ApiPushResult> {
  const db = deps.serviceDb ?? deps.db ?? getServiceDb();
  const off = (reason: WebPushResult["reason"]): ApiPushResult => ({
    status: "off",
    reason,
    machines: [],
    unknownMachineIds: [],
  });
  if (await isDemoOrganization(db, organizationId)) return off("disabled");
  if (((deps.env ?? process.env).AWISH_CONTROL_DISABLED ?? "").trim().toLowerCase() === "true") {
    return off("disabled");
  }
  const ids = [...new Set(machineIds)].filter(Boolean);
  if (deps.withPending && !deps.dryRun) {
    try {
      for (const id of (await pendingAwishPushes(db, organizationId)).keys()) {
        if (!ids.includes(id)) ids.push(id);
      }
    } catch (error) {
      console.error("Kunde inte läsa väntande Awish-sändningar.", error);
    }
  }
  if (ids.length === 0) return off("no_source");

  let ctx;
  try {
    ctx = await controlContextFor(db, organizationId, { ...deps, db });
  } catch (error) {
    if (error instanceof AwishNotConnectedError) return off("no_credentials");
    throw error;
  }
  if (ctx.state.signStatus !== "ok" || ctx.endpoint === null) return off("disabled");

  const codes = await machineCodes(db, organizationId, ids);
  const machines: MachinePushResult[] = [];
  const unknownMachineIds: string[] = [];
  const api = apiFor(ctx);
  try {
    for (const machineId of ids) {
      const code = codes.get(machineId) ?? null;
      const awishId = await awishMachineIdFor(db, organizationId, machineId);
      if (awishId == null) {
        machines.push({
          machineId,
          machineCode: code,
          status: "no_awish_machine",
          slotsUpdated: 0,
          titlesWithoutSlot: [],
        });
        continue;
      }
      let actionId: string | null = null;
      try {
        const want = await machineTitleStock(db, organizationId, machineId);
        const products = (await api.productDetails(awishId)).map(productToWebProduct);
        const plan = planAwishPush(want, products);
        if (deps.dryRun) {
          machines.push({
            machineId,
            machineCode: code,
            status: "nothing",
            slotsUpdated: 0,
            titlesWithoutSlot: plan.titlesWithoutSlot,
            slotsRead: products.length,
            planned: plan.updates.map((u) => ({
              titleName: u.titleName,
              productId: u.productId,
              from: u.previousInventory,
              to: u.currentInventory,
            })),
          });
          continue;
        }
        if (plan.updates.length > 0) {
          actionId = await startAction(db, organizationId, machineId, awishId, plan.updates.length);
        }
        let done = 0;
        for (const u of plan.updates) {
          // Planen höjer bara: currentInventory är aldrig lägre än fackets antal nu.
          await api.updateProduct({
            id: String(u.productId),
            ...(u.goodId !== null ? { goodId: String(u.goodId) } : {}),
            status: u.status,
            currentInventory: u.currentInventory,
          });
          done += 1;
        }
        await finishAction(db, organizationId, actionId, "ok", `${done} fack`, null);
        machines.push({
          machineId,
          machineCode: code,
          status: plan.updates.length > 0 ? "pushed" : "nothing",
          slotsUpdated: plan.updates.length,
          titlesWithoutSlot: plan.titlesWithoutSlot,
          ...(plan.notSent.length > 0 ? { notSent: plan.notSent } : {}),
        });
      } catch (error) {
        const unknown = error instanceof AwishUnknownOutcomeError;
        if (unknown) unknownMachineIds.push(machineId);
        await finishAction(
          db,
          organizationId,
          actionId,
          unknown ? "unknown" : "failed",
          error instanceof AwishApiError ? (error.technical ?? error.message) : null,
          error instanceof AwishApiError ? error.kind : "unexpected",
        );
        if (isSignError(error)) {
          await updateApiState(db, organizationId, ctx.sourceId, {
            signStatus: "failed",
            signCheckedAt: new Date(),
            signError: controlErrorMessage(error),
          }).catch(() => undefined);
        }
        machines.push({
          machineId,
          machineCode: code,
          status: "error",
          slotsUpdated: 0,
          titlesWithoutSlot: [],
          error: controlErrorMessage(error),
        });
      }
    }
  } finally {
    api.close();
  }

  if (!deps.dryRun) {
    await logAwishPushes(db, organizationId, machines);
    await logAwishPushOutcomes(
      db,
      organizationId,
      machines.map((m) => ((m.notSent?.length ?? 0) > 0 ? { ...m, status: "error" } : m)),
    );
  }
  return { status: "done", machines, unknownMachineIds };
}
