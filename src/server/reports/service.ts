/**
 * Rapporter: läsning, skapande, godkännande, PDF och utskick.
 *
 * Varje funktion tar den verifierade användaren och den aktiva organisationen (Viewer),
 * kontrollerar rollen mot databasen (requireRoleFor) och läser/skriver sedan som
 * användaren med RLS (withUserDbFor). Ingen funktion här används av påfyllaren: alla
 * kräver ägare, admin eller läsare, och allt som ändrar något kräver ägare eller admin.
 *
 * Flödet: skapa (utkast med data_snapshot och calc_version) → godkänn (report_approvals)
 * → skicka (report_deliveries, en rad per mottagare och försök). Inget skickas utan
 * godkännande. PDF:en skapas före godkännandet (server action) eller vid första
 * nedladdningen och sparas i lagringen på reports.storage_path; report_files visar att
 * filen faktiskt finns.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import {
  addMonths,
  DomainError,
  monthEnd,
  monthOf,
  monthStart,
  parseIsoMonth,
  type IsoMonth,
  type Period,
} from "@/domain";
import type { MemberRole } from "@/db/schema";
import { isValidStoragePath, type FileStore } from "@/import/file-store";
import {
  AuthorizationError,
  requireRoleFor,
  withUserDbFor,
  type OrganizationMembership,
  type SessionUser,
} from "@/server/access";
import { businessToday } from "@/server/data/core/loaders";
import type { Mailer, MailAttachment } from "@/server/mail/report-mailer";
import { recordReportSend, type MonitoringDeps } from "@/server/monitoring/failures";
import { isWholeMonth, monthText, periodText } from "@/reports/text";

import { buildSubject, renderReportText } from "@/emails/report-content";

import { closeDraftsAlertIfComplete } from "./draft-coverage";
import { reportEmailProps } from "./email";
import { cleanEmailText } from "./email-cleanup";
import { CONTENT_TYPE, excelOf, reportFileName, sieOf } from "./files";
import {
  DB_KIND,
  RECIPIENT_KIND,
  TYPE_BY_DB_KIND,
  TYPE_LABEL,
  isReportDbKind,
  type RecipientDbKind,
  type ReportType,
} from "./kinds";
import { allowsRange, rangeError } from "./range";
import {
  asSnapshot,
  buildSnapshot,
  headlineOreOf,
  requestOf,
  sameReport,
  storeIdOf,
  type ReportSnapshot,
} from "./snapshot";
import { loadSnapshotInput, storesPlacedIn } from "./sources";
import { DONE_DELIVERY, reportStatuses, type DeliveryStatus, type ReportStatus } from "./status";
import { reportPdfPath } from "./storage";

export interface Viewer {
  readonly user: SessionUser;
  readonly organization: OrganizationMembership;
}

const READ_ROLES: readonly MemberRole[] = ["owner", "admin", "viewer"];
const EDIT_ROLES: readonly MemberRole[] = ["owner", "admin"];

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

async function as<T>(
  viewer: Viewer,
  roles: readonly MemberRole[],
  fn: (tx: Tx, role: MemberRole) => Promise<T>,
): Promise<T> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, roles);
  return withUserDbFor(viewer.user, (tx) => fn(tx, role));
}

// ---------------------------------------------------------------------------
// Typer för UI:t
// ---------------------------------------------------------------------------

export interface RecipientRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly kind: RecipientDbKind;
  readonly storeId: string | null;
  readonly active: boolean;
}

export interface DeliveryRow {
  readonly id: string;
  readonly recipientId: string | null;
  /** null = delad för hand utan mottagare i appen. */
  readonly email: string | null;
  /** Delad för hand ("Skickade du den?"), inte skickad från appen. */
  readonly manual: boolean;
  readonly status: DeliveryStatus;
  readonly sentAt: string | null;
  readonly error: string | null;
  readonly createdAt: string;
}

export interface ArchiveRow {
  readonly id: string;
  readonly type: ReportType;
  readonly month: IsoMonth;
  /** Rapportens dagar: hela månaden eller ett eget datum. */
  readonly period: Period;
  /** Sant för eget datum (inte en hel kalendermånad). */
  readonly custom: boolean;
  readonly storeId: string | null;
  readonly storeName: string | null;
  readonly generatedAt: string;
  readonly generatedBy: string | null;
  readonly calcVersion: string;
  readonly hasPdf: boolean;
  readonly status: ReportStatus;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly deliveries: readonly DeliveryRow[];
  readonly conclusion: string;
}

export interface ReportDetail extends ArchiveRow {
  readonly snapshot: ReportSnapshot;
  readonly storagePath: string | null;
}

// ---------------------------------------------------------------------------
// Läsning
// ---------------------------------------------------------------------------

