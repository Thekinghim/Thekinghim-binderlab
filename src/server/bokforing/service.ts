/**
 * Ekonomi → Bokföring: månadsraderna, kontoplanen, "markera som skickad", kvitton och
 * månadspaketet (ZIP). Ingen automatisk bokföring: paketet laddas ned och skickas in
 * (Fortnox → Bokföring → Importera SIE, eller till Talenom).
 *
 * Varje funktion kontrollerar rollen mot databasen (requireRoleFor) och läser och skriver
 * som användaren (withUserDbFor, RLS). Läsa och ladda ned: ägare, admin och läsare. Ändra:
 * ägare och admin. Påfyllaren får ingenting.
 */

import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { MemberRole } from "@/db/schema";
import { eachMonth, type IsoDate } from "@/domain";
import type { FileStore } from "@/import/file-store";
import { sha256Hex } from "@/import/hash";
import { monthText } from "@/reports";
import { AccountingError, fiscalYearOf, monthReportsIn } from "@/server/accounting/service";
import { receiptFileStore } from "@/server/accounting/contract-files";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { querySettings } from "@/server/data/core/queries";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";

import {
  bookMonths,
  monthFiguresFromReport,
  VmbVatRateError,
  type MonthBook,
  type PurchaseBasis,
} from "./month";
import { buildMonthPackage, type MonthPackage } from "./package";
import { accountPlanSchema, DEFAULT_PLAN, parseAccountPlan, type AccountPlan } from "./plan";
import { checkReceipt, cleanFileName, receiptStoragePath } from "./receipts";
import { monthVerification } from "./sie";

export type MonthStatus = "open" | "closed" | "sent";

export const STATUS_LABEL: Record<MonthStatus, string> = {
  open: "öppen",
  closed: "stängd",
  sent: "skickad",
};

export interface BokforingSettings {
  readonly plan: AccountPlan;
  readonly series: string;
  readonly orgNumber: string | null;
  readonly purchaseBasis: PurchaseBasis;
  readonly openingCarryOre: number;
  /** Sant när inställningarna sparats (annars visas förslaget). */
  readonly saved: boolean;
}

export const DEFAULT_SETTINGS: BokforingSettings = {
  plan: DEFAULT_PLAN,
  // Egen serie så att numren (månadens ordning i räkenskapsåret) inte krockar med Talenoms A.
  series: "BL",
  orgNumber: null,
  purchaseBasis: "received_purchases",
  openingCarryOre: 0,
  saved: false,
};

export interface MonthSnapshot {
  readonly salesInclVatOre: number;
  readonly refundsOre: number;
  readonly purchasesOre: number;
  readonly vatOre: number;
  readonly carryInOre: number;
  readonly carryOutOre: number;
  readonly storeShareOre: number;
  readonly resultOre: number;
}

export interface ReceiptRow {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
}

export interface MonthRow {
  readonly month: string;
  readonly status: MonthStatus;
  readonly sentAt: string | null;
  /** Siffrorna har ändrats sedan månaden markerades som skickad. */
  readonly changedSinceSent: boolean;
  /** Verifikationen har rader (annars finns ingen SIE-fil att importera). */
  readonly hasVoucher: boolean;
  readonly book: MonthBook;
  readonly receipts: readonly ReceiptRow[];
}

export interface BokforingView {
  /** Nyast först. */
  readonly months: readonly MonthRow[];
  readonly settings: BokforingSettings;
}

