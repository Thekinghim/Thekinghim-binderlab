/**
 * Utbetalningar från Nayax (Pengar → Utbetalningar): sidornas laddare och ändringar, bundna
 * till en användare och organisation (Viewer). Ägare och admin; alla andra nekas
 * (requireRoleFor) och RLS ger tomma svar. Allt körs som användaren under RLS.
 *
 * Flödet:
 *   1. "Lägg in utbetalning": ladda upp rapporten (CSV, Excel, PDF eller foto) eller skriv in
 *      dag och belopp. Filen blir ett utkast (payout_drafts): känt format läses direkt,
 *      okända kolumner får ett kolumnsteg (och kommer ihåg filen), och det som inte går att
 *      läsa får AI att läsa (./ai-read.ts). Inget sparas i payouts förrän "Stämmer, spara".
 *   2. Utbetalningen sparas (registerPayoutFor). Saknas perioden räknas den ut: äldsta
 *      obetalda försäljningen först (src/domain/payout-coverage.ts).
 *   3. Uträkningen görs om för alla utkast (./allocate.ts), och sammanfattningen skrivs.
 *   4. "Markera som betald" per mottagare (./pay.ts).
 */

import "server-only";

import { and, desc, eq, isNull, max, sql } from "drizzle-orm";

import { getServiceDb, type Db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import {
  addDays,
  daysBetween,
  inferCoverage,
  unmappedDeviceWarnings,
  type IsoDate,
  type Period,
  type SplitWarning,
} from "@/domain";
import { sha256Hex } from "@/import/hash";
import { parseCsvTable } from "@/import/csv-table";
import type { FileStore } from "@/import/file-store";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { payoutFileStore } from "@/server/accounting/contract-files";
import {
  manualReference,
  manualSourceHash,
  overlappingPayout,
} from "@/server/accounting/manual-payout";
import { NayaxStatementError, parseNayaxStatement } from "@/server/accounting/nayax-statement";
import { parsePayoutFile } from "@/server/accounting/payout-csv";
import { extractPdfLines, PdfTextError } from "@/server/accounting/pdf-text";
import { queryPayouts } from "@/server/accounting/queries";
import {
  AccountingError,
  importNayaxStatementFor,
  importPayoutFileFor,
} from "@/server/accounting/service";
import { budgetState, isDemoBlocked } from "@/server/assistant/advisor/service";
import { budgetFrom, costOre } from "@/server/assistant/advisor/pricing";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";

import {
  payoutModelFrom,
  readPayoutWithAi,
  type PayoutReaderModel,
  type ReaderInput,
} from "./ai-read";
import { recomputeAllocationsTx, type RecomputeResult } from "./allocate";
import { loadPayOverviewTx, type PayOverview } from "./balances";
import {
  columnsEnough,
  columnsFromMapping,
  detectColumns,
  extractFromRows,
  headerSignature,
  mappingFromColumns,
  payoutMappingSchema,
  sampleRows,
  type ExtractedPayout,
  type ExtractWarning,
  type PayoutMapping,
} from "./import-parse";
import { expectedByDay, loadDayTotalsTx, loadOrgPayoutContextTx } from "./inputs";
import { PayoutError } from "./pay";
import {
  acceptSummary,
  createAnthropicSummaryWriter,
  summaryFacts,
  templateSummary,
  type SummaryWriter,
} from "./summary";
import { readXlsxTable, isXlsx } from "./xlsx";

export { PayoutError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAYOUT_ORE = 10_000_000_000;
const MAX_TABLE_ROWS = 5000;

async function asOperator<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  return withUserDbFor(viewer.user, fn);
}

function validDate(v: string | null | undefined): v is IsoDate {
  return (
    typeof v === "string" &&
    ISO.test(v) &&
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
  );
}

// ---------------------------------------------------------------------------
// Sidorna
// ---------------------------------------------------------------------------

export interface PayoutsPage extends PayOverview {
  readonly today: IsoDate;
  readonly drafts: readonly {
    readonly id: string;
    readonly fileName: string | null;
    readonly createdAt: string;
  }[];
  readonly recompute: RecomputeResult | null;
}

/**
 * "Att betala just nu": räknar om utkasten (snabbt när inget har ändrats) och läser allt.
 * Går omräkningen inte (t.ex. ett fel i en butiks avtal) visas de sparade uträkningarna.
 */
export async function loadPayoutsPageFor(
  viewer: Viewer,
  now: Date = new Date(),
  options: { readonly payoutId?: string } = {},
): Promise<PayoutsPage> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  let recompute: RecomputeResult | null = null;
  try {
    recompute = await withUserDbFor(viewer.user, (tx) => recomputeAllocationsTx(tx, orgId, now));
  } catch (error) {
    console.error("[utbetalningar] omräkning", error instanceof Error ? error.message : error);
  }
  return withUserDbFor(viewer.user, async (tx) => {
    const overview = await loadPayOverviewTx(tx, orgId, options);
    const drafts = await tx
      .select({
        id: s.payoutDrafts.id,
        fileName: s.payoutDrafts.fileName,
        createdAt: s.payoutDrafts.createdAt,
      })
      .from(s.payoutDrafts)
      .where(and(eq(s.payoutDrafts.organizationId, orgId), eq(s.payoutDrafts.status, "open")))
      .orderBy(desc(s.payoutDrafts.createdAt))
      .limit(5);
    return {
      ...overview,
      today: businessToday(now, viewer.organization.timezone),
      drafts: drafts.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
      recompute,
    };
  });
}