export async function listRecipientsTx(tx: Tx, orgId: string): Promise<RecipientRow[]> {
  const rows = await tx
    .select({
      id: s.reportRecipients.id,
      name: s.reportRecipients.name,
      email: s.reportRecipients.email,
      kind: s.reportRecipients.kind,
      storeId: s.reportRecipients.storeId,
      active: s.reportRecipients.active,
    })
    .from(s.reportRecipients)
    .where(eq(s.reportRecipients.organizationId, orgId))
    .orderBy(asc(s.reportRecipients.kind), asc(s.reportRecipients.name));
  return rows.map((r) => ({ ...r, email: String(r.email) }));
}

async function profileNames(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ userId: s.profiles.userId, name: s.profiles.displayName })
    .from(s.profiles)
    .where(eq(s.profiles.organizationId, orgId));
  const out = new Map<string, string>();
  for (const r of rows) if (r.userId && r.name) out.set(r.userId, r.name);
  return out;
}

async function archiveTx(tx: Tx, orgId: string, limit: number, ids?: string[]) {
  const where = ids
    ? and(eq(s.reports.organizationId, orgId), inArray(s.reports.id, ids))
    : eq(s.reports.organizationId, orgId);
  const reports = await tx
    .select({
      id: s.reports.id,
      kind: s.reports.kind,
      periodStart: s.reports.periodStart,
      periodEnd: s.reports.periodEnd,
      storeId: s.reports.storeId,
      storagePath: s.reports.storagePath,
      generatedAt: s.reports.generatedAt,
      generatedBy: s.reports.generatedBy,
      calcVersion: s.reports.calcVersion,
      snapshot: s.reports.dataSnapshot,
    })
    .from(s.reports)
    .where(where)
    .orderBy(desc(s.reports.periodStart), desc(s.reports.generatedAt))
    .limit(limit);
  const reportIds = reports.map((r) => r.id);
  const [approvals, deliveries, stores, names, files] = await Promise.all([
    reportIds.length
      ? tx
          .select({
            reportId: s.reportApprovals.reportId,
            approvedAt: s.reportApprovals.approvedAt,
            approvedBy: s.reportApprovals.approvedBy,
          })
          .from(s.reportApprovals)
          .where(
            and(
              eq(s.reportApprovals.organizationId, orgId),
              inArray(s.reportApprovals.reportId, reportIds),
            ),
          )
      : Promise.resolve([]),
    reportIds.length
      ? tx
          .select({
            id: s.reportDeliveries.id,
            reportId: s.reportDeliveries.reportId,
            recipientId: s.reportDeliveries.recipientId,
            email: s.reportDeliveries.email,
            channel: s.reportDeliveries.channel,
            status: s.reportDeliveries.status,
            sentAt: s.reportDeliveries.sentAt,
            error: s.reportDeliveries.error,
            createdAt: s.reportDeliveries.createdAt,
          })
          .from(s.reportDeliveries)
          .where(
            and(
              eq(s.reportDeliveries.organizationId, orgId),
              inArray(s.reportDeliveries.reportId, reportIds),
            ),
          )
          .orderBy(asc(s.reportDeliveries.createdAt))
      : Promise.resolve([]),
    tx
      .select({ id: s.stores.id, name: s.stores.name })
      .from(s.stores)
      .where(eq(s.stores.organizationId, orgId)),
    profileNames(tx, orgId),
    reportIds.length
      ? tx
          .select({ reportId: s.reportFiles.reportId })
          .from(s.reportFiles)
          .where(
            and(
              eq(s.reportFiles.organizationId, orgId),
              eq(s.reportFiles.kind, "pdf"),
              inArray(s.reportFiles.reportId, reportIds),
            ),
          )
      : Promise.resolve([]),
  ]);
  return { reports, approvals, deliveries, stores, names, files };
}

