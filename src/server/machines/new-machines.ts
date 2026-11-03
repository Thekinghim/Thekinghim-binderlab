/**
 * Nya automater från Awish och guiden "Ny butik" (./plan.ts har reglerna).
 *
 * En automat som Awish-synken hittat men som inte är kopplad (source_machines.machine_id
 * null, datakällan inte arkiverad) visas på Att göra som "Ny automat hittad" tills den
 * kopplas eller markeras "Inte vår" (todo_dismissals, nyckel new-machine:<id>).
 *
 * Koppla (ett klick): i en transaktion skapas automaten (kod och namn föreslås), dess
 * placering i butiken från första orderns dag, och källautomaten kopplas. Databasens
 * trigger ger då orderna automaten (och lagerhändelserna); nästa Awish-synk läser facken.
 *
 * Guiden: butik, avtal och (valfritt) automat i samma transaktion, så att inget halvt
 * blir kvar om något steg inte går igenom.
 *
 * Bara ägare och admin. Allt körs som användaren under RLS; triggarna loggar ändringarna.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { nextMachineCode } from "@/app/(app)/automater/_lib/model";
import { newAgreementSchema, storeSchema } from "@/app/(app)/butiker/_lib/validation";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { isIsoDate, type IsoDate } from "@/domain";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

import {
  agreementFields,
  connectSchema,
  guideSchema,
  IGNORED_FINGERPRINT,
  ignoreSchema,
  machineName,
  newMachineKey,
  startDate,
} from "./plan";

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

export const NEW_MACHINE_MESSAGES = {
  forbidden: "Bara ägare och admin kan koppla automater.",
  gone: "Automaten är redan kopplad eller finns inte. Ladda om sidan.",
  store: "Butiken finns inte eller är arkiverad.",
  taken: "Det finns redan en automat med den koden.",
} as const;

/** En automat som Awish hittat men som inte är kopplad. */
export interface NewMachine {
  /** source_machines.id */
  readonly id: string;
  readonly name: string;
  readonly deviceNo: string | null;
  readonly sourceName: string;
  /** Order som väntar på automaten. */
  readonly orders: number;
  readonly firstOrderDate: IsoDate | null;
  readonly lastOrderAt: string | null;
  /** Föreslagen kod (BL-004). */
  readonly suggestedCode: string;
}

export interface NewMachinesState {
  readonly machines: NewMachine[];
  readonly stores: { id: string; name: string }[];
}

class UserError extends Error {}

function failure(error: unknown, context: string): { ok: false; error: string } {
  if (error instanceof UserError) return { ok: false, error: error.message };
  if (error instanceof AuthorizationError) {
    return { ok: false, error: NEW_MACHINE_MESSAGES.forbidden };
  }
  const pg = pgErrorOf(error);
  if (pg?.code === "23505" && /machines/.test(pg.message)) {
    return { ok: false, error: NEW_MACHINE_MESSAGES.taken };
  }
  if (pg?.code === "23514" && /split_share_check/.test(pg.message)) {
    return { ok: false, error: "Vinstdelningen behöver en andel." };
  }
  if (!pg || !/^BL0\d\d$/.test(pg.code)) console.error(`[nya automater] ${context}`, error);
  return { ok: false, error: dbErrorMessage(error, "Det gick inte att spara. Försök igen.") };
}

async function isOperator(viewer: Viewer): Promise<boolean> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) return false;
    throw error;
  }
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function dateOrNull(v: unknown): IsoDate | null {
  if (v === null || v === undefined) return null;
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  return isIsoDate(s) ? s : null;
}