/** Det vi väntar oss från Nayax för perioden (för jämförelsen i utkastet). */
export async function expectedForPeriodFor(
  viewer: Viewer,
  period: Period,
): Promise<{
  grossOre: number;
  feeOre: number;
  refundsOre: number;
  netOre: number;
  orders: number;
}> {
  if (!validDate(period.start) || !validDate(period.end) || period.end < period.start) {
    throw new PayoutError("Välj en period.");
  }
  if (daysBetween(period.start, period.end) > 366)
    throw new PayoutError("Perioden får vara högst ett år.");
  return asOperator(viewer, async (tx) => {
    const ctx = await loadOrgPayoutContextTx(tx, viewer.organization.id);
    const groups = await loadDayTotalsTx(tx, ctx, period.start, period.end);
    const sum = (f: (g: (typeof groups)[number]) => number) => groups.reduce((a, g) => a + f(g), 0);
    const netOre = [...expectedByDay(groups).values()].reduce((a, v) => a + v, 0);
    return {
      grossOre: sum((g) => g.grossOre),
      feeOre: sum((g) => g.feeOre),
      refundsOre: sum((g) => g.refundsOre),
      netOre,
      orders: sum((g) => g.orders),
    };
  });
}

// ---------------------------------------------------------------------------
// Spara en utbetalning
// ---------------------------------------------------------------------------

export interface RegisterPayoutInput {
  readonly paidOn: string;
  readonly amountOre: number;
  readonly feesOre?: number | null;
  readonly period?: { readonly start: string; readonly end: string } | null;
  readonly note?: string | null;
  /** Varifrån perioden kommer när den är given (standard: inskriven). */
  readonly basis?: "report" | "lines" | "manual";
  readonly lines?: readonly { readonly externalId: string; readonly amountOre: number }[];
}

export interface RegisterPayoutResult {
  readonly payoutId: string;
  readonly period: Period;
  readonly inferred: boolean;
  readonly note: string | null;
}

async function inferPeriodTx(
  tx: Tx,
  orgId: string,
  paidOn: IsoDate,
  amountOre: number,
): Promise<{ period: Period; note: string }> {
  const [last] = await tx
    .select({ end: max(s.payouts.periodEnd) })
    .from(s.payouts)
    .where(and(eq(s.payouts.organizationId, orgId), isNull(s.payouts.archivedAt)));
  const lastEnd = (last?.end as IsoDate | null) ?? null;
  const ctx = await loadOrgPayoutContextTx(tx, orgId);
  const from = lastEnd ? addDays(lastEnd, 1) : addDays(paidOn, -366);
  const to = addDays(paidOn, -1);
  if (from > to) {
    throw new PayoutError(
      "Alla dagar före betaldagen har redan en utbetalning. Välj perioden själv, eller arkivera en felaktig utbetalning.",
    );
  }
  const groups = await loadDayTotalsTx(tx, ctx, from, to);
  const r = inferCoverage({
    days: [...expectedByDay(groups).entries()].map(([date, expectedNetOre]) => ({
      date,
      expectedNetOre,
    })),
    lastCoveredEnd: lastEnd,
    paidOn,
    amountOre,
  });
  if (!r.ok) {
    throw new PayoutError(
      r.reason === "covered"
        ? "Alla dagar före betaldagen har redan en utbetalning. Välj perioden själv."
        : "Vi hittar ingen försäljning före betaldagen. Välj perioden själv.",
    );
  }
  return { period: { start: r.from, end: r.to }, note: r.note };
}