function toArchive(data: Awaited<ReturnType<typeof archiveTx>>, all: boolean) {
  const approval = new Map(data.approvals.map((a) => [a.reportId, a]));
  const deliveriesBy = new Map<string, DeliveryRow[]>();
  for (const d of data.deliveries) {
    const list = deliveriesBy.get(d.reportId) ?? [];
    list.push({
      id: d.id,
      recipientId: d.recipientId,
      email: d.email === null ? null : String(d.email),
      manual: d.channel === "manual",
      status: d.status,
      sentAt: d.sentAt ? d.sentAt.toISOString() : null,
      error: d.error,
      createdAt: d.createdAt.toISOString(),
    });
    deliveriesBy.set(d.reportId, list);
  }
  const storeName = new Map(data.stores.map((x) => [x.id, x.name]));
  const withPdf = new Set(data.files.map((f) => f.reportId));
  const valid = data.reports.filter((r) => isReportDbKind(r.kind));
  const statuses = reportStatuses(
    valid.map((r) => ({
      id: r.id,
      kind: r.kind,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      storeId: r.storeId,
      generatedAt: r.generatedAt.toISOString(),
      approved: approval.has(r.id),
      deliveries: deliveriesBy.get(r.id) ?? [],
    })),
  );
  // Ersatt kan bara avgöras mot alla versioner; vid uppslag av en rapport räknas den
  // mot de rader som laddats.
  void all;
  return valid.map((r) => {
    const a = approval.get(r.id);
    let conclusion = "";
    try {
      conclusion = asSnapshot(r.snapshot).report.conclusion.text;
    } catch {
      conclusion = "";
    }
    const row: ArchiveRow & { storagePath: string | null; snapshot: unknown } = {
      id: r.id,
      type: TYPE_BY_DB_KIND[r.kind as keyof typeof TYPE_BY_DB_KIND],
      month: monthOf(r.periodStart),
      period: { start: r.periodStart, end: r.periodEnd },
      custom: !isWholeMonth({ start: r.periodStart, end: r.periodEnd }),
      storeId: r.storeId,
      storeName: r.storeId ? (storeName.get(r.storeId) ?? null) : null,
      generatedAt: r.generatedAt.toISOString(),
      generatedBy: r.generatedBy ? (data.names.get(r.generatedBy) ?? null) : null,
      calcVersion: r.calcVersion,
      // Sant först när PDF:en faktiskt sparats (report_files), inte när sökvägen satts.
      hasPdf: withPdf.has(r.id),
      status: statuses.get(r.id) ?? "draft",
      approvedAt: a ? a.approvedAt.toISOString() : null,
      approvedBy: a?.approvedBy ? (data.names.get(a.approvedBy) ?? null) : null,
      deliveries: deliveriesBy.get(r.id) ?? [],
      conclusion,
      storagePath: r.storagePath,
      snapshot: r.snapshot,
    };
    return row;
  });
}

/** Arkivet: alla rapporter, nyast period först. */
export async function listArchiveFor(viewer: Viewer, limit = 300): Promise<ArchiveRow[]> {
  return as(viewer, READ_ROLES, async (tx) => {
    const data = await archiveTx(tx, viewer.organization.id, limit);
    return toArchive(data, true).map((row) => {
      const { storagePath: _p, snapshot: _s, ...rest } = row;
      void _p;
      void _s;
      return rest;
    });
  });
}

/** En rapport med ögonblicksbild, godkännande och utskick. Kastar om den inte finns. */
export async function getReportFor(viewer: Viewer, id: string): Promise<ReportDetail> {
  return as(viewer, READ_ROLES, (tx) => getReportTx(tx, viewer.organization.id, id));
}

async function getReportTx(tx: Tx, orgId: string, id: string): Promise<ReportDetail> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ReportError("Rapporten finns inte.");
  const head = await tx
    .select({
      kind: s.reports.kind,
      periodStart: s.reports.periodStart,
      periodEnd: s.reports.periodEnd,
      storeId: s.reports.storeId,
    })
    .from(s.reports)
    .where(and(eq(s.reports.organizationId, orgId), eq(s.reports.id, id)));
  const h = head[0];
  if (!h) throw new ReportError("Rapporten finns inte.");
  // Alla versioner av samma rapport, så att "ersatt" räknas rätt.
  const siblings = await tx
    .select({ id: s.reports.id })
    .from(s.reports)
    .where(
      and(
        eq(s.reports.organizationId, orgId),
        eq(s.reports.kind, h.kind),
        eq(s.reports.periodStart, h.periodStart),
        eq(s.reports.periodEnd, h.periodEnd),
      ),
    );
  const data = await archiveTx(
    tx,
    orgId,
    1000,
    siblings.map((x) => x.id),
  );
  const rows = toArchive(data, false).filter((r) => r.storeId === h.storeId);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new ReportError("Rapporten finns inte.");
  return { ...row, snapshot: asSnapshot(row.snapshot) };
}

// ---------------------------------------------------------------------------
// Förhandsvisning och skapande
// ---------------------------------------------------------------------------

export interface ReportRequest {
  readonly type: ReportType;
  readonly month: IsoMonth;
  /**
   * Eget datum (butik, bokföring och delägare). Ersätter `month`, som då ska vara intervallets
   * startmånad (se requestFor). Saknas = hela månaden.
   */
  readonly period?: Period | null;
  readonly storeId?: string | null;
  readonly greeting?: string | null;
  readonly comment?: string | null;
}

function assertMonth(month: string, today: string): asserts month is IsoMonth {
  try {
    parseIsoMonth(month);
  } catch {
    throw new ReportError("Ogiltig månad.");
  }
  if (month >= monthOf(today)) {
    throw new ReportError("Rapporter skapas för avslutade månader.");
  }
}