/** Fel som visas som de är. */
export class BokforingError extends AccountingError {
  constructor(message: string) {
    super(message);
    this.name = "BokforingError";
  }
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertMonth(month: string): void {
  if (!MONTH.test(month)) throw new BokforingError("Ogiltig månad.");
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

async function asRole<T>(
  viewer: Viewer,
  roles: readonly MemberRole[],
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, roles);
  return withUserDbFor(viewer.user, fn);
}

// ---------------------------------------------------------------------------
// Läsning
// ---------------------------------------------------------------------------

async function readSettings(tx: Tx, orgId: string): Promise<BokforingSettings> {
  const [row] = await tx
    .select()
    .from(s.bookkeepingSettings)
    .where(eq(s.bookkeepingSettings.organizationId, orgId));
  if (!row) return DEFAULT_SETTINGS;
  return {
    plan: parseAccountPlan(row.accountPlan),
    series: row.voucherSeries,
    orgNumber: row.orgNumber,
    purchaseBasis: row.purchaseBasis,
    openingCarryOre: row.openingCarryOre,
    saved: true,
  };
}

/** Första månaden med order (organisationens tidszon), annars innevarande. */
async function firstMonth(tx: Tx, orgId: string, timeZone: string, today: IsoDate) {
  const result = await tx.execute(
    sql`select to_char(min(o.ordered_at at time zone ${timeZone}), 'YYYY-MM') as m
        from public.orders o where o.organization_id = ${orgId}::uuid`,
  );
  const m = (Array.from(result)[0] as { m: string | null } | undefined)?.m ?? null;
  const thisMonth = today.slice(0, 7);
  return m && MONTH.test(m) && m <= thisMonth ? m : thisMonth;
}

function toSnapshot(b: MonthBook): MonthSnapshot {
  return {
    salesInclVatOre: b.salesInclVatOre,
    refundsOre: b.refundsOre,
    purchasesOre: b.purchasesOre,
    vatOre: b.vmb.vatOre,
    carryInOre: b.vmb.carryInOre,
    carryOutOre: b.vmb.carryOutOre,
    storeShareOre: b.storeShareOre,
    resultOre: b.resultOre,
  };
}

function parseSnapshot(raw: unknown): MonthSnapshot | null {
  const r = z
    .object({
      salesInclVatOre: z.number().int(),
      refundsOre: z.number().int().default(0),
      purchasesOre: z.number().int(),
      vatOre: z.number().int(),
      carryInOre: z.number().int(),
      carryOutOre: z.number().int().min(0),
      storeShareOre: z.number().int(),
      resultOre: z.number().int(),
    })
    .safeParse(raw);
  return r.success ? r.data : null;
}

interface Built {
  readonly settings: BokforingSettings;
  readonly books: MonthBook[];
  readonly sent: Map<string, { sentAt: string; snapshot: MonthSnapshot | null }>;
}

/** Alla månader från den första med order till och med `until`, med VMB-kedjan. */
async function build(tx: Tx, viewer: Viewer, today: IsoDate, until: string): Promise<Built> {
  const orgId = viewer.organization.id;
  const [settings, first, sentRows] = await Promise.all([
    readSettings(tx, orgId),
    firstMonth(tx, orgId, viewer.organization.timezone, today),
    tx.select().from(s.bookkeepingMonths).where(eq(s.bookkeepingMonths.organizationId, orgId)),
  ]);
  const months = eachMonth(`${first}-01`, `${until}-01`);
  const reports = await monthReportsIn(tx, orgId, months);
  const figures = months.map((m) => {
    const r = reports.get(m)!;
    try {
      return monthFiguresFromReport(
        m,
        r.report,
        r.receivedPurchasesOre,
        settings.purchaseBasis,
        r.refundsOre,
      );
    } catch (error) {
      if (error instanceof VmbVatRateError) throw new BokforingError(error.message);
      throw error;
    }
  });
  const sent = new Map<string, { sentAt: string; snapshot: MonthSnapshot | null }>();
  for (const r of sentRows) {
    if (r.sentAt) {
      sent.set(r.month.slice(0, 7), {
        sentAt: r.sentAt.toISOString(),
        snapshot: parseSnapshot(r.snapshot),
      });
    }
  }
  const carry = new Map<string, number>();
  for (const [m, v] of sent) if (v.snapshot) carry.set(m, v.snapshot.carryOutOre);
  return { settings, books: bookMonths(figures, settings.openingCarryOre, carry), sent };
}

function changed(b: MonthBook, snap: MonthSnapshot | null): boolean {
  if (!snap) return false;
  const now = toSnapshot(b);
  return (Object.keys(now) as (keyof MonthSnapshot)[]).some((k) => now[k] !== snap[k]);
}

async function receiptsIn(tx: Tx, orgId: string, month?: string) {
  return tx
    .select()
    .from(s.bookkeepingReceipts)
    .where(
      and(
        eq(s.bookkeepingReceipts.organizationId, orgId),
        isNull(s.bookkeepingReceipts.archivedAt),
        month ? eq(s.bookkeepingReceipts.month, `${month}-01`) : undefined,
      ),
    )
    .orderBy(asc(s.bookkeepingReceipts.createdAt), asc(s.bookkeepingReceipts.id));
}

/** Månadsraderna (nyast först) och inställningarna. */
export async function loadBokforingFor(viewer: Viewer, today: IsoDate): Promise<BokforingView> {
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const thisMonth = today.slice(0, 7);
    const built = await build(tx, viewer, today, thisMonth);
    const receipts = await receiptsIn(tx, viewer.organization.id);
    const byMonth = new Map<string, ReceiptRow[]>();
    for (const r of receipts) {
      const m = r.month.slice(0, 7);
      const list = byMonth.get(m) ?? [];
      list.push({
        id: r.id,
        fileName: r.fileName,
        contentType: r.contentType,
        sizeBytes: r.sizeBytes,
        uploadedAt: r.createdAt.toISOString(),
      });
      byMonth.set(m, list);
    }
    const months = built.books
      .map((b): MonthRow => {
        const sent = built.sent.get(b.month) ?? null;
        return {
          month: b.month,
          status: sent ? "sent" : b.month === thisMonth ? "open" : "closed",
          sentAt: sent?.sentAt ?? null,
          changedSinceSent: sent ? changed(b, sent.snapshot) : false,
          hasVoucher:
            monthVerification(b, built.settings.plan, built.settings.series, 1).rows.length > 0,
          book: b,
          receipts: byMonth.get(b.month) ?? [],
        };
      })
      .reverse();
    return { months, settings: built.settings };
  });
}

