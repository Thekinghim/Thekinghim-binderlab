/**
 * Kundärenden: typer, etiketter och validering av formuläret. Rent och klientsäkert.
 *
 * Ett ärende gäller en automat och en tidpunkt, och kan kopplas till en order och en titel.
 * Återbetalt belopp anges i kronor i formuläret och sparas i öre (heltal).
 */

import { parseAmountOre } from "@/import/amount";
import { formatLocalDate, utcToZoned, zonedToUtc } from "@/import/zoned";

export const INCIDENT_KINDS = [
  "not_delivered",
  "wrong_amount",
  "wrong_product",
  "refund_request",
  "machine_fault",
  "other",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const KIND_LABEL: Record<string, string> = {
  not_delivered: "Fick ingen vara",
  wrong_amount: "Fel belopp",
  wrong_product: "Fel vara",
  refund_request: "Vill ha pengarna tillbaka",
  machine_fault: "Fel på automaten",
  other: "Annat",
};

export const INCIDENT_STATUSES = ["open", "in_progress", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  open: "Ny",
  in_progress: "Pågår",
  resolved: "Löst",
};

export interface IncidentInput {
  readonly id?: string;
  readonly machineId: string;
  readonly kind: string;
  /** Lokal tid i organisationens zon, "ÅÅÅÅ-MM-DDTTT:MM" (input type=datetime-local). */
  readonly occurredAt: string;
  readonly orderId: string;
  readonly titleId: string;
  readonly description: string;
  readonly customerContact: string;
  readonly status: string;
  readonly assigneeId: string;
  readonly actionTaken: string;
  /** Kronor som text, "49" eller "49,50". Tomt = 0. */
  readonly refunded: string;
  /** "ÅÅÅÅ-MM-DD", krävs när beloppet är större än 0. */
  readonly refundedOn: string;
}

export type IncidentErrors = Partial<Record<keyof IncidentInput | "form", string>>;

export interface IncidentValues {
  readonly machineId: string;
  readonly kind: IncidentKind;
  readonly startedAt: Date;
  readonly orderId: string | null;
  readonly titleId: string | null;
  readonly description: string | null;
  readonly customerContact: string | null;
  readonly status: IncidentStatus;
  readonly assigneeId: string | null;
  readonly actionTaken: string | null;
  readonly refundedOre: number;
  readonly refundedOn: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const clean = (s: string, max: number): string | null => {
  const t = s.trim();
  return t ? t.slice(0, max) : null;
};

/** "ÅÅÅÅ-MM-DDTTT:MM" i tidszonen → UTC, eller null om ogiltig. */
export function localToUtc(value: string, timeZone: string): Date | null {
  const m = LOCAL.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const r = zonedToUtc({ year, month, day, hour, minute, second: 0 }, timeZone);
  return Number.isFinite(r.utc.getTime()) ? r.utc : null;
}

/** UTC → "ÅÅÅÅ-MM-DDTTT:MM" i tidszonen (för datetime-local). */
export function utcToLocalInput(iso: string, timeZone: string): string {
  const p = utcToZoned(new Date(iso), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatLocalDate(p)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Validerar formuläret. Svenska felmeddelanden per fält. */
export function validateIncident(
  input: IncidentInput,
  ctx: { timeZone: string; now: Date; machineIds: readonly string[]; memberIds: readonly string[] },
): { ok: true; values: IncidentValues } | { ok: false; errors: IncidentErrors } {
  const errors: IncidentErrors = {};
  if (!ctx.machineIds.includes(input.machineId)) errors.machineId = "Välj automat.";
  if (!(INCIDENT_KINDS as readonly string[]).includes(input.kind)) errors.kind = "Välj typ av ärende.";
  const startedAt = localToUtc(input.occurredAt, ctx.timeZone);
  if (!startedAt) errors.occurredAt = "Ange datum och tid.";
  else if (startedAt.getTime() > ctx.now.getTime() + 5 * 60_000) errors.occurredAt = "Tiden ligger i framtiden.";
  if (input.orderId && !UUID.test(input.orderId)) errors.orderId = "Okänd order.";
  if (input.titleId && !UUID.test(input.titleId)) errors.titleId = "Okänd titel.";
  if (!(INCIDENT_STATUSES as readonly string[]).includes(input.status)) errors.status = "Välj status.";
  if (input.assigneeId && !ctx.memberIds.includes(input.assigneeId)) errors.assigneeId = "Välj en medlem.";
  if (input.description.length > 2000) errors.description = "Högst 2 000 tecken.";
  if (input.actionTaken.length > 2000) errors.actionTaken = "Högst 2 000 tecken.";
  if (input.customerContact.length > 200) errors.customerContact = "Högst 200 tecken.";

  let refundedOre = 0;
  if (input.refunded.trim() !== "") {
    const parsed = parseAmountOre(input.refunded);
    if (!parsed.ok) errors.refunded = "Ange beloppet i kronor, t.ex. 49 eller 49,50.";
    else if (parsed.ore > 100_000_000) errors.refunded = "Beloppet är för stort.";
    else refundedOre = parsed.ore;
  }
  let refundedOn: string | null = null;
  if (refundedOre > 0) {
    if (!DAY.test(input.refundedOn)) errors.refundedOn = "Ange dagen för återbetalningen.";
    else refundedOn = input.refundedOn;
  }
  if (input.status === "resolved" && !clean(input.actionTaken, 2000)) {
    errors.actionTaken = "Skriv vad som gjordes innan ärendet markeras löst.";
  }
  if (Object.keys(errors).length > 0 || !startedAt) return { ok: false, errors };
  return {
    ok: true,
    values: {
      machineId: input.machineId,
      kind: input.kind as IncidentKind,
      startedAt,
      orderId: input.orderId || null,
      titleId: input.titleId || null,
      description: clean(input.description, 2000),
      customerContact: clean(input.customerContact, 200),
      status: input.status as IncidentStatus,
      assigneeId: input.assigneeId || null,
      actionTaken: clean(input.actionTaken, 2000),
      refundedOre,
      refundedOn,
    },
  };
}