/**
 * Kontrollerar ett eget datum och ger den period rapporten räknas på (null = hela
 * månaden). Ett intervall som är exakt en hel månad blir en vanlig månadsrapport.
 */
function customPeriod(req: ReportRequest, today: string): Period | null {
  if (!req.period) return null;
  const { start, end } = req.period;
  const error = rangeError(start, end, today);
  if (error) throw new ReportError(error);
  if (isWholeMonth(req.period)) return null;
  if (!allowsRange(req.type)) throw new ReportError("Rapporten görs per månad.");
  if (monthOf(start) !== req.month) throw new ReportError("Ogiltig period.");
  return { start, end };
}

async function snapshotTx(
  tx: Tx,
  orgId: string,
  timeZone: string,
  req: ReportRequest,
  now: Date,
): Promise<ReportSnapshot> {
  const today = businessToday(now, timeZone);
  const custom = customPeriod(req, today);
  if (!custom) assertMonth(req.month, today);
  else {
    try {
      parseIsoMonth(req.month);
    } catch {
      throw new ReportError("Ogiltig månad.");
    }
  }
  if (req.type === "butik") {
    if (!req.storeId) throw new ReportError("Välj en butik.");
    const placements = await tx
      .select({
        storeId: s.machinePlacements.storeId,
        from: s.machinePlacements.validFrom,
        to: s.machinePlacements.validTo,
      })
      .from(s.machinePlacements)
      .where(eq(s.machinePlacements.organizationId, orgId));
    const period = custom ?? { start: monthStart(req.month), end: monthEnd(req.month) };
    if (!storesPlacedIn(placements, period).includes(req.storeId)) {
      throw new ReportError(
        custom
          ? "Butiken hade ingen automat under perioden."
          : "Butiken hade ingen automat under månaden.",
      );
    }
  }
  const input = await loadSnapshotInput(tx, {
    organizationId: orgId,
    type: req.type,
    month: req.month,
    period: custom,
    storeId: req.storeId ?? null,
    greeting: req.greeting ?? null,
    comment: req.comment ?? null,
    now: now.toISOString(),
  });
  try {
    return buildSnapshot(input);
  } catch (error) {
    if (error instanceof DomainError) throw new ReportError(error.message);
    throw error;
  }
}

/** Rapporten som den skulle bli, utan att spara något. Ägare, admin och läsare. */
export async function previewReportFor(
  viewer: Viewer,
  req: ReportRequest,
  now: Date = new Date(),
): Promise<ReportSnapshot> {
  return as(viewer, READ_ROLES, (tx) =>
    snapshotTx(tx, viewer.organization.id, viewer.organization.timezone, req, now),
  );
}

/** Sparar en ny rapport (utkast). Ägare och admin. Returnerar rapportens id. */
export async function createReportFor(
  viewer: Viewer,
  req: ReportRequest,
  now: Date = new Date(),
  monitor: MonitoringDeps = {},
): Promise<string> {
  const id = await as(viewer, EDIT_ROLES, async (tx) => {
    const orgId = viewer.organization.id;
    const snapshot = await snapshotTx(tx, orgId, viewer.organization.timezone, req, now);
    return insertReportTx(tx, orgId, snapshot, viewer.user.userId);
  });
  // Ett utkast för hand kan fylla det som det schemalagda jobbet missade: då stängs
  // månadens larm (report_drafts:<månad>). Kastar aldrig.
  await closeDraftsAlertIfComplete(monitor, viewer.organization.id, req.month);
  return id;
}

/** Skriver reports-raden. Används också av det schemalagda jobbet (utan användare). */
export async function insertReportTx(
  tx: Tx,
  orgId: string,
  snapshot: ReportSnapshot,
  generatedBy: string | null,
): Promise<string> {
  // Sökvägen till PDF:en sätts direkt (databasen kräver en sökväg i organisationens
  // namnrymd); själva filen skapas vid första nedladdningen eller utskicket.
  const id = randomUUID();
  const [row] = await tx
    .insert(s.reports)
    .values({
      id,
      organizationId: orgId,
      storagePath: reportPdfPath(orgId, snapshot.month, id),
      kind: DB_KIND[snapshot.type],
      periodStart: snapshot.period.start,
      periodEnd: snapshot.period.end,
      storeId: storeIdOf(snapshot),
      generatedBy,
      generatedAt: new Date(snapshot.generatedAt),
      dataSnapshot: snapshot as unknown as Record<string, unknown>,
      calcVersion: snapshot.calcVersion,
    })
    .returning({ id: s.reports.id });
  return row!.id;
}

// ---------------------------------------------------------------------------
// Godkännande
// ---------------------------------------------------------------------------