/** Källautomater utan automat (inte "Inte vår"), flest väntande order först. */
export async function queryNewMachines(
  tx: Tx,
  orgId: string,
): Promise<Omit<NewMachine, "suggestedCode">[]> {
  const rows = await query(
    tx,
    sql`select sm.id, sm.external_name, sm.external_device_no, ds.name as source_name,
               count(o.id)::int as orders, min(o.business_date)::text as first_date,
               max(o.ordered_at) as last_at
        from public.source_machines sm
        join public.data_sources ds
          on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
        left join public.orders o
          on o.organization_id = sm.organization_id and o.source_machine_id = sm.id
         and o.machine_id is null
        where sm.organization_id = ${orgId}::uuid and sm.machine_id is null
          and ds.archived_at is null
          and not exists (
            select 1 from public.todo_dismissals d
            where d.organization_id = sm.organization_id
              and d.todo_key = 'new-machine:' || sm.id::text
          )
        group by sm.id, ds.name
        order by count(o.id) desc, sm.external_name nulls last, sm.id`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    name:
      String(r.external_name ?? "").trim() ||
      `Automat ${String(r.external_device_no ?? "")}`.trim(),
    deviceNo: r.external_device_no === null ? null : String(r.external_device_no),
    sourceName: String(r.source_name ?? ""),
    orders: Number(r.orders ?? 0),
    firstOrderDate: dateOrNull(r.first_date),
    lastOrderAt: isoOrNull(r.last_at),
  }));
}

async function machineCodes(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await query<{ code: string }>(
    tx,
    sql`select code from public.machines where organization_id = ${orgId}::uuid`,
  );
  return rows.map((r) => r.code);
}

/**
 * Hittade automater och butikerna att välja bland. Tom för roller som inte får koppla
 * (läsare, påfyllare), så att Att göra inte visar något de inte kan göra.
 */
export async function loadNewMachinesFor(viewer: Viewer): Promise<NewMachinesState> {
  if (!(await isOperator(viewer))) return { machines: [], stores: [] };
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    const found = await queryNewMachines(tx, orgId);
    if (found.length === 0) return { machines: [], stores: [] };
    const codes = await machineCodes(tx, orgId);
    const machines: NewMachine[] = [];
    for (const m of found) {
      const existing = await existingMachineFor(tx, orgId, m.deviceNo);
      if (existing) {
        machines.push({ ...m, suggestedCode: existing.code });
        continue;
      }
      const code = nextMachineCode(codes);
      codes.push(code);
      machines.push({ ...m, suggestedCode: code });
    }
    const stores = await query<{ id: string; name: string }>(
      tx,
      sql`select id, name from public.stores
          where organization_id = ${orgId}::uuid and archived_at is null
          order by name`,
    );
    return { machines, stores };
  });
}

/** Den del som både "Koppla" och guiden gör: automat, placering och koppling. */
async function connectInTx(
  tx: Tx,
  orgId: string,
  today: IsoDate,
  input: { sourceMachineId: string; storeId: string; code: string | null; name: string | null },
): Promise<{ machineId: string; code: string; orders: number; from: IsoDate }> {
  const [source] = await query<{
    external_name: string | null;
    external_device_no: string | null;
  }>(
    tx,
    sql`select sm.external_name, sm.external_device_no
        from public.source_machines sm
        join public.data_sources ds
          on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
        where sm.organization_id = ${orgId}::uuid and sm.id = ${input.sourceMachineId}::uuid
          and sm.machine_id is null and ds.archived_at is null
        for update of sm`,
  );
  if (!source) throw new UserError(NEW_MACHINE_MESSAGES.gone);
  const [store] = await query<{ id: string }>(
    tx,
    sql`select id from public.stores
        where organization_id = ${orgId}::uuid and id = ${input.storeId}::uuid
          and archived_at is null`,
  );
  if (!store) throw new UserError(NEW_MACHINE_MESSAGES.store);
  const [pending] = await query<{ n: number; first: string | null }>(
    tx,
    sql`select count(*)::int as n, min(business_date)::text as first
        from public.orders
        where organization_id = ${orgId}::uuid and source_machine_id = ${input.sourceMachineId}::uuid
          and machine_id is null`,
  );
  const from = startDate(pending?.first ?? null, today);
  // Finns automaten redan i appen (samma maskinnummer, inte kopplad till Awish) kopplas
  // den i stället, så att ett klick aldrig skapar en dubblett.
  const existing = await existingMachineFor(tx, orgId, source.external_device_no);
  if (existing) {
    const open = await query(
      tx,
      sql`select 1 from public.machine_placements
          where organization_id = ${orgId}::uuid and machine_id = ${existing.id}::uuid
            and valid_to is null`,
    );
    if (open.length === 0) {
      await tx.insert(s.machinePlacements).values({
        organizationId: orgId,
        machineId: existing.id,
        storeId: input.storeId,
        validFrom: from,
      });
    }
    await linkSource(tx, orgId, input.sourceMachineId, existing.id);
    return { machineId: existing.id, code: existing.code, orders: Number(pending?.n ?? 0), from };
  }
  const codes = await machineCodes(tx, orgId);
  const code = input.code ?? nextMachineCode(codes);
  if (codes.includes(code)) throw new UserError(`Det finns redan en automat med koden ${code}.`);
  const [machine] = await tx
    .insert(s.machines)
    .values({
      organizationId: orgId,
      code,
      name: machineName(
        input.name,
        { name: source.external_name, deviceNo: source.external_device_no },
        code,
      ),
      serial: source.external_device_no?.trim().slice(0, 100) || null,
      activeFrom: from,
    })
    .returning({ id: s.machines.id });
  if (!machine) throw new UserError("Automaten kunde inte sparas.");
  await tx.insert(s.machinePlacements).values({
    organizationId: orgId,
    machineId: machine.id,
    storeId: input.storeId,
    validFrom: from,
  });
  await linkSource(tx, orgId, input.sourceMachineId, machine.id);
  return { machineId: machine.id, code, orders: Number(pending?.n ?? 0), from };
}