/** Sparar en utbetalning (se filhuvudet) och räknar om uträkningarna i samma transaktion. */
export async function registerPayoutTx(
  tx: Tx,
  orgId: string,
  input: RegisterPayoutInput,
  today: IsoDate,
  now: Date,
): Promise<RegisterPayoutResult> {
  if (!validDate(input.paidOn)) throw new PayoutError("Välj dagen pengarna kom.");
  if (input.paidOn > today) throw new PayoutError("Dagen pengarna kom kan inte vara efter i dag.");
  if (!Number.isSafeInteger(input.amountOre) || input.amountOre === 0) {
    throw new PayoutError("Skriv beloppet som kom in.");
  }
  if (Math.abs(input.amountOre) > MAX_PAYOUT_ORE) {
    throw new PayoutError("Beloppet är för stort. Kontrollera siffrorna.");
  }
  const fees = input.feesOre ?? null;
  if (fees !== null && (!Number.isSafeInteger(fees) || fees < 0 || fees > MAX_PAYOUT_ORE)) {
    throw new PayoutError("Avgiften ska vara ett belopp, 0 kr eller mer.");
  }
  const note = (input.note ?? "").trim().slice(0, 2000) || null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payouts:${orgId}`}))`);
  let period: Period;
  let inferredNote: string | null = null;
  if (input.period) {
    if (!validDate(input.period.start) || !validDate(input.period.end)) {
      throw new PayoutError("Perioden går inte att läsa. Välj första och sista dagen.");
    }
    if (input.period.end < input.period.start)
      throw new PayoutError("Perioden slutar före den börjar.");
    if (daysBetween(input.period.start, input.period.end) > 366) {
      throw new PayoutError("Perioden får vara högst ett år.");
    }
    if (input.period.end > input.paidOn) {
      throw new PayoutError("Perioden kan inte sluta efter dagen pengarna kom.");
    }
    period = { start: input.period.start, end: input.period.end };
  } else {
    const inferred = await inferPeriodTx(tx, orgId, input.paidOn, input.amountOre);
    period = inferred.period;
    inferredNote = inferred.note;
  }
  const active = await queryPayouts(tx, orgId, null);
  const clash = overlappingPayout(active, period);
  if (clash) {
    throw new PayoutError(
      `Det finns redan en utbetalning för de dagarna (${clash.reference}). Ändra perioden, eller arkivera den andra först.`,
    );
  }
  const reference = manualReference(period, new Set(active.map((p) => p.reference))).replace(
    /^Inskriven/,
    "Nayax",
  );
  const [row] = await tx
    .insert(s.payouts)
    .values({
      organizationId: orgId,
      dataSourceId: null,
      reference,
      periodStart: period.start,
      periodEnd: period.end,
      paidOn: input.paidOn,
      amountOre: input.amountOre,
      feesOre: fees ?? 0,
      refundsOre: null,
      sourceHash: manualSourceHash({
        reference,
        period,
        paidOn: input.paidOn,
        amountOre: input.amountOre,
      }),
      manual: fees === null,
      note,
      periodBasis: inferredNote ? "inferred" : (input.basis ?? "manual"),
      inferredNote,
    })
    .returning({ id: s.payouts.id });
  const payoutId = row!.id;
  const lines = new Map<string, number>();
  for (const l of input.lines ?? []) {
    const id = l.externalId.trim().slice(0, 100);
    if (id && Number.isSafeInteger(l.amountOre)) lines.set(id, (lines.get(id) ?? 0) + l.amountOre);
  }
  if (lines.size > 0) {
    await tx.insert(s.payoutLines).values(
      [...lines.entries()].map(([externalId, amountOre]) => ({
        organizationId: orgId,
        payoutId,
        externalId,
        amountOre,
      })),
    );
  }
  await recomputeAllocationsTx(tx, orgId, now);
  return { payoutId, period, inferred: inferredNote !== null, note: inferredNote };
}

/** "Skriv in själv": dag och belopp, perioden valfri ("Vet du inte? Vi räknar ut det."). */
export async function registerPayoutFor(
  viewer: Viewer,
  input: RegisterPayoutInput,
  now: Date = new Date(),
  deps: { readonly summaryWriter?: SummaryWriter | null } = {},
): Promise<RegisterPayoutResult> {
  const today = businessToday(now, viewer.organization.timezone);
  const result = await asOperator(viewer, (tx) =>
    registerPayoutTx(tx, viewer.organization.id, input, today, now),
  );
  await summarizeQuietly(viewer, result.payoutId, now, deps.summaryWriter);
  return result;
}

// ---------------------------------------------------------------------------
// Uppladdning, kolumnsteg och utkast
// ---------------------------------------------------------------------------

export type UploadResult =
  | {
      readonly kind: "draft";
      readonly draftId: string;
      readonly extracted: ExtractedPayout;
      readonly warnings: readonly (ExtractWarning | SplitWarning)[];
      readonly extractor: "deterministic" | "ai";
      readonly aiMessage?: string;
    }
  | {
      readonly kind: "mapping";
      readonly draftId: string;
      readonly headers: readonly string[];
      readonly samples: readonly (readonly string[])[];
      readonly suggested: PayoutMapping;
    }
  | { readonly kind: "imported"; readonly payoutIds: readonly string[]; readonly message: string }
  | { readonly kind: "manual"; readonly message: string };

interface StoredTable {
  readonly headers: string[];
  readonly rows: string[][];
}

type FileKind = "csv" | "xlsx" | "pdf" | "image";

function fileKind(name: string, bytes: Uint8Array, type: string): FileKind | null {
  const lower = name.toLowerCase();
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "pdf";
  }
  if (isXlsx(bytes)) return "xlsx";
  if (/^image\/(png|jpeg|webp|gif)$/.test(type) || /\.(png|jpe?g|webp|gif|heic)$/.test(lower)) {
    return "image";
  }
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || type.startsWith("text/") || type === "")
    return "csv";
  return null;
}

function imageType(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return "image/webp";
  return null;
}

async function insertDraft(
  tx: Tx,
  orgId: string,
  values: {
    source: FileKind | "manual";
    fileName: string | null;
    storagePath: string | null;
    extracted: Record<string, unknown>;
    extractor: "deterministic" | "ai";
    aiRunId?: string | null;
    warnings: readonly unknown[];
  },
): Promise<string> {
  const [row] = await tx
    .insert(s.payoutDrafts)
    .values({
      organizationId: orgId,
      source: values.source,
      fileName: values.fileName,
      storagePath: values.storagePath,
      extracted: values.extracted,
      extractor: values.extractor,
      aiRunId: values.aiRunId ?? null,
      warnings: values.warnings as unknown[],
    })
    .returning({ id: s.payoutDrafts.id });
  return row!.id;
}

