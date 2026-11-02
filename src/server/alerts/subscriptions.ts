/**
 * Prenumerationer: rader i public.alert_subscriptions ↔ @/analytics/alerts AlertSubscription,
 * och validering av formuläret på /drift/larm. Rent, utan databas.
 */

import type {
  AlertKind,
  AlertSeverity,
  AlertSubscription,
  DeliveryWindow,
} from "@/analytics/alerts";

/**
 * Larmtyperna som går att prenumerera på (samma lista som private.alert_kinds_valid).
 * Systemlarmen (report_failed, job_failed) syns på Drift men aviseras inte.
 */
export const ALERT_KINDS: readonly AlertKind[] = [
  "machine_offline",
  "machine_fault",
  "machine_suspected_fault",
  "low_stock",
  "import_failed",
  "day_anomaly",
];

/** Larmtyper som rör automater och lager: det påfyllaren får. */
export const FIELD_KINDS: readonly AlertKind[] = [
  "machine_offline",
  "machine_fault",
  "machine_suspected_fault",
  "low_stock",
];

export const KIND_LABEL: Record<AlertKind, string> = {
  machine_offline: "Ur drift",
  machine_fault: "Fel rapporterat av automaten",
  machine_suspected_fault: "Misstänkt fel",
  low_stock: "Titel nära slut",
  import_failed: "Misslyckad import",
  day_anomaly: "Avvikande dag",
  report_failed: "Misslyckad rapport",
  job_failed: "Misslyckat schemalagt jobb",
};

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "Kritisk",
  warning: "Varning",
  info: "Info",
};

export type ChannelKey = "push" | "email" | "sms";

/** Raden som larmjobbet och inställningssidan läser. */
export interface SubscriptionRow {
  readonly userId: string;
  readonly kinds: string[] | null;
  readonly machineIds: string[] | null;
  readonly minSeverity: AlertSeverity;
  readonly channels: string[];
  readonly phone: string | null;
  readonly quietStart: string | null;
  readonly quietEnd: string | null;
  readonly deliveryWindows: { days: number[]; start: string; end: string }[] | null;
  readonly criticalDuringQuiet: boolean;
  readonly notifyResolved: boolean;
  readonly reminders: boolean;
  readonly active: boolean;
  /** Medlemmens roll (från memberships). */
  readonly role?: string;
}

export function rowToSubscription(r: SubscriptionRow): AlertSubscription {
  const kinds = r.kinds
    ? (r.kinds.filter((k) => ALERT_KINDS.includes(k as AlertKind)) as AlertKind[])
    : null;
  return {
    userId: r.userId,
    kinds: kinds ?? "all",
    machineIds: r.machineIds ?? "all",
    minSeverity: r.minSeverity,
    quietHours: r.quietStart && r.quietEnd ? { start: r.quietStart, end: r.quietEnd } : null,
    deliveryWindows: r.deliveryWindows && r.deliveryWindows.length > 0 ? r.deliveryWindows : null,
    criticalDuringQuietHours: r.criticalDuringQuiet,
    notifyResolved: r.notifyResolved,
    reminders: r.reminders,
    active: r.active,
  };
}

/** Standard för en ny prenumeration: kritiska och varningar om automater och lager, push och e-post. */
export function defaultSubscription(userId: string, role: string): SubscriptionRow {
  return {
    userId,
    kinds: role === "refiller" ? [...FIELD_KINDS] : null,
    machineIds: null,
    minSeverity: "warning",
    channels: ["push", "email"],
    phone: null,
    quietStart: "22:00",
    quietEnd: "07:00",
    deliveryWindows: null,
    criticalDuringQuiet: true,
    notifyResolved: false,
    reminders: true,
    active: true,
  };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PHONE = /^\+[1-9][0-9]{6,14}$/;

export interface SubscriptionInput {
  readonly kinds: string[];
  readonly allKinds: boolean;
  readonly machineIds: string[];
  readonly allMachines: boolean;
  readonly minSeverity: string;
  readonly channels: string[];
  readonly phone: string;
  readonly quiet: boolean;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly window: boolean;
  readonly windowDays: number[];
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly criticalDuringQuiet: boolean;
  readonly notifyResolved: boolean;
  readonly reminders: boolean;
  readonly active: boolean;
}

export type FieldErrors = Partial<Record<keyof SubscriptionInput | "form", string>>;

/** Svenskt telefonnummer till E.164: "070-123 45 67" → "+46701234567". */
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s()-]/g, "");
  if (compact === "") return null;
  if (compact.startsWith("+")) return compact;
  if (compact.startsWith("00")) return `+${compact.slice(2)}`;
  if (compact.startsWith("0")) return `+46${compact.slice(1)}`;
  return compact;
}

