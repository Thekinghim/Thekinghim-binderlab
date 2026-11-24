/**
 * Strömschema per automat (Awish SetPowerSchedule / ClearPowerSchedule). Förifylls från
 * butikens tider (stores.power_on_time / power_off_time). Tiderna skickas som HH:MM:00 med
 * veckodagarna mån..sön som 1/0. Awish räknar tiden i kontots tidszon, så schemat spärras
 * när den inte är organisationens eller när Awish inte uppger någon. Resultatet sparas i machine_power_schedules.
 *
 * Ett schema kan stänga av automaten. Ligger avstängningen inom 15 minuter (eller är
 * automaten avstängd enligt schemat just nu) krävs samma sak som för Stäng av: automatens
 * kod skrivs. Ett obekräftat versionsbyte hos Awish stoppar schemat (spärren).
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db/client";
import { runControlAction } from "@/server/awish/control/guard";
import type { Weekdays } from "@/server/awish/control/types";
import type { Viewer } from "@/server/data/core/loaders";
import { pgErrorOf, safeErrorForLog } from "@/server/errors";

import {
  dbOf,
  idempotencyKeyOf,
  machineFor,
  MachineControlError,
  outcome,
  preview,
  requireOperator,
  STALE_MESSAGE,
  typedMatches,
  withReadClient,
  type ControlOutcome,
  type ControlPreview,
  type MachineControlDeps,
} from "./common";
import { CLEAR_SCHEDULE_TEXT } from "./texts";

export const DAY_LABELS = ["mån", "tis", "ons", "tor", "fre", "lör", "sön"] as const;
export const ALL_DAYS = "1111111";
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const powerScheduleInputSchema = z
  .object({
    machineId: z.uuid("Välj automat."),
    days: z
      .string()
      .regex(/^[01]{7}$/, "Välj dagar.")
      .refine((d) => d.includes("1"), "Välj minst en dag."),
    on: z.string().regex(TIME, "Skriv en tid som 10:00."),
    off: z.string().regex(TIME, "Skriv en tid som 21:00."),
  })
  .refine((v) => v.on !== v.off, { message: "På och Av kan inte vara samma tid.", path: ["off"] });
export type PowerScheduleInput = z.output<typeof powerScheduleInputSchema>;

/** "1111100" → [1,1,1,1,1,0,0]. */
export function weekdaysOf(days: string): Weekdays {
  if (!/^[01]{7}$/.test(days)) throw new MachineControlError("Välj dagar.");
  return days.split("").map((c) => (c === "1" ? 1 : 0)) as unknown as Weekdays;
}

/** "mån–sön", "mån–fre", "lör–sön" eller "mån, ons, fre". */
export function daysText(days: string): string {
  const on = days
    .split("")
    .map((c, i) => (c === "1" ? i : -1))
    .filter((i) => i >= 0);
  if (on.length === 0) return "inga dagar";
  if (on.length === 1) return DAY_LABELS[on[0]!]!;
  const contiguous = on.every((d, i) => i === 0 || d === on[i - 1]! + 1);
  if (contiguous && on.length >= 3) return `${DAY_LABELS[on[0]!]}–${DAY_LABELS[on.at(-1)!]}`;
  return on.map((d) => DAY_LABELS[d]).join(", ");
}

/** "10:00" → "10:00:00" (Awish vill ha %H:%M:%S). */
export function toAwishTime(hhmm: string): string {
  if (!TIME.test(hhmm)) throw new MachineControlError("Skriv en tid som 10:00.");
  return `${hhmm}:00`;
}

/** Butikens tider ("10:00"–"21:00"), om båda finns, är giltiga och olika. */
export function storePrefill(
  on: string | null | undefined,
  off: string | null | undefined,
): { days: string; on: string; off: string } | null {
  const a = normalizeTime(on);
  const b = normalizeTime(off);
  if (!a || !b || a === b) return null;
  return { days: ALL_DAYS, on: a, off: b };
}

/** "9:00", "09:00" eller "09:00:00" → "09:00"; annars null. */
export function normalizeTime(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((raw ?? "").trim());
  if (!m) return null;
  const t = `${m[1]!.padStart(2, "0")}:${m[2]}`;
  return TIME.test(t) ? t : null;
}

