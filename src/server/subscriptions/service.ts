/**
 * Abonnemang: data och ändringar för /plattform och Inställningar, utan beroende på Next
 * (användaren skickas in). Testas mot testdatabasen i test/db/abonnemang.test.ts.
 *
 * Allt körs som användaren under RLS (withUserDbFor). Tabellerna ligger i schemat private
 * och nås bara via RPC:erna i 20261111010000_abonnemang.sql, som själva kontrollerar att
 * anroparen är plattformsoperatör (platform_overview_data, platform_save_plan) eller ägare
 * eller admin i organisationen (my_subscription). Beräkningarna är rena funktioner i
 * @/analytics/subscriptions.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  CURRENCIES,
  PLAN_STATUSES,
  customerSummary,
  invoiceBasis,
  platformHistory,
  platformTotals,
  type BillingCustomer,
  type BillingMachine,
  type CustomerSummary,
  type InvoiceBasis,
  type MonthHistory,
  type PlanPeriod,
  type PlatformCustomerInput,
  type PlatformTotals,
} from "@/analytics/subscriptions/billing";
import { isIsoDate, type IsoDate, type IsoMonth } from "@/domain";
import { isUuid, withUserDbFor, type SessionUser } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { pgErrorOf } from "@/server/errors";

export const SUBSCRIPTION_MESSAGES = {
  forbidden: "Du har inte behörighet till plattformen.",
  invalid: "Uppgifterna stämmer inte. Kontrollera fälten.",
  price: "Ange ett pris per automat, t.ex. 499.",
  date: "Ange ett datum (ÅÅÅÅ-MM-DD).",
  country: "Landet ska vara två bokstäver, t.ex. SE eller DK.",
  vat: "Momsnumret ska vara 4–20 bokstäver och siffror, t.ex. DK12345678.",
  missing: "Kunden finns inte.",
  backdated: "Datumet ligger före den nuvarande planen. Välj samma dag eller senare.",
  failed: "Planen kunde inte sparas. Försök igen.",
  customerForbidden: "Bara ägare och admin ser abonnemanget.",
} as const;

const isoDate = z.string().refine(isIsoDate);

const planRow = z.object({
  organizationId: z.string(),
  validFrom: isoDate,
  validTo: isoDate.nullable(),
  status: z.enum(["active", "paused", "ended"]),
  pricePerMachineOre: z.coerce.number().int(),
  currency: z.string(),
  note: z.string().nullable().optional(),
});

const machineRow = z.object({
  organizationId: z.string(),
  machineId: z.string(),
  activeFrom: isoDate,
  activeTo: isoDate.nullable(),
});

const customerRow = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
  operator: z.boolean(),
  countryCode: z.string().nullable(),
  vatNumber: z.string().nullable(),
  trialEndsOn: isoDate.nullable(),
  members: z.coerce.number().int(),
  lastSaleOn: isoDate.nullable(),
});

const overview = z.object({
  customers: z.array(customerRow),
  plans: z.array(planRow),
  machines: z.array(machineRow),
});

const mine = z.object({
  customer: z
    .object({
      countryCode: z.string().nullable(),
      vatNumber: z.string().nullable(),
      trialEndsOn: isoDate.nullable(),
    })
    .nullable(),
  plans: z.array(planRow),
  machines: z.array(machineRow),
});

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function toPeriod(p: z.infer<typeof planRow>): PlanPeriod {
  return {
    validFrom: p.validFrom,
    validTo: p.validTo,
    status: p.status,
    pricePerMachineOre: p.pricePerMachineOre,
    currency: p.currency,
  };
}

function toMachine(m: z.infer<typeof machineRow>): BillingMachine {
  return { machineId: m.machineId, activeFrom: m.activeFrom, activeTo: m.activeTo };
}

function groupBy<T extends { organizationId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const list = map.get(r.organizationId) ?? [];
    list.push(r);
    map.set(r.organizationId, list);
  }
  return map;
}

/** Är användaren plattformsoperatör (ägare/admin i en plattformsorganisation)? */
export async function isPlatformOperatorFor(user: SessionUser | null): Promise<boolean> {
  if (!user) return false;
  return withUserDbFor(user, async (tx) => {
    const [row] = Array.from(
      await tx.execute(sql`select public.am_platform_operator() as ok`),
    ) as Array<{ ok: boolean }>;
    return row?.ok === true;
  });
}