async function deviceWarnings(tx: Tx, orgId: string, e: ExtractedPayout): Promise<SplitWarning[]> {
  const serials = e.devices.map((d) => d.serial);
  if (serials.length === 0) return [];
  const rows = await tx
    .select({ serial: s.machines.serial })
    .from(s.machines)
    .where(eq(s.machines.organizationId, orgId));
  return unmappedDeviceWarnings(
    serials,
    new Set(rows.flatMap((r) => (r.serial ? [r.serial] : []))),
  );
}

/** Läser tabellen (CSV eller Excel) med en sparad eller gissad mappning, annars kolumnsteget. */
async function tableDraftTx(
  tx: Tx,
  orgId: string,
  kind: "csv" | "xlsx",
  fileName: string,
  table: StoredTable,
): Promise<UploadResult> {
  const signature = headerSignature(table.headers);
  const [saved] = await tx
    .select({ mapping: s.payoutImportMappings.mapping })
    .from(s.payoutImportMappings)
    .where(
      and(
        eq(s.payoutImportMappings.organizationId, orgId),
        eq(s.payoutImportMappings.headerSignature, signature),
      ),
    );
  const parsedSaved = saved ? payoutMappingSchema.safeParse(saved.mapping) : null;
  const cols = parsedSaved?.success
    ? columnsFromMapping(table.headers, parsedSaved.data)
    : detectColumns(table.headers);
  const known = parsedSaved?.success === true;
  const stored = { table: { headers: table.headers, rows: table.rows.slice(0, MAX_TABLE_ROWS) } };
  // Gissningen behöver bekräftas i kolumnsteget, utom när den hittar allt i en sammanfattning.
  const confident =
    known ||
    (columnsEnough(cols) &&
      cols.paid_on !== undefined &&
      cols.transaction_id === undefined &&
      table.rows.length <= 3);
  if (!confident) {
    const draftId = await insertDraft(tx, orgId, {
      source: kind,
      fileName,
      storagePath: null,
      extracted: stored,
      extractor: "deterministic",
      warnings: [],
    });
    return {
      kind: "mapping",
      draftId,
      headers: table.headers,
      samples: sampleRows(table.rows),
      suggested: mappingFromColumns(table.headers, cols),
    };
  }
  const { extracted, warnings } = extractFromRows(table.rows, cols);
  const all = [...warnings, ...(await deviceWarnings(tx, orgId, extracted))];
  const draftId = await insertDraft(tx, orgId, {
    source: kind,
    fileName,
    storagePath: null,
    extracted: { ...stored, payout: extracted, mapping: mappingFromColumns(table.headers, cols) },
    extractor: "deterministic",
    warnings: all,
  });
  return { kind: "draft", draftId, extracted, warnings: all, extractor: "deterministic" };
}

/**
 * "Ladda upp rapport (fil eller foto)" (se filhuvudet). `reader` och `fileStore` byts i
 * testerna.
 */
