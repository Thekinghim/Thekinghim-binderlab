/**
 * Underlaget för sidan Rapporter: valbara månader och butiker, förhandsvisningen,
 * arkivet, mottagarna och hur många av månadens utskick som är gjorda. Allt läses som
 * användaren (RLS) efter en rollkontroll; påfyllaren når aldrig hit.
 */

import "server-only";

import { eq } from "drizzle-orm";

import * as s from "@/db/schema";
import { addMonths, monthEnd, monthOf, monthStart, type IsoMonth } from "@/domain";
import { businessToday } from "@/server/data/core/loaders";
import { queryFirstOrderDate, queryPlacements, queryStores } from "@/server/data/core/queries";
import { requireRoleFor, withUserDbFor } from "@/server/access";

import { RECIPIENT_KIND, TYPE_BY_RECIPIENT_KIND, isReportType, type ReportType } from "./kinds";
import {
  eligibleRecipients,
  listArchiveFor,
  listRecipientsTx,
  previewReportFor,
  ReportError,
  selectableMonths,
  type ArchiveRow,
  type RecipientRow,
  type Viewer,
} from "./service";
import type { ReportSnapshot } from "./snapshot";
import { storesPlacedIn } from "./sources";
import { DONE_DELIVERY } from "./status";

export interface ReportsPageParams {
  readonly typ?: string | null;
  readonly manad?: string | null;
  /** Todo-länkarna använder ?period=ÅÅÅÅ-MM. */
  readonly period?: string | null;
  readonly butiken?: string | null;
  readonly mottagare?: string | null;
}

export interface StoreChoice {
  readonly id: string;
  readonly name: string;
}

/** En förväntad leverans för månaden: en aktiv mottagare och om den fått sin rapport. */
export interface ExpectedDelivery {
  readonly recipient: RecipientRow;
  readonly type: ReportType;
  readonly storeName: string | null;
  readonly delivered: boolean;
}

export interface ReportsPageData {
  readonly canEdit: boolean;
  readonly type: ReportType;
  readonly month: IsoMonth;
  readonly months: readonly IsoMonth[];
  readonly stores: readonly StoreChoice[];
  readonly allStores: readonly StoreChoice[];
  readonly storeId: string | null;
  readonly preview: ReportSnapshot | null;
  readonly previewError: string | null;
  /** Senaste sparade versionen för valet (typ, månad, butik). */
  readonly current: ArchiveRow | null;
  readonly archive: readonly ArchiveRow[];
  readonly recipients: readonly RecipientRow[];
  /** Mottagare som kan få den valda rapporten. */
  readonly eligible: readonly RecipientRow[];
  readonly expected: readonly ExpectedDelivery[];
  readonly ownersConfigured: boolean;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function loadReportsPage(
  viewer: Viewer,
  params: ReportsPageParams,
  now: Date = new Date(),
): Promise<ReportsPageData> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, ["owner", "admin", "viewer"]);
  const canEdit = role === "owner" || role === "admin";
  const today = businessToday(now, viewer.organization.timezone);

  const base = await withUserDbFor(viewer.user, async (tx) => {
    const [dataStart, placements, stores, recipients, owners] = await Promise.all([
      queryFirstOrderDate(tx, orgId),
      queryPlacements(tx, orgId),
      queryStores(tx, orgId),
      listRecipientsTx(tx, orgId),
      tx
        .select({ id: s.ownerShares.id })
        .from(s.ownerShares)
        .where(eq(s.ownerShares.organizationId, orgId))
        .limit(1),
    ]);
    return { dataStart, placements, stores, recipients, ownersConfigured: owners.length > 0 };
  });

  const months = selectableMonths(base.dataStart, today);
  const recipient = base.recipients.find((r) => r.id === params.mottagare) ?? null;
  const rawMonth = params.manad ?? params.period ?? "";
  const month: IsoMonth =
    MONTH.test(rawMonth) && rawMonth < monthOf(today)
      ? (rawMonth as IsoMonth)
      : addMonths(monthOf(today), -1);
  const type: ReportType = isReportType(params.typ)
    ? params.typ
    : recipient
      ? TYPE_BY_RECIPIENT_KIND[recipient.kind]
      : "butik";

  const period = { start: monthStart(month), end: monthEnd(month) };
  const placedIds = storesPlacedIn(base.placements, period);
  const storeName = new Map(base.stores.map((x) => [x.id, x.name]));
  const stores = placedIds.map((id) => ({ id, name: storeName.get(id) ?? id }));
  stores.sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const wantedStore =
    params.butiken ?? (recipient?.kind === "store" ? recipient.storeId : null) ?? null;
  const storeId =
    type === "butik"
      ? (stores.find((x) => x.id === wantedStore)?.id ?? stores[0]?.id ?? null)
      : null;

  let preview: ReportSnapshot | null = null;
  let previewError: string | null = null;
  if (type === "butik" && !storeId) {
    previewError = "Ingen butik hade en automat under månaden.";
  } else {
    try {
      preview = await previewReportFor(viewer, { type, month, storeId }, now);
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      previewError = error.message;
    }
  }

  const archive = await listArchiveFor(viewer);
  const current =
    archive.find(
      (r) =>
        r.type === type &&
        r.month === month &&
        (type !== "butik" || r.storeId === storeId) &&
        r.status !== "superseded",
    ) ?? null;

  // Månadens utskick: varje aktiv mottagare vars butik hade en automat (som i Att göra).
  const expected: ExpectedDelivery[] = [];
  for (const r of base.recipients) {
    if (!r.active) continue;
    if (r.kind === "store" && (!r.storeId || !placedIds.includes(r.storeId))) continue;
    const t = TYPE_BY_RECIPIENT_KIND[r.kind];
    const delivered = archive.some(
      (a) =>
        a.type === t &&
        a.month === month &&
        (t !== "butik" || a.storeId === r.storeId) &&
        a.deliveries.some((d) => d.recipientId === r.id && DONE_DELIVERY.has(d.status)),
    );
    expected.push({
      recipient: r,
      type: t,
      storeName: r.storeId ? (storeName.get(r.storeId) ?? null) : null,
      delivered,
    });
  }

  return {
    canEdit,
    type,
    month,
    months,
    stores,
    allStores: base.stores
      .filter((x) => !x.archived)
      .map((x) => ({ id: x.id, name: x.name })),
    storeId,
    preview,
    previewError,
    current,
    archive,
    recipients: base.recipients,
    eligible: preview
      ? eligibleRecipients(preview, base.recipients)
      : base.recipients.filter((r) => r.active && r.kind === RECIPIENT_KIND[type]),
    expected,
    ownersConfigured: base.ownersConfigured,
  };
}