/**
 * Validerar formuläret. Påfyllaren får bara larm om automater och lager. Returnerar raden att
 * spara eller fält med fel (svenska meddelanden).
 */
export function validateSubscription(
  input: SubscriptionInput,
  ctx: { userId: string; role: string; machineIds: readonly string[] },
): { ok: true; row: SubscriptionRow } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const refiller = ctx.role === "refiller";
  let kinds: string[] | null = input.allKinds ? null : [...new Set(input.kinds)];
  if (kinds && kinds.some((k) => !ALERT_KINDS.includes(k as AlertKind))) {
    errors.kinds = "Okänd larmtyp.";
  }
  if (refiller) {
    kinds = (kinds ?? [...FIELD_KINDS]).filter((k) => FIELD_KINDS.includes(k as AlertKind));
  }
  if (kinds && kinds.length === 0) errors.kinds = "Välj minst en typ av larm.";

  const known = new Set(ctx.machineIds);
  const machineIds = input.allMachines ? null : [...new Set(input.machineIds)];
  if (machineIds && machineIds.some((m) => !known.has(m))) errors.machineIds = "Okänd automat.";
  if (machineIds && machineIds.length === 0) errors.machineIds = "Välj minst en automat.";

  if (!["info", "warning", "critical"].includes(input.minSeverity)) {
    errors.minSeverity = "Välj lägsta allvar.";
  }
  const channels = [...new Set(input.channels)].filter((c) => ["push", "email", "sms"].includes(c));
  if (channels.length === 0) errors.channels = "Välj minst en kanal.";

  const phone = normalizePhone(input.phone);
  if (phone !== null && !PHONE.test(phone))
    errors.phone = "Ange numret som 070-123 45 67 eller +46701234567.";
  if (channels.includes("sms") && phone === null) errors.phone = "Ange ett nummer för sms.";

  if (input.quiet && (!TIME.test(input.quietStart) || !TIME.test(input.quietEnd))) {
    errors.quietStart = "Ange tider som TT:MM.";
  }
  if (input.quiet && input.quietStart === input.quietEnd) {
    errors.quietStart = "Start och slut kan inte vara samma tid.";
  }
  let windows: DeliveryWindow[] | null = null;
  if (input.window) {
    const days = [...new Set(input.windowDays)].filter(
      (d) => Number.isInteger(d) && d >= 1 && d <= 7,
    );
    if (days.length === 0) errors.windowDays = "Välj minst en dag.";
    if (!TIME.test(input.windowStart) || !TIME.test(input.windowEnd)) {
      errors.windowStart = "Ange tider som TT:MM.";
    }
    windows = [
      { days: days.sort((a, b) => a - b), start: input.windowStart, end: input.windowEnd },
    ];
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    row: {
      userId: ctx.userId,
      kinds,
      machineIds,
      minSeverity: input.minSeverity as AlertSeverity,
      channels,
      phone,
      quietStart: input.quiet ? input.quietStart : null,
      quietEnd: input.quiet ? input.quietEnd : null,
      deliveryWindows: windows
        ? windows.map((w) => ({ days: [...w.days], start: w.start, end: w.end }))
        : null,
      criticalDuringQuiet: input.criticalDuringQuiet,
      notifyResolved: input.notifyResolved,
      reminders: input.reminders,
      active: input.active,
    },
  };
}