export async function uploadPayoutFileFor(
  viewer: Viewer,
  file: { readonly name: string; readonly type?: string; readonly bytes: Uint8Array },
  now: Date = new Date(),
  deps: {
    readonly reader?: PayoutReaderModel;
    readonly fileStore?: FileStore;
    readonly db?: Db;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<UploadResult> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  if (file.bytes.byteLength === 0) throw new PayoutError("Filen är tom.");
  if (file.bytes.byteLength > 10 * 1024 * 1024)
    throw new PayoutError("Filen är för stor (högst 10 MB).");
  const name = file.name.trim().slice(0, 255) || "rapport";
  const kind = fileKind(name, file.bytes, file.type ?? "");
  if (!kind)
    throw new PayoutError("Filtypen går inte att läsa. Ladda upp CSV, Excel, PDF eller en bild.");

  const ai = async (input: ReaderInput, source: FileKind): Promise<UploadResult> => {
    const result = await readPayoutWithAi({
      db: deps.db ?? getServiceDb(),
      organizationId: orgId,
      organizationSlug: viewer.organization.slug ?? null,
      userId: viewer.user.userId,
      input,
      byteLength: file.bytes.byteLength,
      env: deps.env,
      now,
      ...(deps.reader ? { reader: deps.reader } : {}),
    });
    if (!result.ok) return { kind: "manual", message: result.message };
    return asOperator(viewer, async (tx) => {
      const warnings = [...result.warnings, ...(await deviceWarnings(tx, orgId, result.extracted))];
      const draftId = await insertDraft(tx, orgId, {
        source,
        fileName: name,
        storagePath: null,
        extracted: { payout: result.extracted },
        extractor: "ai",
        aiRunId: result.runId,
        warnings,
      });
      return { kind: "draft", draftId, extracted: result.extracted, warnings, extractor: "ai" };
    });
  };

  if (kind === "image") {
    const mediaType = imageType(file.bytes);
    if (!mediaType)
      throw new PayoutError("Bilden går inte att läsa. Ta en skärmbild som PNG eller JPG.");
    return ai(
      { kind: "image", mediaType, base64: Buffer.from(file.bytes).toString("base64") },
      "image",
    );
  }

  if (kind === "pdf") {
    try {
      const parsed = parseNayaxStatement(extractPdfLines(file.bytes));
      const sha = sha256Hex(file.bytes);
      const storagePath = `${orgId}/payouts/${sha}.pdf`;
      const store = deps.fileStore ?? (await payoutFileStore());
      await store.put(storagePath, file.bytes, "application/pdf");
      const st = parsed.statement;
      const extracted: ExtractedPayout = {
        paidOn: st.payoutUntil,
        amountOre: st.totalOre,
        feesOre: st.feesOre,
        grossOre: st.grossOre,
        refundsOre: null,
        periodFrom: parsed.period.start,
        periodTo: parsed.period.end,
        transactions: [],
        devices: st.devices.flatMap((d) =>
          d.serial ? [{ serial: d.serial, amountOre: d.amountOre }] : [],
        ),
      };
      return asOperator(viewer, async (tx) => {
        const warnings = await deviceWarnings(tx, orgId, extracted);
        const draftId = await insertDraft(tx, orgId, {
          source: "pdf",
          fileName: name,
          storagePath,
          extracted: { payout: extracted, nayaxStatement: true },
          extractor: "deterministic",
          warnings,
        });
        return { kind: "draft", draftId, extracted, warnings, extractor: "deterministic" };
      });
    } catch (error) {
      if (!(error instanceof NayaxStatementError) && !(error instanceof PdfTextError)) throw error;
      return ai({ kind: "pdf", base64: Buffer.from(file.bytes).toString("base64") }, "pdf");
    }
  }

  // CSV: först de kända formaten (Ekonomis utbetalningsfil), sedan kolumnerna.
  let table: StoredTable;
  if (kind === "csv") {
    try {
      const known = parsePayoutFile(file.bytes);
      if (known.format === "payouts" && known.payouts.length > 0) {
        const result = await importPayoutFileFor(
          viewer,
          { name, bytes: file.bytes },
          {
            ...(deps.fileStore ? { fileStore: deps.fileStore } : {}),
          },
        );
        await asOperator(viewer, (tx) => recomputeAllocationsTx(tx, orgId, now));
        return {
          kind: "imported",
          payoutIds: [],
          message: `${result.rowsNew} nya utbetalningar sparade${result.rowsDuplicate ? `, ${result.rowsDuplicate} fanns redan` : ""}.`,
        };
      }
    } catch (error) {
      if (error instanceof AccountingError) throw new PayoutError(error.message);
      // Okända rubriker: kolumnsteget nedan.
    }
    const csv = parseCsvTable(file.bytes);
    const [header, ...records] = csv.records;
    if (!header) throw new PayoutError("Filen saknar rader.");
    table = {
      headers: header.cells.map((c) => c.trim()),
      rows: records.filter((r) => !r.error).map((r) => r.cells),
    };
  } else {
    table = await readXlsxTable(file.bytes);
    if (table.headers.length === 0) throw new PayoutError("Excel-filen saknar rader.");
  }
  if (table.rows.length === 0) throw new PayoutError("Filen saknar rader under rubrikerna.");
  return asOperator(viewer, (tx) => tableDraftTx(tx, orgId, kind, name, table));
}

/** Kolumnsteget: läser utkastets tabell med ägarens val och kommer ihåg dem (om valt). */
export async function applyMappingFor(
  viewer: Viewer,
  draftId: string,
  rawMapping: unknown,
  remember: boolean,
): Promise<UploadResult> {
  if (!UUID.test(draftId)) throw new PayoutError("Utkastet finns inte.");
  const parsed = payoutMappingSchema.safeParse(rawMapping);
  if (!parsed.success) throw new PayoutError("Välj kolumnerna igen.");
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const draft = await openDraftTx(tx, orgId, draftId);
    const table = (draft.extracted as { table?: StoredTable }).table;
    if (!table) throw new PayoutError("Utkastet har ingen tabell.");
    const cols = columnsFromMapping(table.headers, parsed.data);
    if (!columnsEnough(cols)) throw new PayoutError("Välj vilken kolumn som är beloppet.");
    const { extracted, warnings } = extractFromRows(table.rows, cols);
    const all = [...warnings, ...(await deviceWarnings(tx, orgId, extracted))];
    if (remember) {
      await tx
        .insert(s.payoutImportMappings)
        .values({
          organizationId: orgId,
          headerSignature: headerSignature(table.headers),
          mapping: parsed.data as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [s.payoutImportMappings.organizationId, s.payoutImportMappings.headerSignature],
          set: { mapping: parsed.data as Record<string, unknown> },
        });
    }
    await tx
      .update(s.payoutDrafts)
      .set({
        extracted: { table, payout: extracted, mapping: parsed.data },
        warnings: all as unknown[],
      })
      .where(and(eq(s.payoutDrafts.organizationId, orgId), eq(s.payoutDrafts.id, draftId)));
    return { kind: "draft", draftId, extracted, warnings: all, extractor: "deterministic" };
  });
}

async function openDraftTx(tx: Tx, orgId: string, draftId: string) {
  const [draft] = await tx
    .select()
    .from(s.payoutDrafts)
    .where(
      and(eq(s.payoutDrafts.organizationId, orgId), eq(s.payoutDrafts.id, draftId.toLowerCase())),
    )
    .for("update");
  if (!draft || draft.status !== "open")
    throw new PayoutError("Utkastet finns inte längre. Ladda upp filen igen.");
  return draft;
}

export interface ConfirmEdits {
  readonly paidOn: string;
  readonly amountOre: number;
  readonly feesOre?: number | null;
  readonly period?: { readonly start: string; readonly end: string } | null;
  readonly note?: string | null;
}