/** Ett utkast vars siffror inte längre stämmer med en ny uträkning. */
export interface StaleDraft {
  /** Butiksrapporten: ersättningen i utkastet och nu (öre); annars null. */
  readonly draftOre: number | null;
  readonly nowOre: number | null;
}

/**
 * Jämför ett utkast med samma rapport räknad nu. null = samma (eller inte ett utkast, eller
 * kan inte räknas nu). Ett godkänt eller skickat utkast jämförs aldrig: det är låst.
 */
async function staleDraftTx(
  tx: Tx,
  viewer: Viewer,
  report: ReportDetail,
  now: Date,
): Promise<StaleDraft | null> {
  if (report.status !== "draft") return null;
  let fresh: ReportSnapshot;
  try {
    fresh = await snapshotTx(
      tx,
      viewer.organization.id,
      viewer.organization.timezone,
      requestOf(report.snapshot),
      now,
    );
  } catch (error) {
    if (error instanceof ReportError) return null;
    throw error;
  }
  return sameReport(report.snapshot, fresh)
    ? null
    : { draftOre: headlineOreOf(report.snapshot), nowOre: headlineOreOf(fresh) };
}

/** Är utkastet inaktuellt? (Rapporter visar det och låser "Godkänn".) Ägare, admin, läsare. */
export async function staleDraftFor(
  viewer: Viewer,
  id: string,
  now: Date = new Date(),
): Promise<StaleDraft | null> {
  return as(viewer, READ_ROLES, async (tx) => {
    let report: ReportDetail;
    try {
      report = await getReportTx(tx, viewer.organization.id, id);
    } catch (error) {
      // Ett utkast vars underlag inte går att läsa (äldre format) kan inte jämföras: sidan
      // ska ändå visas, i stället för att hela Rapporter går sönder.
      if (error instanceof DomainError || error instanceof ReportError) return null;
      throw error;
    }
    return staleDraftTx(tx, viewer, report, now);
  });
}

/**
 * Godkänner rapporten för utskick. Ägare och admin. Ersatta rapporter kan inte godkännas,
 * och inte heller ett utkast vars siffror har ändrats sedan det skapades (då skapas en ny
 * version först, så att butiken aldrig får ett belopp som inte stämmer med avräkningen).
 */
export async function approveReportFor(
  viewer: Viewer,
  id: string,
  note?: string | null,
  now: Date = new Date(),
): Promise<void> {
  await as(viewer, EDIT_ROLES, async (tx) => {
    const orgId = viewer.organization.id;
    const report = await getReportTx(tx, orgId, id);
    if (report.status === "superseded") {
      throw new ReportError("Det finns en nyare version av rapporten. Godkänn den i stället.");
    }
    if (report.approvedAt) return;
    if (await staleDraftTx(tx, viewer, report, now)) {
      throw new ReportError(
        "Siffrorna har ändrats sedan utkastet skapades. Skapa en ny version och godkänn den.",
      );
    }
    await tx.insert(s.reportApprovals).values({
      organizationId: orgId,
      reportId: id,
      approvedBy: viewer.user.userId,
      note: note?.trim() ? note.trim().slice(0, 500) : null,
    });
  });
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * PDF:en för rapporten: hämtas ur lagringen om den finns, annars skapas den med
 * `render` (headless Chromium mot /rapport/[id]) och sparas. Bara ägare och admin får
 * spara en ny PDF; läsaren får hämta en befintlig.
 */
export async function ensurePdfFor(
  viewer: Viewer,
  id: string,
  deps: { store: FileStore; render: (reportId: string) => Promise<Uint8Array> },
): Promise<{ bytes: Uint8Array; fileName: string; snapshot: ReportSnapshot }> {
  const orgId = viewer.organization.id;
  const report = await getReportFor(viewer, id);
  const fileName = reportFileName(report.snapshot, "pdf");
  const role = await requireRoleFor(viewer.user, orgId, READ_ROLES);
  const canEdit = EDIT_ROLES.includes(role);
  if (report.storagePath && isValidStoragePath(report.storagePath)) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await deps.store.get(report.storagePath);
    } catch {
      // Filen saknas i lagringen (t.ex. lokal disk som rensats): skapa den igen nedan.
    }
    if (bytes) {
      // Filen finns men markeringen saknas (äldre rapport): skriv den nu.
      if (!report.hasPdf && canEdit) await markPdfStored(viewer, id, report.storagePath, bytes);
      return { bytes, fileName, snapshot: report.snapshot };
    }
  }
  if (!canEdit) {
    throw new ReportError("PDF:en är inte skapad än. En ägare eller admin skapar den.");
  }
  const bytes = await deps.render(id);
  const storagePath = reportPdfPath(orgId, report.month, id);
  await deps.store.put(storagePath, bytes, CONTENT_TYPE.pdf);
  if (report.storagePath !== storagePath) {
    await as(viewer, EDIT_ROLES, async (tx) => {
      await tx
        .update(s.reports)
        .set({ storagePath })
        .where(and(eq(s.reports.organizationId, orgId), eq(s.reports.id, id)));
    });
  }
  await markPdfStored(viewer, id, storagePath, bytes);
  return { bytes, fileName, snapshot: report.snapshot };
}

