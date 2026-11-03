/**
 * Butiksportalens frågor: bara portal_*-funktionerna i databasen (security
 * definer, kontrollerar att anroparen är butiksanvändare för just den butiken).
 * Allt körs som användaren med RLS (withUserDbFor). Ingen appfråga och ingen
 * tabell läses direkt härifrån.
 *
 * Oberoende av Next, så att test/db/portal-*.test.ts kan anropa samma kod.
 */

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import type { IsoDate, Period } from "@/domain";

import type { PortalAgreementRow, PortalMachineRow, PortalSaleRow, PortalStore } from "./model";

type Row = Record<string, unknown>;

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
  return Array.from(await tx.execute(query)) as Row[];
}

const num = (v: unknown): number => (v === null || v === undefined ? Number.NaN : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

/** Butikerna där användaren är butiksanvändare. */
export async function queryPortalStores(tx: Tx): Promise<PortalStore[]> {
  const result = await rows(
    tx,
    sql`select store_id, store_name, organization_id, organization_name, timezone, vat_rate_bp
        from public.portal_stores()`,
  );
  return result.map((r) => ({
    storeId: str(r.store_id),
    storeName: str(r.store_name),
    organizationId: str(r.organization_id),
    organizationName: str(r.organization_name),
    timezone: str(r.timezone),
    vatRateBp: num(r.vat_rate_bp),
  }));
}

/** Butikens försäljning i perioden. */
export async function queryPortalSales(
  tx: Tx,
  storeId: string,
  period: Period,
): Promise<PortalSaleRow[]> {
  const result = await rows(
    tx,
    sql`select business_date::text as business_date, machine_id, title_id, title_name,
               amount_ore, order_count
        from public.portal_sales(${storeId}::uuid, ${period.start}::date, ${period.end}::date)`,
  );
  return result.map((r) => ({
    businessDate: str(r.business_date) as IsoDate,
    machineId: strOrNull(r.machine_id),
    titleId: strOrNull(r.title_id),
    titleName: str(r.title_name),
    amountOre: num(r.amount_ore),
    orderCount: num(r.order_count),
  }));
}

/** Första dagen med försäljning i butiken (inom de senaste tre åren), eller null. */
export async function queryPortalFirstSale(
  tx: Tx,
  storeId: string,
  today: IsoDate,
): Promise<IsoDate | null> {
  const result = await rows(
    tx,
    sql`select min(business_date)::text as first
        from public.portal_sales(${storeId}::uuid, ${today}::date - 1095, ${today}::date)`,
  );
  return strOrNull(result[0]?.first) as IsoDate | null;
}

/** Butikens avtalsvillkor. */
export async function queryPortalAgreements(
  tx: Tx,
  storeId: string,
): Promise<PortalAgreementRow[]> {
  const result = await rows(
    tx,
    sql`select valid_from::text as valid_from, valid_to::text as valid_to, commission_bp, monthly_rent_ore,
               commission_base::text as commission_base, loss_treatment::text as loss_treatment,
               vmb_before_split
        from public.portal_agreements(${storeId}::uuid)`,
  );
  return result.map((r) => ({
    validFrom: str(r.valid_from) as IsoDate,
    validTo: strOrNull(r.valid_to) as IsoDate | null,
    commissionBp: numOrNull(r.commission_bp),
    monthlyRentOre: numOrNull(r.monthly_rent_ore),
    commissionBase:
      str(r.commission_base) === "profit_after_costs" ? "profit_after_costs" : "net_excl_vat",
    lossTreatment: str(r.loss_treatment) === "proportional" ? "proportional" : "zero",
    vmbBeforeSplit: r.vmb_before_split === true,
  }));
}

/** Automaterna och perioderna då de stod i butiken. */
export async function queryPortalMachines(tx: Tx, storeId: string): Promise<PortalMachineRow[]> {
  const result = await rows(
    tx,
    sql`select machine_id, code, name, placed_from::text as placed_from, placed_to::text as placed_to
        from public.portal_machines(${storeId}::uuid)`,
  );
  return result.map((r) => ({
    machineId: str(r.machine_id),
    code: str(r.code),
    name: str(r.name),
    placedFrom: str(r.placed_from) as IsoDate,
    placedTo: strOrNull(r.placed_to) as IsoDate | null,
  }));
}

export interface PortalReportListItem {
  readonly reportId: string;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly generatedAt: string;
  readonly hasPdf: boolean;
  readonly hasReport: boolean;
}

/** Butikens rapporter, senaste först. */
export async function queryPortalReports(tx: Tx, storeId: string): Promise<PortalReportListItem[]> {
  const result = await rows(
    tx,
    sql`select report_id, period_start::text as period_start, period_end::text as period_end,
               generated_at, has_pdf, has_report
        from public.portal_reports(${storeId}::uuid)`,
  );
  return result.map((r) => ({
    reportId: str(r.report_id),
    periodStart: str(r.period_start) as IsoDate,
    periodEnd: str(r.period_end) as IsoDate,
    generatedAt: iso(r.generated_at) ?? "",
    hasPdf: r.has_pdf === true,
    hasReport: r.has_report === true,
  }));
}

export interface PortalReportDetail extends Omit<PortalReportListItem, "hasPdf" | "hasReport"> {
  readonly storagePath: string | null;
  /** Rapportens innehåll om det är en säker butiksrapport för butiken, annars null. */
  readonly report: unknown;
}

/** En av butikens rapporter. Kastar (P0002) om den inte finns hos butiken. */
export async function queryPortalReport(
  tx: Tx,
  storeId: string,
  reportId: string,
): Promise<PortalReportDetail> {
  const result = await rows(
    tx,
    sql`select report_id, period_start::text as period_start, period_end::text as period_end,
               generated_at, storage_path, report
        from public.portal_report(${storeId}::uuid, ${reportId}::uuid)`,
  );
  const r = result[0]!;
  return {
    reportId: str(r.report_id),
    periodStart: str(r.period_start) as IsoDate,
    periodEnd: str(r.period_end) as IsoDate,
    generatedAt: iso(r.generated_at) ?? "",
    storagePath: strOrNull(r.storage_path),
    report: r.report ?? null,
  };
}

export interface PortalFault {
  readonly incidentId: string;
  readonly machineId: string;
  readonly kind: string;
  readonly description: string | null;
  readonly status: string | null;
  readonly reportedAt: string;
  readonly resolvedAt: string | null;
}

/** Butikens felanmälningar, senaste först. */
export async function queryPortalFaults(tx: Tx, storeId: string): Promise<PortalFault[]> {
  const result = await rows(
    tx,
    sql`select incident_id, machine_id, kind, description, status, reported_at, resolved_at
        from public.portal_faults(${storeId}::uuid)`,
  );
  return result.map((r) => ({
    incidentId: str(r.incident_id),
    machineId: str(r.machine_id),
    kind: str(r.kind),
    description: strOrNull(r.description),
    status: strOrNull(r.status),
    reportedAt: iso(r.reported_at) ?? "",
    resolvedAt: iso(r.resolved_at),
  }));
}

/** Gör en felanmälan. Returnerar ärendets id. */
export async function insertPortalFault(
  tx: Tx,
  input: { storeId: string; machineId: string; kind: string; description: string | null },
): Promise<string> {
  const result = await rows(
    tx,
    sql`select public.portal_report_fault(
          ${input.storeId}::uuid, ${input.machineId}::uuid, ${input.kind}, ${input.description}
        ) as id`,
  );
  return str(result[0]?.id);
}

/** Bjuder in en butiksanvändare (ägare/admin). Returnerar token i klartext (visas en gång). */
export async function insertStoreInvitation(
  tx: Tx,
  input: { organizationId: string; storeId: string; email: string; validDays?: number },
): Promise<string> {
  const result = await rows(
    tx,
    sql`select public.create_store_invitation(
          ${input.organizationId}::uuid, ${input.storeId}::uuid, ${input.email},
          ${input.validDays ?? 14}::integer
        ) as token`,
  );
  const token = result[0]?.token;
  if (typeof token !== "string")
    throw new Error("create_store_invitation returnerade ingen token.");
  return token;
}