/** "Stämmer, spara": sparar utbetalningen ur utkastet med ägarens ändringar. */
export async function confirmDraftFor(
  viewer: Viewer,
  draftId: string,
  edits: ConfirmEdits,
  now: Date = new Date(),
  deps: { readonly fileStore?: FileStore; readonly summaryWriter?: SummaryWriter | null } = {},
): Promise<RegisterPayoutResult> {
  if (!UUID.test(draftId)) throw new PayoutError("Utkastet finns inte.");
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  const draft = await asOperator(viewer, (tx) => openDraftTx(tx, orgId, draftId));
  const payout = (draft.extracted as { payout?: ExtractedPayout }).payout ?? null;
  const unchanged =
    payout !== null &&
    payout.amountOre === edits.amountOre &&
    payout.periodFrom === (edits.period?.start ?? null) &&
    payout.periodTo === (edits.period?.end ?? null);
  // En Nayax-PDF som ägaren inte ändrat: den vanliga importen (sparar rapportens siffror).
  if (
    (draft.extracted as { nayaxStatement?: boolean }).nayaxStatement &&
    unchanged &&
    draft.storagePath
  ) {
    const store = deps.fileStore ?? (await payoutFileStore());
    const bytes = await store.get(draft.storagePath);
    let result;
    try {
      result = await importNayaxStatementFor(
        viewer,
        { name: draft.fileName ?? "nayax.pdf", bytes },
        { fileStore: store },
      );
    } catch (error) {
      if (error instanceof AccountingError) throw new PayoutError(error.message);
      throw error;
    }
    if (result.status === "manual_clash") {
      throw new PayoutError(
        `Det finns redan en inskriven utbetalning för de dagarna (${result.manualReference}). Arkivera den på Ekonomi först.`,
      );
    }
    const payoutId = result.payoutId;
    await asOperator(viewer, async (tx) => {
      await tx
        .update(s.payoutDrafts)
        .set({ status: "confirmed", payoutId })
        .where(and(eq(s.payoutDrafts.organizationId, orgId), eq(s.payoutDrafts.id, draftId)));
      await recomputeAllocationsTx(tx, orgId, now);
    });
    await summarizeQuietly(viewer, payoutId, now, deps.summaryWriter);
    return { payoutId, period: result.period, inferred: false, note: null };
  }
  const lines =
    payout?.transactions
      .filter((t) => t.id)
      .map((t) => ({ externalId: t.id!, amountOre: t.amountOre })) ?? [];
  const result = await asOperator(viewer, async (tx) => {
    await openDraftTx(tx, orgId, draftId);
    const r = await registerPayoutTx(
      tx,
      orgId,
      {
        paidOn: edits.paidOn,
        amountOre: edits.amountOre,
        feesOre: edits.feesOre ?? null,
        period: edits.period ?? null,
        note: edits.note ?? null,
        basis: payout?.transactions.length ? "lines" : "report",
        lines,
      },
      today,
      now,
    );
    await tx
      .update(s.payoutDrafts)
      .set({ status: "confirmed", payoutId: r.payoutId })
      .where(and(eq(s.payoutDrafts.organizationId, orgId), eq(s.payoutDrafts.id, draftId)));
    return r;
  });
  await summarizeQuietly(viewer, result.payoutId, now, deps.summaryWriter);
  return result;
}

export async function discardDraftFor(viewer: Viewer, draftId: string): Promise<void> {
  if (!UUID.test(draftId)) throw new PayoutError("Utkastet finns inte.");
  const orgId = viewer.organization.id;
  await asOperator(viewer, async (tx) => {
    await tx
      .update(s.payoutDrafts)
      .set({ status: "discarded" })
      .where(
        and(
          eq(s.payoutDrafts.organizationId, orgId),
          eq(s.payoutDrafts.id, draftId.toLowerCase()),
          eq(s.payoutDrafts.status, "open"),
        ),
      );
  });
}

/** Utkastet att visa igen (t.ex. efter kolumnsteget). */
export async function loadDraftFor(
  viewer: Viewer,
  draftId: string,
): Promise<{
  id: string;
  extracted: ExtractedPayout | null;
  warnings: unknown[];
  extractor: string;
} | null> {
  if (!UUID.test(draftId)) return null;
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const [d] = await tx
      .select()
      .from(s.payoutDrafts)
      .where(
        and(eq(s.payoutDrafts.organizationId, orgId), eq(s.payoutDrafts.id, draftId.toLowerCase())),
      );
    if (!d || d.status !== "open") return null;
    return {
      id: d.id,
      extracted: (d.extracted as { payout?: ExtractedPayout }).payout ?? null,
      warnings: d.warnings,
      extractor: d.extractor,
    };
  });
}

// ---------------------------------------------------------------------------
// Sammanfattningen
// ---------------------------------------------------------------------------