/**
 * Spärr när Awish-kontot räknar tid i en annan tidszon än organisationen, eller inte uppger
 * någon (då kan Awish räkna i sin standard, t.ex. Asia/Shanghai, och stänga av mitt på dagen).
 */
export function timezoneBlock(merchantTz: string | null, orgTz: string): string | null {
  if (!merchantTz?.trim()) {
    return `Awish uppger ingen tidszon för kontot. Sätt ${orgTz} under Inställningar → Awish först.`;
  }
  if (merchantTz.trim().toLowerCase() === orgTz.trim().toLowerCase()) return null;
  return `Awish-kontot räknar tid i ${merchantTz}. Byt tidszon under Inställningar → Awish först.`;
}

export interface PowerSchedulePlan {
  readonly lines: string[];
  readonly warnings: string[];
  readonly blocking: string | null;
  readonly request: { weekdays: Weekdays; powerOn: string; powerOff: string };
  readonly source: "store" | "custom";
  /** Automaten är av enligt schemat nu, eller stängs av inom 15 minuter: koden ska skrivas. */
  readonly offSoon: boolean;
}

/** Minuter efter midnatt för "HH:MM". */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Är automaten på enligt schemat (dag 0 = måndag, minuter efter midnatt)? På mellan På och
 * Av de valda dagarna; Av efter midnatt räknas till dagen före. Övriga tider: av.
 */
export function scheduleIsOn(days: string, on: string, off: string, day: number, minute: number) {
  const onM = minutesOf(on);
  const offM = minutesOf(off);
  const selected = (d: number) => days[((d % 7) + 7) % 7] === "1";
  if (onM < offM) return selected(day) && minute >= onM && minute < offM;
  // Av efter midnatt: på från På den valda dagen till Av nästa morgon.
  return (selected(day) && minute >= onM) || (selected(day - 1) && minute < offM);
}