/** report_files-raden: PDF:en finns i lagringen. Idempotent. */
async function markPdfStored(
  viewer: Viewer,
  reportId: string,
  storagePath: string,
  bytes: Uint8Array,
): Promise<void> {
  await as(viewer, EDIT_ROLES, async (tx) => {
    await tx
      .insert(s.reportFiles)
      .values({
        organizationId: viewer.organization.id,
        reportId,
        kind: "pdf",
        storagePath,
        byteSize: bytes.byteLength,
      })
      .onConflictDoNothing();
  });
}

// ---------------------------------------------------------------------------
// Utskick
// ---------------------------------------------------------------------------

export interface SendRequest {
  readonly reportId: string;
  readonly recipientIds: readonly string[];
  /** Kort följetext i mejlet. */
  readonly followText?: string | null;
  /** Skicka igen till mottagare som redan fått rapporten. */
  readonly resend?: boolean;
}

export interface SendDeps {
  readonly mailer: Mailer;
  readonly store: FileStore;
  readonly render: (reportId: string) => Promise<Uint8Array>;
  /**
   * Renderar mejlen med mallen i src/emails för mottagarna (id → HTML). Mallen använder
   * react-dom/server, som inte får laddas i Server Components; i appen körs den därför i
   * headless Chromium (/rapport/[id]/epost), i tester direkt.
   */
  readonly renderEmails: (
    reportId: string,
    recipientIds: readonly string[],
    followText: string | null,
  ) => Promise<Record<string, { html: string }>>;
  /** Länk till rapporten i appen. */
  readonly reportUrl: (reportId: string) => string;
  /** Felövervakningen (Sentry och larm). Standard: systemrollen och Sentry när DSN finns. */
  readonly monitor?: MonitoringDeps;
  readonly sender?: { name: string; address: string; email: string };
  /** Avsändarens kontaktperson (butiksmejlet). */
  readonly contact?: { name: string; phone: string | null } | null;
}

export interface SendResult {
  readonly sent: number;
  readonly failed: { readonly email: string; readonly error: string }[];
  readonly skipped: number;
}

/** Mottagare som får rapporten: rätt typ, aktiv, och för butiksrapporten rätt butik. */
export function eligibleRecipients(
  snapshot: ReportSnapshot,
  recipients: readonly RecipientRow[],
): RecipientRow[] {
  const kind = RECIPIENT_KIND[snapshot.type];
  return recipients.filter(
    (r) =>
      r.active && r.kind === kind && (snapshot.type !== "butik" || r.storeId === snapshot.store.id),
  );
}

/**
 * Skickar en godkänd rapport till valda mottagare. Ägare och admin. Varje försök loggas i
 * report_deliveries (och därmed i ändringsloggen), även misslyckade.
 */