/** Skriver sammanfattningen för en utbetalning i transaktionen (mall, eller AI som klarar kontrollen). */
export async function summarizePayoutTx(
  tx: Tx,
  orgId: string,
  payoutId: string,
  options: {
    readonly writer?: SummaryWriter | null;
    readonly aiDb?: Db;
    readonly now: Date;
  },
): Promise<string | null> {
  const overview = await loadPayOverviewTx(tx, orgId, { payoutId });
  const p = overview.payouts[0];
  if (!p || !p.allocation) return null;
  const facts = summaryFacts({
    amountOre: p.amountOre,
    periodText: p.periodText,
    diffOre: p.allocation.totals.diffOre ?? 0,
    lines: p.lines.map((l) => ({
      kind: l.kind,
      name: l.name,
      amountOre: l.amountOre,
      partner: l.partner
        ? { reimbOre: l.partner.reimbOre, profitShareOre: l.partner.profitShareOre }
        : null,
    })),
  });
  let text = templateSummary(facts);
  const writer = options.writer ?? null;
  if (writer && options.aiDb) {
    const [run] = Array.from(
      await options.aiDb.execute(sql`
        insert into public.ai_runs (organization_id, trigger, purpose, status, model)
        values (${orgId}::uuid, 'upload', 'payout_summary', 'running', ${writer.model.slice(0, 100)})
        returning id`),
    ) as { id: string }[];
    try {
      const r = await writer.write(facts);
      const ok = r.text !== null && acceptSummary(r.text, facts);
      if (ok) text = r.text!.trim();
      await options.aiDb.execute(sql`
        update public.ai_runs set status = ${ok ? "ok" : "empty"}, model = ${r.model.slice(0, 100)},
          input_tokens = ${r.usage.inputTokens}, output_tokens = ${r.usage.outputTokens},
          cache_read_tokens = ${r.usage.cacheReadTokens}, cache_write_tokens = ${r.usage.cacheWriteTokens},
          cost_ore = ${costOre(r.model, r.usage, budgetFrom(process.env).usdSek)}
        where id = ${run!.id}::uuid`);
    } catch (error) {
      await options.aiDb.execute(sql`
        update public.ai_runs set status = 'error', error = ${(error instanceof Error ? error.message : String(error)).slice(0, 2000)}
        where id = ${run!.id}::uuid`);
    }
  }
  await tx
    .update(s.payouts)
    .set({ aiSummary: text.slice(0, 1000), aiSummaryAt: options.now })
    .where(and(eq(s.payouts.organizationId, orgId), eq(s.payouts.id, payoutId)));
  return text;
}