/** Klockan nu i tidszonen som (dag 0 = måndag, minuter efter midnatt). */
export function localDayMinute(now: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { day: day < 0 ? 0 : day, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

export const OFF_SOON_MINUTES = 15;

/** Av nu eller inom 15 minuter med det nya schemat? */
export function schedulePowersOffSoon(
  input: Pick<PowerScheduleInput, "days" | "on" | "off">,
  now: Date,
  timeZone: string,
): boolean {
  const { day, minute } = localDayMinute(now, timeZone);
  for (let m = 0; m <= OFF_SOON_MINUTES; m += 1) {
    const t = minute + m;
    if (!scheduleIsOn(input.days, input.on, input.off, day + Math.floor(t / 1440), t % 1440)) {
      return true;
    }
  }
  return false;
}

export function planPowerSchedule(args: {
  input: Pick<PowerScheduleInput, "days" | "on" | "off">;
  merchantTimezone: string | null;
  orgTimezone: string;
  store: { on: string; off: string } | null;
  /** Nu (för varningen om avstängning inom 15 minuter). Utan: ingen sådan kontroll. */
  now?: Date;
}): PowerSchedulePlan {
  const { input } = args;
  const tz = args.merchantTimezone ?? args.orgTimezone;
  const lines = [`Awish slår på ${input.on} och av ${input.off}, ${daysText(input.days)} (${tz}).`];
  const warnings: string[] = [];
  const offSoon = args.now ? schedulePowersOffSoon(input, args.now, tz) : false;
  if (offSoon) {
    warnings.push(
      `Med det här schemat stängs automaten av nu eller inom ${OFF_SOON_MINUTES} minuter och säljer inget förrän ${input.on}.`,
    );
  }
  if (input.off < input.on) warnings.push("Av efter midnatt: stängs av natten efter.");
  const fromStore =
    args.store !== null &&
    input.days === ALL_DAYS &&
    args.store.on === input.on &&
    args.store.off === input.off;
  return {
    lines,
    warnings,
    blocking: timezoneBlock(args.merchantTimezone, args.orgTimezone),
    request: {
      weekdays: weekdaysOf(input.days),
      powerOn: toAwishTime(input.on),
      powerOff: toAwishTime(input.off),
    },
    source: fromStore ? "store" : "custom",
    offSoon,
  };
}

// ---------------------------------------------------------------------------
// Tjänsten
// ---------------------------------------------------------------------------

/** Butikens tider där automaten står i dag (organisationens tidszon), eller null. */
export async function storeHoursFor(
  db: Db,
  orgId: string,
  machineId: string,
  now: Date,
): Promise<{ storeName: string; on: string; off: string } | null> {
  const [row] = Array.from(
    await db.execute(
      sql`select st.name, st.power_on_time, st.power_off_time
          from public.machine_placements mp
          join public.organizations o on o.id = mp.organization_id
          join public.stores st on st.organization_id = mp.organization_id and st.id = mp.store_id
          where mp.organization_id = ${orgId}::uuid and mp.machine_id = ${machineId}::uuid
            and mp.valid_from <= (${now.toISOString()}::timestamptz at time zone o.timezone)::date
            and (mp.valid_to is null
                 or mp.valid_to >= (${now.toISOString()}::timestamptz at time zone o.timezone)::date)
          order by mp.valid_from desc
          limit 1`,
    ),
  ) as { name: string; power_on_time: string | null; power_off_time: string | null }[];
  if (!row) return null;
  const p = storePrefill(row.power_on_time, row.power_off_time);
  return p ? { storeName: row.name, on: p.on, off: p.off } : null;
}

async function computePlan(
  viewer: Viewer,
  raw: unknown,
  deps: MachineControlDeps,
): Promise<{
  input: PowerScheduleInput;
  plan: PowerSchedulePlan;
  code: string;
  preview: ControlPreview;
}> {
  const input = powerScheduleInputSchema.parse(raw);
  return withReadClient(viewer, input.machineId, deps, async ({ api, machine, db }) => {
    const [merchant, store] = await Promise.all([
      api.merchantDetail(),
      storeHoursFor(db, viewer.organization.id, machine.id, deps.now?.() ?? new Date()),
    ]);
    const plan = planPowerSchedule({
      input,
      merchantTimezone: merchant.timezone,
      orgTimezone: viewer.organization.timezone,
      store,
      now: deps.now?.() ?? new Date(),
    });
    return {
      input,
      plan,
      code: machine.code,
      preview: preview(
        plan,
        { machineId: machine.id, req: plan.request },
        plan.offSoon ? machine.code : null,
      ),
    };
  });
}

export async function previewPowerScheduleFor(
  viewer: Viewer,
  raw: unknown,
  deps: MachineControlDeps = {},
): Promise<ControlPreview> {
  return (await computePlan(viewer, raw, deps)).preview;
}

/** Sparar vad som skickades (eller misslyckades). Ett fel här ändrar inte svaret. */
async function record(
  db: Db,
  a: {
    orgId: string;
    machineId: string;
    userId: string;
    status: "sent" | "failed" | "cleared";
    input?: PowerScheduleInput;
    source?: "store" | "custom";
    error: string | null;
    actionId: string | null;
  },
): Promise<void> {
  try {
    await write(db, a);
  } catch (error) {
    // Loggraden saknas (t.ex. blockerad före insättning): spara schemat utan koppling.
    if (pgErrorOf(error)?.code === "23503" && a.actionId) {
      try {
        await write(db, { ...a, actionId: null });
        return;
      } catch (again) {
        error = again;
      }
    }
    console.error("[strömschema] kunde inte spara", safeErrorForLog(error));
  }
}

async function write(db: Db, a: Parameters<typeof record>[1]): Promise<void> {
  if (a.input && a.source) {
    await db.execute(
      sql`insert into public.machine_power_schedules
              (organization_id, machine_id, weekdays, power_on, power_off, source, status,
               sent_at, sent_by, last_error, awish_action_id)
            values (${a.orgId}::uuid, ${a.machineId}::uuid, ${a.input.days}, ${a.input.on},
                    ${a.input.off}, ${a.source}, ${a.status}, now(), ${a.userId}::uuid,
                    ${a.error}, ${a.actionId}::uuid)
            on conflict (organization_id, machine_id) do update set
              weekdays = excluded.weekdays, power_on = excluded.power_on,
              power_off = excluded.power_off, source = excluded.source,
              status = excluded.status, sent_at = excluded.sent_at, sent_by = excluded.sent_by,
              last_error = excluded.last_error, awish_action_id = excluded.awish_action_id,
              updated_at = now()`,
    );
  } else {
    await db.execute(
      sql`update public.machine_power_schedules
            set status = ${a.status}, sent_at = now(), sent_by = ${a.userId}::uuid,
                last_error = ${a.error}, awish_action_id = ${a.actionId}::uuid, updated_at = now()
            where organization_id = ${a.orgId}::uuid and machine_id = ${a.machineId}::uuid`,
    );
  }
}

export async function applyPowerScheduleFor(
  viewer: Viewer,
  raw: unknown,
  confirm: { fingerprint: string; idempotencyKey: unknown; typed?: unknown },
  deps: MachineControlDeps = {},
): Promise<ControlOutcome> {
  const idempotencyKey = idempotencyKeyOf(confirm.idempotencyKey);
  const { input, plan, code, preview: now } = await computePlan(viewer, raw, deps);
  if (plan.blocking) throw new MachineControlError(plan.blocking);
  if (now.fingerprint !== confirm.fingerprint) throw new MachineControlError(STALE_MESSAGE);
  if (plan.offSoon && !typedMatches(confirm.typed, code)) {
    throw new MachineControlError(`Skriv ${code} för att skicka schemat.`);
  }
  const run = deps.run ?? runControlAction;
  const r = await run(
    viewer,
    {
      kind: "power_schedule_set",
      machineId: input.machineId,
      idempotencyKey,
      requireAckedVersion: true,
      auditRequest: {
        days: input.days,
        on: input.on,
        off: input.off,
        source: plan.source,
        offSoon: plan.offSoon,
      },
    },
    (api, ctx) => api.setPowerSchedule({ machineId: ctx.awishMachineId ?? "", ...plan.request }),
    deps,
  );
  if (!r.ok && (r.kind === "forbidden" || r.kind === "demo" || r.kind === "rate_limited")) {
    return outcome(r, () => "");
  }
  if (r.ok || r.actionId) {
    await record(dbOf(deps), {
      orgId: viewer.organization.id,
      machineId: input.machineId,
      userId: viewer.user.userId,
      status: r.ok ? "sent" : "failed",
      input,
      source: plan.source,
      error: r.ok ? null : r.message.slice(0, 300),
      actionId: r.actionId,
    });
  }
  return outcome(r, () => `Skickat. ${plan.lines[0]!}`);
}

export async function clearPowerScheduleFor(
  viewer: Viewer,
  raw: { machineId: unknown; idempotencyKey: unknown },
  deps: MachineControlDeps = {},
): Promise<ControlOutcome> {
  const idempotencyKey = idempotencyKeyOf(raw.idempotencyKey);
  const machineId = z.uuid("Välj automat.").parse(raw.machineId);
  await requireOperator(viewer);
  // Automaten måste finnas och vara kopplad (spärren kontrollerar resten).
  await machineFor(dbOf(deps), viewer.organization.id, machineId, deps);
  const run = deps.run ?? runControlAction;
  const r = await run(
    viewer,
    { kind: "power_schedule_clear", machineId, idempotencyKey, auditRequest: {} },
    (api, ctx) => api.clearPowerSchedule(ctx.awishMachineId ?? ""),
    deps,
  );
  if (r.ok) {
    await record(dbOf(deps), {
      orgId: viewer.organization.id,
      machineId,
      userId: viewer.user.userId,
      status: "cleared",
      error: null,
      actionId: r.actionId,
    });
  }
  return outcome(r, () => `Klart. ${CLEAR_SCHEDULE_TEXT}`);
}

/** Senast sparade schemat för automaten, eller null (även om tabellen saknas). */
export async function savedScheduleFor(
  db: Db,
  orgId: string,
  machineId: string,
): Promise<{
  days: string;
  on: string;
  off: string;
  status: "sent" | "failed" | "cleared";
  sentAt: Date | null;
  lastError: string | null;
} | null> {
  try {
    const [row] = Array.from(
      await db.execute(
        sql`select weekdays, power_on, power_off, status, sent_at, last_error
            from public.machine_power_schedules
            where organization_id = ${orgId}::uuid and machine_id = ${machineId}::uuid`,
      ),
    ) as {
      weekdays: string;
      power_on: string;
      power_off: string;
      status: "sent" | "failed" | "cleared";
      sent_at: Date | string | null;
      last_error: string | null;
    }[];
    if (!row) return null;
    return {
      days: row.weekdays,
      on: row.power_on,
      off: row.power_off,
      status: row.status,
      sentAt: row.sent_at ? new Date(row.sent_at) : null,
      lastError: row.last_error,
    };
  } catch (error) {
    console.error("[strömschema] kunde inte läsa", safeErrorForLog(error));
    return null;
  }
}