async function linkSource(
  tx: Tx,
  orgId: string,
  sourceMachineId: string,
  machineId: string,
): Promise<void> {
  const updated = await query(
    tx,
    sql`update public.source_machines set machine_id = ${machineId}::uuid
        where organization_id = ${orgId}::uuid and id = ${sourceMachineId}::uuid
          and machine_id is null
        returning id`,
  );
  if (updated.length === 0) throw new UserError(NEW_MACHINE_MESSAGES.gone);
}

/**
 * En automat i appen med samma maskinnummer (serienummer) som Awish-automaten, som inte är
 * arkiverad och inte redan kopplad till en källautomat. Null om ingen (eller flera) finns.
 */
async function existingMachineFor(
  tx: Tx,
  orgId: string,
  deviceNo: string | null,
): Promise<{ id: string; code: string } | null> {
  const no = deviceNo?.trim();
  if (!no) return null;
  const rows = await query<{ id: string; code: string }>(
    tx,
    sql`select m.id, m.code from public.machines m
        where m.organization_id = ${orgId}::uuid and m.archived_at is null
          and lower(btrim(m.serial)) = lower(${no})
          and not exists (
            select 1 from public.source_machines sm
            where sm.organization_id = m.organization_id and sm.machine_id = m.id
          )
        limit 2`,
  );
  return rows.length === 1 ? (rows[0] as { id: string; code: string }) : null;
}

/** "Koppla": automaten Awish hittat blir en automat i butiken. */
export async function connectNewMachineFor(
  viewer: Viewer,
  raw: unknown,
  today?: IsoDate,
): Promise<ActionResult<{ machineId: string; code: string; orders: number }>> {
  if (!(await isOperator(viewer))) return { ok: false, error: NEW_MACHINE_MESSAGES.forbidden };
  const parsed = connectSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Kontrollera uppgifterna." };
  }
  const orgId = viewer.organization.id;
  const day = today ?? businessToday(new Date(), viewer.organization.timezone);
  try {
    const data = await withUserDbFor(viewer.user, (tx) => connectInTx(tx, orgId, day, parsed.data));
    return { ok: true, data: { machineId: data.machineId, code: data.code, orders: data.orders } };
  } catch (error) {
    return failure(error, "connect");
  }
}

/** "Inte vår": automaten visas inte längre på Att göra (kan ångras). */
export async function ignoreNewMachineFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  if (!(await isOperator(viewer))) return { ok: false, error: NEW_MACHINE_MESSAGES.forbidden };
  const parsed = ignoreSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Ogiltigt id." };
  const orgId = viewer.organization.id;
  try {
    await withUserDbFor(viewer.user, async (tx) => {
      const [found] = await query(
        tx,
        sql`select 1 from public.source_machines
            where organization_id = ${orgId}::uuid and id = ${parsed.data.sourceMachineId}::uuid
              and machine_id is null`,
      );
      if (!found) throw new UserError(NEW_MACHINE_MESSAGES.gone);
      await tx.execute(
        sql`insert into public.todo_dismissals (organization_id, todo_key, fingerprint, dismissed_by)
            values (${orgId}::uuid, ${newMachineKey(parsed.data.sourceMachineId)},
                    ${IGNORED_FINGERPRINT}, ${viewer.user.userId}::uuid)
            on conflict (organization_id, todo_key)
              do update set fingerprint = excluded.fingerprint, dismissed_by = excluded.dismissed_by`,
      );
    });
    return { ok: true };
  } catch (error) {
    return failure(error, "ignore");
  }
}

