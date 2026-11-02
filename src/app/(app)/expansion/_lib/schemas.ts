/**
 * Kontroll av indata till server actions för Expansion, Enhetsekonomi och Effekt (zod).
 *
 * Formulären skickar text som användaren skrivit ("12 500", "12,5", "2026-11"). Här blir
 * texten heltal: belopp i öre (via importens beloppstolkare, utan flyttal), procent i bp
 * och tid i minuter. Felmeddelandena är svenska och visas vid fältet.
 */

import { z } from "zod";

import { addDays, daysInMonth, isIsoDate, type IsoDate } from "@/domain";
import { parseAmountOre } from "@/import/amount";

import { LEAD_STAGES } from "./model";

// ---------------------------------------------------------------------------
// Tolkning av tal
// ---------------------------------------------------------------------------

const trim = (v: unknown) => (typeof v === "string" ? v.trim() : v);
const emptyToNull = (v: unknown) => {
  const t = trim(v);
  return t === "" || t === undefined ? null : t;
};

/**
 * Decimaltal med högst två decimaler som hundradelar, utan flyttal: "12,5" → 1250,
 * "0.25" → 25, "3" → 300. `null` vid ogiltig text eller negativt tal.
 */
export function parseHundredths(input: string): number | null {
  const s = input.replace(/[\s  ]/g, "").replace(",", ".");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

/** Kronor (inte negativt) → öre. */
const kronor = (label: string) =>
  z.string({ error: `${label} saknas.` }).transform((v, ctx) => {
    const r = parseAmountOre(v);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: `${label}: ${r.message}` });
      return z.NEVER;
    }
    return r.ore;
  });

/**
 * Valfritt fält: tom text blir null, annars tolkas texten med `parse`, som returnerar
 * värdet eller ett felmeddelande. (En union med null skulle dölja felmeddelandet.)
 */
function optional<T>(
  parse: (v: string) => { ok: true; value: T } | { ok: false; message: string },
) {
  return z.preprocess(emptyToNull, z.string().nullable()).transform((v, ctx): T | null => {
    if (v === null) return null;
    const r = parse(v);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.message });
      return z.NEVER;
    }
    return r.value;
  });
}

/** Valfritt belopp i kronor → öre eller null. */
const optionalKronor = (label: string) =>
  optional((v) => {
    const r = parseAmountOre(v);
    return r.ok ? { ok: true, value: r.ore } : { ok: false, message: `${label}: ${r.message}` };
  });

/** Kronor med tecken ("+10", "−5", "-2,50") → öre. */
export function parseSignedOre(input: string): number | null {
  const t = input.trim();
  const negative = /^[-−–]/.test(t);
  const body = t.replace(/^[-+−–]\s*/, "");
  const r = parseAmountOre(body);
  if (!r.ok) return null;
  return negative ? -r.ore : r.ore;
}

/** Procent ("10", "12,5") → bp, 0–100 %. */
const percentBp = (label: string) =>
  optional((v) => {
    const h = parseHundredths(v);
    return h === null || h > 10_000
      ? { ok: false, message: `${label}: ange en procentsats mellan 0 och 100.` }
      : { ok: true, value: h };
  });

/** Heltal inom gränser, eller null om fältet är tomt. */
const optionalInt = (label: string, min: number, max: number) =>
  optional((v) => {
    const t = v.replace(/[\s\u00a0\u202f]/g, "");
    return !/^\d+$/.test(t) || Number(t) < min || Number(t) > max
      ? { ok: false, message: `${label}: ange ett heltal mellan ${min} och ${max}.` }
      : { ok: true, value: Number(t) };
  });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (label: string) =>
  z.string({ error: `${label} saknas.` }).regex(UUID_RE, `${label} saknas eller är ogiltig.`);
const optionalUuid = optional((v) =>
  UUID_RE.test(v) ? { ok: true, value: v } : { ok: false, message: "Valet är ogiltigt." },
);
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Datum i kalendern (inte 2026-02-30) mellan år 2000 och 2100. */
function dateIssue(label: string, v: string): string | null {
  if (!ISO_DATE_RE.test(v)) return `${label}: ange ett datum (ÅÅÅÅ-MM-DD).`;
  if (!isIsoDate(v)) return `${label}: datumet ${v} finns inte i kalendern.`;
  if (v < "2000-01-01" || v > "2100-12-31")
    return `${label}: ange ett datum mellan år 2000 och 2100.`;
  return null;
}
const isoDate = (label: string) =>
  z.string({ error: `${label} saknas.` }).superRefine((v, ctx) => {
    const issue = dateIssue(label, v);
    if (issue) ctx.addIssue({ code: "custom", message: issue });
  });