export async function sendReportFor(
  viewer: Viewer,
  req: SendRequest,
  deps: SendDeps,
): Promise<SendResult> {
  const orgId = viewer.organization.id;
  const { report, recipients } = await as(viewer, EDIT_ROLES, async (tx) => ({
    report: await getReportTx(tx, orgId, req.reportId),
    recipients: await listRecipientsTx(tx, orgId),
  }));
  if (report.status === "superseded") {
    throw new ReportError("Det finns en nyare version av rapporten. Skicka den i stället.");
  }
  if (!report.approvedAt) {
    throw new ReportError("Rapporten måste godkännas innan den skickas.");
  }
  if (req.recipientIds.length === 0) throw new ReportError("Välj minst en mottagare.");
  const allowed = new Map(eligibleRecipients(report.snapshot, recipients).map((r) => [r.id, r]));
  const chosen = req.recipientIds.map((id) => {
    const r = allowed.get(id);
    if (!r) throw new ReportError("En vald mottagare kan inte få den här rapporten.");
    return r;
  });
  const alreadySent = new Set(
    report.deliveries
      .filter((d) => DONE_DELIVERY.has(d.status) && d.recipientId)
      .map((d) => d.recipientId!),
  );
  const targets = req.resend ? chosen : chosen.filter((r) => !alreadySent.has(r.id));
  const skipped = chosen.length - targets.length;
  if (targets.length === 0) return { sent: 0, failed: [], skipped };

  // Felövervakning (Sentry och larm på Drift): utskick som avbryts eller inte når fram.
  const monitored = {
    organizationId: orgId,
    reportId: report.id,
    label: `${TYPE_LABEL[report.type].toLocaleLowerCase("sv-SE")} ${report.custom ? periodText(report.period) : monthText(report.month)}${report.storeName ? ` · ${report.storeName}` : ""}`,
    month: report.month,
  };
  const followText = req.followText?.trim() || null;
  let attachments: MailAttachment[];
  let rendered: Record<string, { html: string }>;
  try {
    const pdf = await ensurePdfFor(viewer, report.id, { store: deps.store, render: deps.render });
    attachments = await mailAttachments(report.snapshot, pdf.bytes);
    rendered = await deps.renderEmails(
      report.id,
      targets.map((r) => r.id),
      followText,
    );
  } catch (error) {
    await recordReportSend(deps.monitor ?? {}, {
      ...monitored,
      sent: 0,
      failedErrors: [],
      error,
    });
    throw error;
  }

  let sent = 0;
  const failed: { email: string; error: string }[] = [];
  for (const r of targets) {
    const props = emailPropsFor(report, r, {
      followText,
      reportUrl: deps.reportUrl(report.id),
      attachments,
      sender: deps.sender,
      contact: deps.contact ?? null,
    });
    // Ämne och text räknas här ur samma props; HTML:en kommer från mallen (renderEmails).
    const html = rendered[r.id]?.html;
    const subject = buildSubject(props);
    const text = cleanEmailText(renderReportText(props), report.snapshot.type);
    let status: DeliveryStatus = "sent";
    let providerMessageId: string | null = null;
    let error: string | null = null;
    try {
      if (!html) throw new ReportError("Mejlet kunde inte renderas.");
      const result = await deps.mailer.send({
        to: r.email,
        subject,
        html,
        text,
        attachments,
        tags: { report_id: report.id, recipient_id: r.id },
      });
      providerMessageId = result.providerMessageId;
      sent += 1;
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message.slice(0, 500) : "Okänt fel";
      failed.push({ email: r.email, error });
    }
    await as(viewer, EDIT_ROLES, async (tx) => {
      await tx.insert(s.reportDeliveries).values({
        organizationId: orgId,
        reportId: report.id,
        recipientId: r.id,
        email: r.email,
        status,
        sentAt: status === "sent" ? new Date() : null,
        providerMessageId,
        error,
      });
    });
  }
  await recordReportSend(deps.monitor ?? {}, {
    ...monitored,
    sent,
    failedErrors: failed.map((f) => f.error),
  });
  return { sent, failed, skipped };
}

/** Bilagorna till mejlet: PDF, och för bokföringsunderlaget Excel och SIE 4. */
export async function mailAttachments(
  snapshot: ReportSnapshot,
  pdfBytes: Uint8Array,
): Promise<MailAttachment[]> {
  const out: MailAttachment[] = [
    { filename: reportFileName(snapshot, "pdf"), contentType: CONTENT_TYPE.pdf, content: pdfBytes },
  ];
  if (snapshot.type === "bokforing") {
    out.push({
      filename: reportFileName(snapshot, "xlsx"),
      contentType: CONTENT_TYPE.xlsx,
      content: await excelOf(snapshot),
    });
    if (snapshot.missingAccounts.length === 0) {
      out.push({
        filename: reportFileName(snapshot, "sie"),
        contentType: "application/octet-stream",
        content: sieOf(snapshot),
      });
    }
  }
  return out;
}

/** Props till e-postmallen för en mottagare. Samma i utskicket och förhandsvisningen. */
export function emailPropsFor(
  report: Pick<ReportDetail, "id" | "snapshot">,
  recipient: Pick<RecipientRow, "name">,
  opts: {
    followText: string | null;
    reportUrl: string;
    attachments: readonly { filename: string; content: { byteLength: number } }[];
    sender?: { name: string; address: string; email: string };
    contact?: { name: string; phone: string | null } | null;
  },
) {
  return reportEmailProps(report.snapshot, {
    recipientName: recipient.name.trim().split(/\s+/)[0] ?? recipient.name,
    reportUrl: opts.reportUrl,
    followText: opts.followText,
    reportId: shortId(report.id),
    attachments: opts.attachments.map((a) => ({
      name: a.filename,
      size: a.content.byteLength,
      description: describe(a.filename),
    })),
    sender: opts.sender,
    contact: opts.contact ?? null,
  });
}

function describe(fileName: string): string {
  if (fileName.endsWith(".pdf")) return "Rapporten som PDF";
  if (fileName.endsWith(".xlsx")) return "Underlaget i Excel, per dag, butik och automat";
  if (fileName.endsWith(".se")) return "Verifikationer i SIE 4 för bokföringsprogrammet";
  return "";
}