export interface PlatformCustomer extends PlatformCustomerInput {
  slug: string;
  createdAt: string;
  archivedAt: string | null;
  operator: boolean;
  members: number;
  lastSaleOn: IsoDate | null;
  /** Planens perioder med interna anteckningar (senaste sist). */
  notes: Array<{ validFrom: IsoDate; note: string }>;
}

export interface PlatformRow {
  customer: PlatformCustomer;
  summary: CustomerSummary;
}

export interface PlatformData {
  today: IsoDate;
  rows: PlatformRow[];
  totals: PlatformTotals;
  history: MonthHistory[];
}

/** Rådata för plattformen. Kastar 42501 (via RPC:n) för andra än plattformsoperatörer. */
export async function loadPlatformCustomersFor(user: SessionUser): Promise<PlatformCustomer[]> {
  const raw = await withUserDbFor(user, async (tx) => {
    const [row] = Array.from(
      await tx.execute(sql`select public.platform_overview_data() as data`),
    ) as Array<{ data: unknown }>;
    return row?.data;
  });
  const data = overview.parse(json(raw));
  const plans = groupBy(data.plans);
  const machines = groupBy(data.machines);
  return data.customers.map((c) => {
    const own = plans.get(c.id) ?? [];
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      createdAt: c.createdAt,
      archivedAt: c.archivedAt,
      operator: c.operator,
      members: c.members,
      lastSaleOn: c.lastSaleOn,
      periods: own.map(toPeriod),
      notes: own.flatMap((p) => (p.note ? [{ validFrom: p.validFrom, note: p.note }] : [])),
      machines: (machines.get(c.id) ?? []).map(toMachine),
      customer: {
        countryCode: c.countryCode,
        vatNumber: c.vatNumber,
        trialEndsOn: c.trialEndsOn,
      },
    };
  });
}

/** Allt på /plattform: kunder, totaler och historik. */
export async function loadPlatformFor(
  user: SessionUser,
  today: IsoDate,
  months = 12,
): Promise<PlatformData> {
  const customers = await loadPlatformCustomersFor(user);
  const rows = customers.map((customer) => ({
    customer,
    summary: customerSummary(customer, today),
  }));
  return {
    today,
    rows,
    totals: platformTotals(rows.map((r) => r.summary)),
    history: platformHistory(customers, today, months),
  };
}

export interface InvoiceRow {
  customer: PlatformCustomer;
  basis: InvoiceBasis;
}

/** Fakturaunderlaget för alla kunder med en plan, en månad. */
export async function loadInvoiceBasisFor(
  user: SessionUser,
  month: IsoMonth,
): Promise<InvoiceRow[]> {
  const customers = await loadPlatformCustomersFor(user);
  return customers
    .filter((c) => c.periods.length > 0)
    .map((customer) => ({ customer, basis: invoiceBasis(customer, month) }));
}

// ---------------------------------------------------------------------------
// Ändra plan
// ---------------------------------------------------------------------------

export interface SavePlanInput {
  organizationId: string;
  effectiveFrom: string;
  status: string;
  /** Kronor per automat och månad, t.ex. "499" eller "499,50". */
  price: string;
  currency: string;
  trialEndsOn: string;
  countryCode: string;
  vatNumber: string;
  note: string;
}