const optionalDate = (label: string) =>
  optional((v) => {
    const issue = dateIssue(label, v);
    return issue === null ? { ok: true, value: v } : { ok: false, message: issue };
  });
const isoMonth = z
  .string({ error: "Ange en månad (ÅÅÅÅ-MM)." })
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Ange en månad (ÅÅÅÅ-MM).");
const optionalText = (max: number, label: string) =>
  optional((v) =>
    v.length <= max
      ? { ok: true, value: v }
      : { ok: false, message: `${label}: högst ${max} tecken.` },
  );
const optionalId = optional((v) =>
  UUID_RE.test(v) ? { ok: true, value: v } : { ok: false, message: "Raden är ogiltig." },
);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Investeringar
// ---------------------------------------------------------------------------

export const investmentSchema = z.object({
  id: optionalId,
  machineId: uuid("Automaten"),
  kind: z.enum(["purchase", "installation", "other"], { error: "Välj typ av investering." }),
  amountOre: kronor("Beloppet"),
  investedOn: isoDate("Datum"),
  depreciationMonths: optionalInt("Avskrivningstid", 1, 600),
  note: optionalText(300, "Anteckning"),
});
export type InvestmentInput = z.infer<typeof investmentSchema>;

/** Hur långt från i dag ett investeringsdatum får ligga (dagar, åt båda hållen). */
export const INVESTMENT_DATE_WINDOW_DAYS = 2 * 366;

/**
 * Investeringen med datumet inom ±2 år från `today`. Investeringar kan inte raderas
 * (ekonomiska uppgifter), så ett orimligt datum (9999-12-31) ska stoppas vid fältet.
 * Äldre automater registreras med ett datum högst två år bakåt; avskrivningen räknas från det.
 */