/** "R-3F2A9C" av rapportens uuid (visas i mejlets sidhuvud). */
export function shortId(id: string): string {
  return `R-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Mottagare
// ---------------------------------------------------------------------------

export interface RecipientInput {
  readonly name: string;
  readonly email: string;
  readonly kind: RecipientDbKind;
  readonly storeId?: string | null;
}

export async function listRecipientsFor(viewer: Viewer): Promise<RecipientRow[]> {
  return as(viewer, READ_ROLES, (tx) => listRecipientsTx(tx, viewer.organization.id));
}

export async function createRecipientFor(viewer: Viewer, input: RecipientInput): Promise<string> {
  if (input.kind === "store" && !input.storeId) throw new ReportError("Välj butik.");
  return as(viewer, EDIT_ROLES, async (tx) => {
    const [row] = await tx
      .insert(s.reportRecipients)
      .values({
        organizationId: viewer.organization.id,
        name: input.name.trim(),
        email: input.email.trim(),
        kind: input.kind,
        storeId: input.kind === "store" ? (input.storeId ?? null) : null,
        active: true,
      })
      .returning({ id: s.reportRecipients.id });
    return row!.id;
  });
}

export async function setRecipientActiveFor(
  viewer: Viewer,
  id: string,
  active: boolean,
): Promise<void> {
  await as(viewer, EDIT_ROLES, async (tx) => {
    const rows = await tx
      .update(s.reportRecipients)
      .set({ active })
      .where(
        and(
          eq(s.reportRecipients.organizationId, viewer.organization.id),
          eq(s.reportRecipients.id, id),
        ),
      )
      .returning({ id: s.reportRecipients.id });
    if (rows.length === 0) throw new ReportError("Mottagaren finns inte.");
  });
}

// ---------------------------------------------------------------------------
// Delad för hand (utan e-post)
// ---------------------------------------------------------------------------

/**
 * "Skickade du den?": sparar att en godkänd rapport delats för hand. Ägare och admin.
 * En rad per aktiv mottagare som kan få rapporten och inte redan fått den (så att punkten
 * i Att göra försvinner), annars en rad utan mottagare. Status 'delivered', channel
 * 'manual'. Att markera igen ändrar ingenting. Returnerar antalet nya rader.
 */
export async function markReportSharedFor(viewer: Viewer, reportId: string): Promise<number> {
  const orgId = viewer.organization.id;
  return as(viewer, EDIT_ROLES, async (tx) => {
    const report = await getReportTx(tx, orgId, reportId);
    if (report.status === "superseded") {
      throw new ReportError("Det finns en nyare version av rapporten. Dela den i stället.");
    }
    if (!report.approvedAt) {
      throw new ReportError("Rapporten måste godkännas innan den markeras som skickad.");
    }
    const done = report.deliveries.filter((d) => DONE_DELIVERY.has(d.status));
    const got = new Set(done.map((d) => d.recipientId).filter((id): id is string => id !== null));
    const targets = eligibleRecipients(report.snapshot, await listRecipientsTx(tx, orgId)).filter(
      (r) => !got.has(r.id),
    );
    const now = new Date();
    const base = {
      organizationId: orgId,
      reportId: report.id,
      status: "delivered" as const,
      channel: "manual" as const,
      sentAt: now,
    };
    if (targets.length > 0) {
      await tx
        .insert(s.reportDeliveries)
        .values(targets.map((r) => ({ ...base, recipientId: r.id, email: r.email })));
      return targets.length;
    }
    // Ingen mottagare kvar: en rad räcker, och bara om rapporten inte redan räknas som skickad.
    if (done.length > 0) return 0;
    await tx.insert(s.reportDeliveries).values({ ...base, recipientId: null, email: null });
    return 1;
  });
}

// ---------------------------------------------------------------------------
// Sidan Rapporter
// ---------------------------------------------------------------------------

export interface MonthChoice {
  readonly month: IsoMonth;
}

/** Avslutade månader från första ordern (högst 24), nyast först. */
export function selectableMonths(dataStart: string | null, today: string): IsoMonth[] {
  const last = addMonths(monthOf(today), -1);
  const first = dataStart ? monthOf(dataStart) : last;
  const out: IsoMonth[] = [];
  for (let m = last; m >= first && out.length < 24; m = addMonths(m, -1)) out.push(m);
  if (out.length === 0) out.push(last);
  return out;
}

/** Kastar AuthorizationError om rollen saknas. Hjälp för sidor och routes. */
export async function requireReportRole(viewer: Viewer, edit: boolean): Promise<MemberRole> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, READ_ROLES);
  if (edit && !EDIT_ROLES.includes(role)) throw new AuthorizationError("forbidden");
  return role;
}