/** Skrivaren när AI är påslaget och budgeten räcker, annars null (mallen). */
export async function summaryWriterFor(
  slug: string | null,
  db: Db,
  now: Date,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SummaryWriter | null> {
  if (isDemoBlocked(slug, env)) return null;
  const config = payoutModelFrom(env);
  if (!config) return null;
  if ((await budgetState(db, now, env)).exceeded) return null;
  return createAnthropicSummaryWriter(config);
}

async function summarizeQuietly(
  viewer: Viewer,
  payoutId: string,
  now: Date,
  writer: SummaryWriter | null | undefined,
): Promise<void> {
  try {
    const db = getServiceDb();
    const w =
      writer === undefined
        ? await summaryWriterFor(viewer.organization.slug ?? null, db, now)
        : writer;
    await asOperator(viewer, (tx) =>
      summarizePayoutTx(tx, viewer.organization.id, payoutId, { writer: w, aiDb: db, now }),
    );
  } catch (error) {
    // Sammanfattningen görs av det dagliga jobbet om den inte gick nu.
    console.error("[utbetalningar] sammanfattning", error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// Inställningarna: partneravtal, momsen och påminnelsen
// ---------------------------------------------------------------------------

export interface PayoutSettings {
  readonly agreements: readonly {
    readonly id: string;
    readonly partnerName: string;
    readonly reimburseCost: boolean;
    readonly profitShareBp: number;
    readonly validFrom: IsoDate;
  }[];
  readonly vatReserveMode: "auto" | "vmb" | "standard" | "none";
  readonly reminderDays: number;
}

export async function loadPayoutSettingsFor(viewer: Viewer): Promise<PayoutSettings> {
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const agreements = await tx
      .select({
        id: s.partnerAgreements.id,
        partnerName: s.partnerAgreements.partnerName,
        reimburseCost: s.partnerAgreements.reimburseCost,
        profitShareBp: s.partnerAgreements.profitShareBp,
        validFrom: s.partnerAgreements.validFrom,
      })
      .from(s.partnerAgreements)
      .where(
        and(eq(s.partnerAgreements.organizationId, orgId), isNull(s.partnerAgreements.archivedAt)),
      )
      .orderBy(desc(s.partnerAgreements.validFrom));
    const [settings] = await tx
      .select({
        mode: s.organizationSettings.vatReserveMode,
        days: s.organizationSettings.payoutReminderDays,
      })
      .from(s.organizationSettings)
      .where(eq(s.organizationSettings.organizationId, orgId));
    return {
      agreements,
      vatReserveMode: settings?.mode ?? "auto",
      reminderDays: settings?.days ?? 7,
    };
  });
}

/**
 * Sparar partneravtalet från en dag. Samma dag igen ersätter avtalet den dagen (det gamla
 * arkiveras). Uträkningar som redan är låsta ändras inte; utkasten räknas om.
 */
export async function savePartnerAgreementFor(
  viewer: Viewer,
  input: {
    readonly partnerName: string;
    readonly reimburseCost: boolean;
    readonly profitSharePercent: number;
    readonly validFrom: string;
  },
  now: Date = new Date(),
): Promise<void> {
  const name = input.partnerName.trim();
  if (name.length < 1 || name.length > 200) throw new PayoutError("Skriv partnerns namn.");
  const bp = Math.round(input.profitSharePercent * 100);
  if (!Number.isFinite(input.profitSharePercent) || bp < 0 || bp > 10_000) {
    throw new PayoutError("Andelen av vinsten ska vara mellan 0 och 100 %.");
  }
  if (!validDate(input.validFrom)) throw new PayoutError("Välj dagen avtalet gäller från.");
  const orgId = viewer.organization.id;
  await asOperator(viewer, async (tx) => {
    await tx
      .update(s.partnerAgreements)
      .set({ archivedAt: now })
      .where(
        and(
          eq(s.partnerAgreements.organizationId, orgId),
          eq(s.partnerAgreements.validFrom, input.validFrom),
          isNull(s.partnerAgreements.archivedAt),
        ),
      );
    await tx.insert(s.partnerAgreements).values({
      organizationId: orgId,
      partnerName: name,
      reimburseCost: input.reimburseCost,
      profitShareBp: bp,
      validFrom: input.validFrom,
    });
    await recomputeAllocationsTx(tx, orgId, now);
  });
}

export async function removePartnerAgreementFor(
  viewer: Viewer,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  if (!UUID.test(id)) throw new PayoutError("Avtalet finns inte.");
  const orgId = viewer.organization.id;
  await asOperator(viewer, async (tx) => {
    await tx
      .update(s.partnerAgreements)
      .set({ archivedAt: now })
      .where(and(eq(s.partnerAgreements.organizationId, orgId), eq(s.partnerAgreements.id, id)));
    await recomputeAllocationsTx(tx, orgId, now);
  });
}

export async function savePayoutOptionsFor(
  viewer: Viewer,
  input: { readonly vatReserveMode: string; readonly reminderDays: number },
  now: Date = new Date(),
): Promise<void> {
  const mode = input.vatReserveMode;
  if (mode !== "auto" && mode !== "vmb" && mode !== "standard" && mode !== "none") {
    throw new PayoutError("Välj hur momsen ska sparas.");
  }
  if (!Number.isInteger(input.reminderDays) || input.reminderDays < 0 || input.reminderDays > 90) {
    throw new PayoutError("Påminnelsen ska vara 0–90 dagar.");
  }
  const orgId = viewer.organization.id;
  await asOperator(viewer, async (tx) => {
    const updated = await tx
      .update(s.organizationSettings)
      .set({ vatReserveMode: mode, payoutReminderDays: input.reminderDays })
      .where(eq(s.organizationSettings.organizationId, orgId))
      .returning({ id: s.organizationSettings.id });
    if (updated.length === 0) throw new PayoutError("Inställningarna finns inte.");
    await recomputeAllocationsTx(tx, orgId, now);
  });
}

// ---------------------------------------------------------------------------
// Det dagliga jobbet
// ---------------------------------------------------------------------------

/** Utkast äldre än så tas bort. */
export const DRAFT_DAYS = 30;

/**
 * Det dagliga jobbet (/api/cron/larm), som systemet: räknar om utkasten (så att nästa
 * utbetalning får "Justering" när månadsavräkningarna skapats), skriver saknade
 * sammanfattningar och tar bort gamla utkast. Fel i en organisation stoppar inte de andra.
 */
export async function runPayoutJob(
  db: Db,
  now: Date = new Date(),
  options: {
    readonly organizationIds?: readonly string[];
    readonly writer?: SummaryWriter | null;
  } = {},
): Promise<{
  organizations: number;
  recomputed: number;
  summaries: number;
  expired: number;
  errors: number;
}> {
  const orgs = Array.from(
    await db.execute(sql`
      select distinct o.id, o.slug from public.organizations o
      join public.payouts p on p.organization_id = o.id and p.archived_at is null
      where o.archived_at is null`),
  ) as { id: string; slug: string | null }[];
  let recomputed = 0;
  let summaries = 0;
  let errors = 0;
  for (const org of orgs.filter(
    (o) => !options.organizationIds || options.organizationIds.includes(o.id),
  )) {
    try {
      const r = await db.transaction((tx) => recomputeAllocationsTx(tx, org.id, now));
      recomputed += r.computed;
      errors += r.errors.length;
      const missing = await db
        .select({ id: s.payouts.id })
        .from(s.payouts)
        .where(
          and(
            eq(s.payouts.organizationId, org.id),
            isNull(s.payouts.archivedAt),
            isNull(s.payouts.aiSummary),
          ),
        )
        .limit(10);
      const writer =
        options.writer !== undefined
          ? options.writer
          : missing.length
            ? await summaryWriterFor(org.slug, db, now)
            : null;
      for (const m of missing) {
        const text = await db.transaction((tx) =>
          summarizePayoutTx(tx, org.id, m.id, { writer, aiDb: db, now }),
        );
        if (text) summaries += 1;
      }
    } catch (error) {
      errors += 1;
      console.error(
        "[utbetalningar] jobbet",
        org.id,
        error instanceof Error ? error.message : error,
      );
    }
  }
  const expired = Array.from(
    await db.execute(sql`
      update public.payout_drafts set status = 'discarded'
      where status = 'open' and created_at < ${new Date(now.getTime() - DRAFT_DAYS * 86_400_000).toISOString()}::timestamptz
      returning id`),
  ).length;
  return { organizations: orgs.length, recomputed, summaries, expired, errors };
}