export function investmentSchemaAt(today: IsoDate) {
  const min = addDays(today, -INVESTMENT_DATE_WINDOW_DAYS);
  const max = addDays(today, INVESTMENT_DATE_WINDOW_DAYS);
  return investmentSchema.superRefine((v, ctx) => {
    if (v.investedOn < min || v.investedOn > max) {
      ctx.addIssue({
        code: "custom",
        path: ["investedOn"],
        message: `Datum: ange ett datum mellan ${min} och ${max}.`,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Mål
// ---------------------------------------------------------------------------

const scoped = {
  scope: z.enum(["organization", "store", "machine"], { error: "Välj vad målet gäller." }),
  storeId: optionalUuid,
  machineId: optionalUuid,
};

function checkScope(
  v: { scope: string; storeId: string | null; machineId: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.scope === "store" && !v.storeId) {
    ctx.addIssue({ code: "custom", path: ["storeId"], message: "Välj butik." });
  }
  if (v.scope === "machine" && !v.machineId) {
    ctx.addIssue({ code: "custom", path: ["machineId"], message: "Välj automat." });
  }
}

/** Rensar id:n som inte hör till omfattningen. */
function normalizeScope<
  T extends { scope: string; storeId: string | null; machineId: string | null },
>(v: T): T {
  return {
    ...v,
    storeId: v.scope === "store" ? v.storeId : null,
    machineId: v.scope === "machine" ? v.machineId : null,
  };
}

export const goalSchema = z
  .object({
    id: optionalId,
    month: isoMonth,
    metric: z.enum(["revenue", "profit", "active_machines"], { error: "Välj mått." }),
    target: z.string({ error: "Målet saknas." }),
    ...scoped,
  })
  .superRefine(checkScope)
  .transform((v, ctx) => {
    let target: number;
    if (v.metric === "active_machines") {
      const s = v.target.replace(/\s/g, "");
      if (!/^\d{1,4}$/.test(s)) {
        ctx.addIssue({ code: "custom", path: ["target"], message: "Ange antal automater." });
        return z.NEVER;
      }
      target = Number(s);
    } else {
      const r = parseAmountOre(v.target);
      if (!r.ok) {
        ctx.addIssue({ code: "custom", path: ["target"], message: `Målet: ${r.message}` });
        return z.NEVER;
      }
      target = r.ore;
    }
    return normalizeScope({ ...v, target });
  });
export type GoalInput = z.infer<typeof goalSchema>;

export const idSchema = z.object({ id: uuid("Raden") });

// ---------------------------------------------------------------------------
// Pipeline och platsattribut
// ---------------------------------------------------------------------------

const attributes = {
  storeType: optionalText(60, "Butikstyp"),
  city: optionalText(100, "Ort"),
  openHoursPerWeek: optionalInt("Öppettimmar per vecka", 0, 168),
  areaSqm: optionalInt("Yta", 0, 1_000_000),
};

export const storeProfileSchema = z.object({ storeId: uuid("Butiken"), ...attributes });
export type StoreProfileInput = z.infer<typeof storeProfileSchema>;

export const leadSchema = z.object({
  id: optionalId,
  name: z
    .string({ error: "Namn saknas." })
    .trim()
    .min(1, { error: "Namn saknas." })
    .max(200, { error: "Namnet: högst 200 tecken." }),
  stage: z.enum(LEAD_STAGES, { error: "Välj steg." }),
  ...attributes,
  address: optionalText(300, "Adress"),
  contactName: optionalText(200, "Kontaktperson"),
  contactEmail: optional((v) =>
    EMAIL_RE.test(v) && v.length <= 320
      ? { ok: true, value: v }
      : { ok: false, message: "Ange en giltig e-postadress." },
  ),
  contactPhone: optionalText(50, "Telefon"),
  notes: optionalText(5000, "Anteckningar"),
  nextStep: optionalText(300, "Nästa steg"),
  nextStepOn: optionalDate("Datum för nästa steg"),
  commissionBp: percentBp("Provision"),
  monthlyRentOre: optionalKronor("Hyra"),
  purchaseOre: optionalKronor("Automat"),
  installationOre: optionalKronor("Installation"),
  storeId: optionalUuid,
});
export type LeadInput = z.infer<typeof leadSchema>;

export const leadArchiveSchema = z.object({
  id: uuid("Platsen"),
  archived: z.boolean({ error: "Ange arkivera eller ta tillbaka." }),
});

export const leadStageSchema = z.object({
  id: uuid("Leaden"),
  stage: z.enum(LEAD_STAGES, { error: "Välj steg." }),
});

// ---------------------------------------------------------------------------
// Effekt
// ---------------------------------------------------------------------------

const BASELINE_METRICS = [
  "profit_per_machine_month",
  "stockout_days_month",
  "refill_hours_month",
  "admin_hours_month",
] as const;
export type BaselineMetricKey = (typeof BASELINE_METRICS)[number];

/** Enhet per mått (baselines.unit). */
export const BASELINE_UNIT = {
  profit_per_machine_month: "ore",
  stockout_days_month: "days",
  refill_hours_month: "minutes",
  admin_hours_month: "minutes",
} as const satisfies Record<BaselineMetricKey, "ore" | "days" | "minutes">;

/** Värdet i måttets enhet: kronor → öre, dagar → heltal, timmar → minuter. */
function metricValue(
  metric: BaselineMetricKey,
  raw: string,
  ctx: z.RefinementCtx,
  path: string,
): number | typeof z.NEVER {
  if (metric === "profit_per_machine_month") {
    const neg = /^\s*[-−]/.test(raw);
    const r = parseAmountOre(raw.replace(/^\s*[-−]\s*/, ""));
    if (!r.ok) {
      ctx.addIssue({ code: "custom", path: [path], message: `Värdet: ${r.message}` });
      return z.NEVER;
    }
    return neg ? -r.ore : r.ore;
  }
  if (metric === "stockout_days_month") {
    const s = raw.replace(/\s/g, "");
    if (!/^\d{1,6}$/.test(s)) {
      ctx.addIssue({ code: "custom", path: [path], message: "Ange antal dagar som heltal." });
      return z.NEVER;
    }
    return Number(s);
  }
  const h = parseHundredths(raw);
  if (h === null) {
    ctx.addIssue({ code: "custom", path: [path], message: "Ange timmar, t.ex. 12 eller 12,5." });
    return z.NEVER;
  }
  return Math.floor((h * 60 + 50) / 100);
}

// Övre gränser för mätvärdena (per månad och automat). Slutsålda dagar kan inte vara fler
// än månadens dagar per automat; tid högst dygnets alla timmar (744 h på 31 dagar) per
// automat. Databasen tillåter högst 1 000 000 (dagar eller minuter).
const DB_MAX_VALUE = 1_000_000;
const MAX_HOURS_PER_MACHINE_MONTH = 31 * 24;

/**
 * Felmeddelande när ett mätvärde (eller utgångsläge, `month` = null: en hel månad på 31
 * dagar) är orimligt stort för omfattningen, annars null. `machines` = automater i
 * omfattningen (minst 1). Värdet är i måttets enhet: dagar eller minuter.
 */
export function metricLimitIssue(
  metric: BaselineMetricKey,
  value: number,
  month: string | null,
  machines: number,
): string | null {
  if (metric === "profit_per_machine_month") return null;
  const n = Math.max(1, Math.floor(machines));
  const dim = month === null ? 31 : daysInMonth(month);
  if (metric === "stockout_days_month") {
    const max = Math.min(dim * n, DB_MAX_VALUE);
    if (value <= max) return null;
    return `Högst ${max} slutsålda dagar: ${dim} dagar${month === null ? "" : " i månaden"} × ${n} ${n === 1 ? "automat" : "automater"}.`;
  }
  const maxHours = Math.min(MAX_HOURS_PER_MACHINE_MONTH * n, Math.floor(DB_MAX_VALUE / 60));
  if (value <= maxHours * 60) return null;
  return `Högst ${maxHours} timmar per månad (${MAX_HOURS_PER_MACHINE_MONTH} h × ${n} ${n === 1 ? "automat" : "automater"}).`;
}

/** Kastar ett fältfel på "value" om mätvärdet är orimligt (se `metricLimitIssue`). */
export function assertMetricLimit(
  metric: BaselineMetricKey,
  value: number,
  month: string | null,
  machines: number,
): void {
  const message = metricLimitIssue(metric, value, month, machines);
  if (message) {
    throw new z.ZodError([{ code: "custom", path: ["value"], message, input: value }]);
  }
}

export const baselineSchema = z
  .object({
    id: optionalId,
    metric: z.enum(BASELINE_METRICS, { error: "Välj mått." }),
    value: z.string({ error: "Värdet saknas." }),
    measuredFrom: optionalDate("Mätt från"),
    measuredTo: optionalDate("Mätt till"),
    source: optionalText(300, "Källa"),
    ...scoped,
  })
  .superRefine(checkScope)
  .superRefine((v, ctx) => {
    if (v.measuredFrom && v.measuredTo && v.measuredTo < v.measuredFrom) {
      ctx.addIssue({ code: "custom", path: ["measuredTo"], message: "Slutet ligger före början." });
    }
  })
  .transform((v, ctx) => {
    const value = metricValue(v.metric, v.value, ctx, "value");
    if (value === z.NEVER) return z.NEVER;
    return normalizeScope({ ...v, value: value as number, unit: BASELINE_UNIT[v.metric] });
  });
export type BaselineInput = z.infer<typeof baselineSchema>;

export const measurementSchema = z
  .object({
    id: optionalId,
    metric: z.enum(["stockout_days_month", "refill_hours_month", "admin_hours_month"], {
      error: "Välj mått.",
    }),
    month: isoMonth,
    value: z.string({ error: "Värdet saknas." }),
    note: optionalText(500, "Anteckning"),
    ...scoped,
  })
  .superRefine(checkScope)
  .transform((v, ctx) => {
    const value = metricValue(v.metric, v.value, ctx, "value");
    if (value === z.NEVER) return z.NEVER;
    return normalizeScope({ ...v, value: value as number });
  });
export type MeasurementInput = z.infer<typeof measurementSchema>;

export const effectSettingsSchema = z.object({
  hourlyCostOre: optionalKronor("Timkostnad"),
  stockoutDayValueOre: optionalKronor("Värde per slutsåld dag"),
});
export type EffectSettingsInput = z.infer<typeof effectSettingsSchema>;