/** Ångra "Inte vår". */
export async function unignoreNewMachineFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  if (!(await isOperator(viewer))) return { ok: false, error: NEW_MACHINE_MESSAGES.forbidden };
  const parsed = ignoreSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Ogiltigt id." };
  const orgId = viewer.organization.id;
  try {
    await withUserDbFor(viewer.user, (tx) =>
      tx.execute(
        sql`delete from public.todo_dismissals
            where organization_id = ${orgId}::uuid
              and todo_key = ${newMachineKey(parsed.data.sourceMachineId)}`,
      ),
    );
    return { ok: true };
  } catch (error) {
    return failure(error, "unignore");
  }
}

/**
 * Guiden "Ny butik": butik → avtal → automat (Awish eller ny) i en transaktion. Avtalet
 * gäller från automatens första dag (första ordern), annars från i dag.
 */
export async function createStoreGuideFor(
  viewer: Viewer,
  raw: unknown,
  today?: IsoDate,
): Promise<ActionResult<{ storeId: string; machineCode: string | null }>> {
  if (!(await isOperator(viewer)))
    return { ok: false, error: "Bara ägare och admin kan lägga till butiker." };
  const parsed = guideSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Kontrollera uppgifterna." };
  }
  const input = parsed.data;
  const store = storeSchema.safeParse({
    name: input.store.name,
    address: input.store.address,
    city: input.store.city,
  });
  if (!store.success) {
    return { ok: false, error: store.error.issues[0]?.message ?? "Kontrollera butiken." };
  }
  const orgId = viewer.organization.id;
  const day = today ?? businessToday(new Date(), viewer.organization.timezone);
  // Villkoren valideras med avtalets schema (samma regler som "Nytt avtal").
  const terms = newAgreementSchema.safeParse({
    storeId: randomUUID(),
    validFrom: day,
    ...agreementFields(input.terms),
  });
  if (!terms.success) {
    return { ok: false, error: terms.error.issues[0]?.message ?? "Kontrollera villkoren." };
  }
  const t = terms.data;
  const machine = input.machine;
  try {
    const data = await withUserDbFor(viewer.user, async (tx) => {
      const [row] = await tx
        .insert(s.stores)
        .values({
          organizationId: orgId,
          name: store.data.name,
          address: store.data.address,
          city: store.data.city,
        })
        .returning({ id: s.stores.id });
      const storeId = row!.id;
      let machineCode: string | null = null;
      let from: IsoDate = day;
      if (machine?.kind === "awish") {
        const c = await connectInTx(tx, orgId, day, {
          sourceMachineId: machine.sourceMachineId,
          storeId,
          code: null,
          name: null,
        });
        machineCode = c.code;
        from = c.from;
      } else if (machine?.kind === "new") {
        const codes = await machineCodes(tx, orgId);
        const code = machine.code ?? nextMachineCode(codes);
        if (codes.includes(code)) {
          throw new UserError(`Det finns redan en automat med koden ${code}.`);
        }
        const [m] = await tx
          .insert(s.machines)
          .values({
            organizationId: orgId,
            code,
            name: machineName(machine.name, { name: null, deviceNo: null }, code),
            activeFrom: day,
          })
          .returning({ id: s.machines.id });
        await tx.insert(s.machinePlacements).values({
          organizationId: orgId,
          machineId: m!.id,
          storeId,
          validFrom: day,
        });
        machineCode = code;
      }
      await tx.insert(s.storeAgreements).values({
        organizationId: orgId,
        storeId,
        validFrom: from,
        validTo: null,
        commissionBp: t.commissionBp,
        monthlyRentOre: t.monthlyRentOre,
        commissionBase: t.commissionBase,
        vmbBeforeSplit: false,
        note: null,
      });
      return { storeId, machineCode };
    });
    return { ok: true, data };
  } catch (error) {
    return failure(error, "guide");
  }
}