// ---------------------------------------------------------------------------
// Inställningar
// ---------------------------------------------------------------------------

export const settingsSchema = z.object({
  plan: accountPlanSchema,
  series: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, "Serien är 1–6 bokstäver eller siffror."),
  orgNumber: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v.replace(/^(\d{6})(\d{4})$/, "$1-$2")))
    .refine((v) => v === null || /^\d{6}-\d{4}$/.test(v), "Organisationsnummer: NNNNNN-NNNN.")
    .nullable(),
  purchaseBasis: z.enum(["received_purchases", "cost_of_goods"]),
  openingCarryOre: z
    .number()
    .int("Underskottet anges i hela ören.")
    .min(0, "Underskottet kan inte vara negativt.")
    .max(100_000_000_000),
});

export type BokforingSettingsInput = z.input<typeof settingsSchema>;

export async function saveBokforingSettingsFor(
  viewer: Viewer,
  raw: BokforingSettingsInput,
): Promise<void> {
  const input = settingsSchema.parse(raw);
  const orgId = viewer.organization.id;
  const plan = JSON.stringify({ ...input.plan });
  // Rå SQL: klientrollen har bara behörighet på de kolumner som skrivs.
  await asRole(viewer, OPERATOR_ROLES, async (tx) => {
    await tx.execute(sql`
      insert into public.bookkeeping_settings
        (organization_id, account_plan, voucher_series, org_number, purchase_basis, opening_carry_ore)
      values (${orgId}::uuid, ${plan}::jsonb, ${input.series}, ${input.orgNumber},
              ${input.purchaseBasis}, ${input.openingCarryOre})
      on conflict (organization_id) do update set
        account_plan = excluded.account_plan,
        voucher_series = excluded.voucher_series,
        org_number = excluded.org_number,
        purchase_basis = excluded.purchase_basis,
        opening_carry_ore = excluded.opening_carry_ore`);
  });
}