/** "499", "499,5", "1 299,00" → öre. null om ogiltigt. */
export function parsePriceOre(value: string): number | null {
  const s = value.replace(/[\s ]/g, "").replace(/kr$/i, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [kr, ore = ""] = s.split(".");
  return Number(kr) * 100 + Number(ore.padEnd(2, "0"));
}

const saveInput = z.object({
  organizationId: z.string().refine(isUuid, "invalid"),
  effectiveFrom: z.string().refine(isIsoDate, "date"),
  status: z.enum(PLAN_STATUSES as unknown as ["active", "paused", "ended"]),
  price: z.string(),
  currency: z.enum(CURRENCIES),
  trialEndsOn: z
    .string()
    .trim()
    .refine((v) => v === "" || isIsoDate(v), "date"),
  countryCode: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || /^[A-Z]{2}$/.test(v), "country"),
  vatNumber: z
    .string()
    .transform((v) => v.replace(/[\s.-]/g, "").toUpperCase())
    .refine((v) => v === "" || /^[A-Z0-9]{4,20}$/.test(v), "vat"),
  note: z.string().trim().max(500, "invalid"),
});

/** Ändrar en kunds plan från ett datum. Bara plattformsoperatörer. */
export async function savePlanFor(
  user: SessionUser | null,
  raw: SavePlanInput,
): Promise<ActionResult> {
  if (!user || !(await isPlatformOperatorFor(user))) {
    return { ok: false, error: SUBSCRIPTION_MESSAGES.forbidden };
  }
  const parsed = saveInput.safeParse(raw);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.message;
    const msg =
      key === "date"
        ? SUBSCRIPTION_MESSAGES.date
        : key === "country"
          ? SUBSCRIPTION_MESSAGES.country
          : key === "vat"
            ? SUBSCRIPTION_MESSAGES.vat
            : SUBSCRIPTION_MESSAGES.invalid;
    return { ok: false, error: msg };
  }
  const input = parsed.data;
  const priceOre = parsePriceOre(input.price);
  if (priceOre === null) return { ok: false, error: SUBSCRIPTION_MESSAGES.price };
  try {
    await withUserDbFor(user, (tx) =>
      tx.execute(
        sql`select public.platform_save_plan(
              ${input.organizationId}::uuid,
              ${input.effectiveFrom}::date,
              ${input.status},
              ${priceOre}::bigint,
              ${input.currency},
              ${input.trialEndsOn || null}::date,
              ${input.countryCode || null},
              ${input.vatNumber || null},
              ${input.note || null}
            )`,
      ),
    );
    return { ok: true };
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg?.code === "42501") return { ok: false, error: SUBSCRIPTION_MESSAGES.forbidden };
    if (pg?.code === "BL120") return { ok: false, error: SUBSCRIPTION_MESSAGES.backdated };
    if (pg?.code === "P0002") return { ok: false, error: SUBSCRIPTION_MESSAGES.missing };
    if (pg?.code === "23514" || pg?.code === "22023") {
      return { ok: false, error: SUBSCRIPTION_MESSAGES.invalid };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Kundens egen vy (Inställningar)
// ---------------------------------------------------------------------------

export interface MySubscription {
  customer: BillingCustomer;
  periods: PlanPeriod[];
  machines: BillingMachine[];
}

/** Organisationens plan och automater. Ägare och admin (42501 annars, från RPC:n). */
export async function loadMySubscriptionFor(
  user: SessionUser,
  organizationId: string,
): Promise<MySubscription> {
  const raw = await withUserDbFor(user, async (tx) => {
    const [row] = Array.from(
      await tx.execute(sql`select public.my_subscription(${organizationId}::uuid) as data`),
    ) as Array<{ data: unknown }>;
    return row?.data;
  });
  const data = mine.parse(json(raw));
  return {
    customer: data.customer ?? { countryCode: null, vatNumber: null, trialEndsOn: null },
    periods: data.plans.map(toPeriod),
    machines: data.machines.map(toMachine),
  };
}