// ---------------------------------------------------------------------------
// Skickad
// ---------------------------------------------------------------------------

/** Markerar en avslutad månad som skickad, med dagens siffror som ögonblicksbild. */
export async function markMonthSentFor(
  viewer: Viewer,
  month: string,
  today: IsoDate,
): Promise<{ sentAt: string }> {
  assertMonth(month);
  if (month >= today.slice(0, 7)) {
    throw new BokforingError(`${capital(monthText(month))} är inte slut.`);
  }
  const orgId = viewer.organization.id;
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bokforing:${orgId}`}))`);
    const built = await build(tx, viewer, today, month);
    const book = built.books.find((b) => b.month === month);
    if (!book) throw new BokforingError("Månaden saknas.");
    if (book.profitSplitUnpricedOrders > 0) {
      throw new BokforingError(
        `Butikernas andel är inte färdigräknad: ${book.profitSplitUnpricedOrders} order saknar inköpspris.`,
      );
    }
    const snapshot = JSON.stringify(toSnapshot(book));
    const result = await tx.execute(sql`
      insert into public.bookkeeping_months (organization_id, month, sent_at, snapshot)
      values (${orgId}::uuid, ${`${month}-01`}::date, now(), ${snapshot}::jsonb)
      on conflict (organization_id, month) do update set
        sent_at = excluded.sent_at,
        snapshot = case when bookkeeping_months.sent_at is null
                        then excluded.snapshot else bookkeeping_months.snapshot end
      returning sent_at::text as sent_at`);
    const row = Array.from(result)[0] as { sent_at: string };
    return { sentAt: new Date(row.sent_at).toISOString() };
  });
}

/** Ångrar "skickad" (månaden blir stängd igen). */
export async function unmarkMonthSentFor(viewer: Viewer, month: string): Promise<void> {
  assertMonth(month);
  await asRole(viewer, OPERATOR_ROLES, async (tx) => {
    await tx
      .update(s.bookkeepingMonths)
      .set({ sentAt: null })
      .where(
        and(
          eq(s.bookkeepingMonths.organizationId, viewer.organization.id),
          eq(s.bookkeepingMonths.month, `${month}-01`),
        ),
      );
  });
}

// ---------------------------------------------------------------------------
// Kvitton
// ---------------------------------------------------------------------------

export async function uploadReceiptFor(
  viewer: Viewer,
  month: string,
  file: { name: string; bytes: Uint8Array },
  today: IsoDate,
  store?: FileStore,
): Promise<{ id: string; duplicate: boolean }> {
  assertMonth(month);
  if (month > today.slice(0, 7)) throw new BokforingError("Månaden har inte börjat.");
  const check = checkReceipt(file.bytes);
  if (!check.ok) throw new BokforingError(check.error);
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const sha = sha256Hex(file.bytes);
  const path = receiptStoragePath(orgId, month, sha, check.contentType);
  const files = store ?? (await receiptFileStore());
  await files.put(path, file.bytes, check.contentType);
  return withUserDbFor(viewer.user, async (tx) => {
    const [existing] = await tx
      .select({ id: s.bookkeepingReceipts.id })
      .from(s.bookkeepingReceipts)
      .where(
        and(
          eq(s.bookkeepingReceipts.organizationId, orgId),
          eq(s.bookkeepingReceipts.month, `${month}-01`),
          eq(s.bookkeepingReceipts.fileSha256, sha),
          isNull(s.bookkeepingReceipts.archivedAt),
        ),
      );
    if (existing) return { id: existing.id, duplicate: true };
    const result = await tx.execute(sql`
      insert into public.bookkeeping_receipts
        (organization_id, month, storage_path, file_name, content_type, size_bytes, file_sha256)
      values (${orgId}::uuid, ${`${month}-01`}::date, ${path}, ${cleanFileName(file.name)},
              ${check.contentType}, ${file.bytes.byteLength}, ${sha})
      returning id::text as id`);
    return { id: (Array.from(result)[0] as { id: string }).id, duplicate: false };
  });
}

export async function archiveReceiptFor(viewer: Viewer, id: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) throw new BokforingError("Kvittot finns inte.");
  await asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const rows = await tx
      .update(s.bookkeepingReceipts)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(s.bookkeepingReceipts.organizationId, viewer.organization.id),
          eq(s.bookkeepingReceipts.id, id),
          isNull(s.bookkeepingReceipts.archivedAt),
        ),
      )
      .returning({ id: s.bookkeepingReceipts.id });
    if (rows.length === 0) throw new BokforingError("Kvittot finns inte.");
  });
}

export async function readReceiptFor(
  viewer: Viewer,
  id: string,
  store?: FileStore,
): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }> {
  if (!z.uuid().safeParse(id).success) throw new BokforingError("Kvittot finns inte.");
  const row = await asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const [r] = await tx
      .select()
      .from(s.bookkeepingReceipts)
      .where(
        and(
          eq(s.bookkeepingReceipts.organizationId, viewer.organization.id),
          eq(s.bookkeepingReceipts.id, id),
          isNull(s.bookkeepingReceipts.archivedAt),
        ),
      );
    return r ?? null;
  });
  if (!row) throw new BokforingError("Kvittot finns inte.");
  const bytes = await (store ?? (await receiptFileStore())).get(row.storagePath);
  if (sha256Hex(bytes) !== row.fileSha256) throw new BokforingError("Kvittots fil är ändrad.");
  return { fileName: row.fileName, contentType: row.contentType, bytes };
}

// ---------------------------------------------------------------------------
// Månadspaketet
// ---------------------------------------------------------------------------

export async function monthPackageFor(
  viewer: Viewer,
  month: string,
  today: IsoDate,
  opts: {
    readonly store?: FileStore;
    readonly renderPdf?: ((html: string) => Promise<Uint8Array>) | null;
  } = {},
): Promise<MonthPackage> {
  assertMonth(month);
  if (month >= today.slice(0, 7)) {
    throw new BokforingError(
      `${capital(monthText(month))} pågår. Paketet kan laddas ned när månaden är slut.`,
    );
  }
  const orgId = viewer.organization.id;
  const data = await asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const built = await build(tx, viewer, today, month);
    const [settings, receipts] = await Promise.all([
      querySettings(tx, orgId),
      receiptsIn(tx, orgId, month),
    ]);
    return { built, fiscalStart: settings.fiscalYearStartMonth, receipts };
  });
  const book = data.built.books.find((b) => b.month === month);
  if (!book) throw new BokforingError("Månaden saknas.");
  const fiscalYear = fiscalYearOf(month, data.fiscalStart);
  const ordinal = eachMonth(fiscalYear.start, `${month}-01`).length;
  const files = data.receipts.length > 0 ? (opts.store ?? (await receiptFileStore())) : null;
  const receipts = [];
  for (const r of data.receipts) {
    const bytes = await files!.get(r.storagePath);
    receipts.push({
      fileName: r.fileName,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      sha256: r.fileSha256,
      uploadedOn: businessToday(r.createdAt, viewer.organization.timezone),
      data: bytes,
    });
  }
  const sent = data.built.sent.get(month);
  return buildMonthPackage({
    company: viewer.organization.name,
    orgNumber: data.built.settings.orgNumber,
    book,
    plan: data.built.settings.plan,
    series: data.built.settings.series,
    number: ordinal,
    fiscalYear,
    generatedOn: today,
    sentOn: sent ? businessToday(new Date(sent.sentAt), viewer.organization.timezone) : null,
    receipts,
    renderPdf: opts.renderPdf ?? null,
  });
}
