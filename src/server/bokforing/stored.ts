/**
 * Sparade månadspaket: från den 1:a i varje månad tar det schemalagda jobbet
 * (/api/cron/bokforing, pg_cron en gång om dagen) fram förra månadens paket för varje
 * organisation och sparar det (ZIP i den privata bucketen 'bookkeeping', raden i
 * public.bookkeeping_packages). Ändras underlaget (kvitton, siffror, kontoplan) blir det
 * ett nytt paket med nästa versionsnummer; samma underlag ger inget nytt.
 *
 * Har en butik med vinstdelning order utan inköpspris sparas paketet som preliminärt,
 * med en rad om varför.
 *
 * Nedladdningen i Ekonomi → Bokföring använder det sparade paketet (storedPackageFor):
 * rollen kontrolleras först (ägare, admin, läsare), och är paketet inaktuellt eller saknas
 * tas ett nytt fram och sparas innan det skickas.
 *
 * Skriver som systemrollen (getServiceDb och secret key): bara servern sparar paket.
 */

import "server-only";

import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import * as s from "@/db/schema";
import type { PackageStatus } from "@/db/schema";
import { addMonths, type IsoDate } from "@/domain";
import { LocalFileStore, SupabaseFileStore, type FileStore } from "@/import/file-store";
import { sha256Hex } from "@/import/hash";
import { accountingConfig } from "@/server/accounting/config";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES } from "@/server/data/core/types";

import {
  assertEndedMonth,
  BokforingError,
  hasContent,
  packageSource,
  preliminaryReason,
  renderPackage,
  type OrgRef,
  type PackageSource,
} from "./service";

export const BOOKKEEPING_BUCKET = "bookkeeping";

type Env = Readonly<Record<string, string | undefined>>;
type RenderPdf = ((html: string) => Promise<Uint8Array>) | null;

export interface StoredPackage {
  readonly month: string;
  readonly version: number;
  readonly status: PackageStatus;
  readonly reason: string | null;
  readonly fileName: string;
  readonly storagePath: string;
  readonly fileSha256: string;
  readonly sizeBytes: number;
  readonly generatedAt: string;
}

export interface PackageDeps {
  readonly db?: Db;
  /** Bucketen för paketen (systemets nyckel). */
  readonly packages?: FileStore;
  /** Bucketen för kvittona (systemets nyckel). */
  readonly receipts?: FileStore;
  readonly renderPdf?: RenderPdf;
}

// ---------------------------------------------------------------------------
// Lagring (systemets nyckel; lokalt på disk som kvittona)
// ---------------------------------------------------------------------------

function systemBucket(bucket: string, env: Env): FileStore {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL och SUPABASE_SECRET_KEY krävs för bokföringens lagring.");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return new SupabaseFileStore(client, bucket);
}

export function systemPackageStore(env: Env = process.env): FileStore {
  if (accountingConfig().contractFileStore === "local") {
    return new LocalFileStore(
      path.resolve(
        env.BOOKKEEPING_FILE_DIR?.trim() || path.join(process.cwd(), ".data", "bookkeeping"),
      ),
    );
  }
  return systemBucket(BOOKKEEPING_BUCKET, env);
}

export function systemReceiptStore(env: Env = process.env): FileStore {
  if (accountingConfig().contractFileStore === "local") {
    return new LocalFileStore(
      path.resolve(env.RECEIPT_FILE_DIR?.trim() || path.join(process.cwd(), ".data", "receipts")),
    );
  }
  return systemBucket("receipts", env);
}

// ---------------------------------------------------------------------------
// Underlagets fingeravtryck
// ---------------------------------------------------------------------------

/**
 * sha256 av allt som påverkar paketets innehåll (inte dagens datum). En månad med VMB på
 * hashas utan valet och utan kontot för försäljning utan VMB (som inte används); med VMB av
 * blir fingeravtrycket ett annat. Allt i `book` ingår, även avtalets VMB-val per butik
 * (`stores[].split`), så osända månader får en ny version när innehållet ändras. Skickade
 * månader med ett sparat paket behåller det (se ensureStoredPackage).
 */
export function packageFingerprint(org: OrgRef, src: PackageSource): string {
  const { vmbEnabled, ...withoutChoice } = src.book;
  const { sales, ...vmbPlan } = src.settings.plan;
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        company: org.name,
        book: vmbEnabled ? withoutChoice : src.book,
        plan: vmbEnabled ? vmbPlan : { ...vmbPlan, sales },
        series: src.settings.series,
        orgNumber: src.settings.orgNumber,
        number: src.number,
        fiscalYear: src.fiscalYear,
        receipts: src.receipts.map((r) => [r.id, r.fileSha256, r.fileName]),
      }),
    ),
  );
}

function toStored(r: typeof s.bookkeepingPackages.$inferSelect): StoredPackage {
  return {
    month: r.month.slice(0, 7),
    version: r.version,
    status: r.status,
    reason: r.reason,
    fileName: r.fileName,
    storagePath: r.storagePath,
    fileSha256: r.fileSha256,
    sizeBytes: Number(r.sizeBytes),
    generatedAt: r.generatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Ta fram och spara
// ---------------------------------------------------------------------------

export interface EnsureResult {
  /** null = inget att bokföra (inga order och inga kvitton). */
  readonly stored: StoredPackage | null;
  /** Ett nytt paket (ny version) sparades nu. */
  readonly created: boolean;
  /** Paketets bytes när det togs fram nu (annars läses det ur lagringen). */
  readonly bytes: Uint8Array | null;
}

/**
 * Sparar månadens paket om det saknas eller om underlaget har ändrats (ny version). En
 * månad som är markerad som skickad och redan har ett sparat paket ändras aldrig här (inte
 * av det schemalagda jobbet, nedladdningen eller VMB-knappen): ändrade siffror syns som
 * "ändrad sedan skickad", och "ångra skickad" ger en ny version. Systemrollen; anroparen
 * har kontrollerat behörigheten.
 */
export async function ensureStoredPackage(
  org: OrgRef,
  month: string,
  today: IsoDate,
  deps: PackageDeps = {},
): Promise<EnsureResult> {
  assertEndedMonth(month, today);
  const db = deps.db ?? getServiceDb();
  const monthDate = `${month}-01`;
  const read = await db.transaction(async (tx) => {
    const src = await packageSource(tx, org, month, today);
    const [row] = await tx
      .select()
      .from(s.bookkeepingPackages)
      .where(
        and(
          eq(s.bookkeepingPackages.organizationId, org.id),
          eq(s.bookkeepingPackages.month, monthDate),
        ),
      );
    return { src, row: row ?? null };
  });
  const { src, row } = read;
  if (!src || !hasContent(src))
    return { stored: row ? toStored(row) : null, created: false, bytes: null };
  if (row && src.sentAt) return { stored: toStored(row), created: false, bytes: null };

  const fingerprint = packageFingerprint(org, src);
  if (row && row.fingerprint === fingerprint) {
    return { stored: toStored(row), created: false, bytes: null };
  }

  const reason = preliminaryReason(src.book);
  const pkg = await renderPackage(org, src, today, {
    store: src.receipts.length > 0 ? (deps.receipts ?? systemReceiptStore()) : null,
    renderPdf: deps.renderPdf ?? null,
    preliminary: reason,
  });
  const sha = sha256Hex(pkg.bytes);
  const version = (row?.version ?? 0) + 1;
  const storagePath = `${org.id}/${month}/v${version}-${sha}.zip`;
  await (deps.packages ?? systemPackageStore()).put(storagePath, pkg.bytes, "application/zip");

  const status: PackageStatus = reason ? "preliminary" : "final";
  const saved = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`bokforing-paket:${org.id}:${month}`}))`,
    );
    const [current] = await tx
      .select()
      .from(s.bookkeepingPackages)
      .where(
        and(
          eq(s.bookkeepingPackages.organizationId, org.id),
          eq(s.bookkeepingPackages.month, monthDate),
        ),
      );
    // Någon annan hann före med samma underlag: behåll den raden.
    if (current && current.fingerprint === fingerprint) return { row: current, created: false };
    const values = {
      version: (current?.version ?? 0) + 1,
      status,
      reason,
      fingerprint,
      storagePath,
      fileName: pkg.fileName,
      sizeBytes: pkg.bytes.byteLength,
      fileSha256: sha,
      generatedAt: new Date(),
    };
    const [r] = current
      ? await tx
          .update(s.bookkeepingPackages)
          .set(values)
          .where(eq(s.bookkeepingPackages.id, current.id))
          .returning()
      : await tx
          .insert(s.bookkeepingPackages)
          .values({ organizationId: org.id, month: monthDate, ...values })
          .returning();
    return { row: r!, created: true };
  });
  return {
    stored: toStored(saved.row),
    created: saved.created,
    bytes: saved.created && saved.row.fileSha256 === sha ? pkg.bytes : null,
  };
}

export interface RunResult {
  readonly organizations: readonly {
    readonly id: string;
    readonly month: string;
    readonly status: "created" | "unchanged" | "empty" | "error";
    readonly version?: number;
    readonly packageStatus?: PackageStatus;
    readonly message?: string;
  }[];
}

/**
 * Det schemalagda jobbet: förra månadens paket för varje organisation med order, och nya
 * versioner av äldre sparade paket vars underlag ändrats.
 */
export async function runBokforingForAll(
  deps: PackageDeps & {
    readonly now?: Date;
    /** Bara dessa organisationer (tester). */
    readonly organizationIds?: readonly string[];
  } = {},
): Promise<RunResult> {
  const db = deps.db ?? getServiceDb();
  const now = deps.now ?? new Date();
  const only = deps.organizationIds ? `{${deps.organizationIds.join(",")}}` : null;
  const orgs = Array.from(
    await db.execute(sql`
      select o.id::text as id, o.name, o.timezone,
             coalesce(array_agg(to_char(p.month, 'YYYY-MM')) filter (where p.month is not null),
                      '{}') as stored
      from public.organizations o
      left join public.bookkeeping_packages p on p.organization_id = o.id
      where o.archived_at is null
        and exists (select 1 from public.orders x where x.organization_id = o.id)
        and (${only}::uuid[] is null or o.id = any (${only}::uuid[]))
      group by o.id, o.name, o.timezone
      order by o.created_at`),
  ) as { id: string; name: string; timezone: string; stored: string[] }[];
  const out: RunResult["organizations"][number][] = [];
  for (const o of orgs) {
    const org: OrgRef = { id: o.id, name: o.name, timezone: o.timezone };
    const today = businessToday(now, org.timezone);
    const previous = addMonths(today.slice(0, 7), -1);
    const months = [...new Set([previous, ...o.stored])]
      .filter((m) => m < today.slice(0, 7))
      .sort();
    for (const month of months) {
      try {
        const r = await ensureStoredPackage(org, month, today, { ...deps, db });
        out.push({
          id: org.id,
          month,
          status: r.stored === null ? "empty" : r.created ? "created" : "unchanged",
          ...(r.stored ? { version: r.stored.version, packageStatus: r.stored.status } : {}),
        });
      } catch (error) {
        console.error("bokforing: paketet kunde inte tas fram", org.id, month, error);
        out.push({
          id: org.id,
          month,
          status: "error",
          message: error instanceof Error ? error.message.slice(0, 300) : "Okänt fel.",
        });
      }
    }
  }
  return { organizations: out };
}

// ---------------------------------------------------------------------------
// Användaren: ladda ned, och raden i Att göra
// ---------------------------------------------------------------------------

/** Det sparade paketet (aktuellt), för nedladdningen. Ägare, admin och läsare. */
export async function storedPackageFor(
  viewer: Viewer,
  month: string,
  today: IsoDate,
  deps: PackageDeps = {},
): Promise<{ fileName: string; bytes: Uint8Array; stored: StoredPackage }> {
  assertEndedMonth(month, today);
  await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  const r = await ensureStoredPackage(viewer.organization, month, today, deps);
  if (!r.stored) throw new BokforingError("Inget att bokföra för månaden.");
  const bytes =
    r.bytes ?? (await (deps.packages ?? systemPackageStore()).get(r.stored.storagePath));
  if (sha256Hex(bytes) !== r.stored.fileSha256) throw new BokforingError("Paketets fil är ändrad.");
  return { fileName: r.stored.fileName, bytes, stored: r.stored };
}

/** De sparade paketen per månad ("ÅÅÅÅ-MM"), som användaren (RLS). */
export async function storedPackagesFor(viewer: Viewer): Promise<Map<string, StoredPackage>> {
  const rows = await withUserDbFor(viewer.user, (tx) =>
    tx
      .select()
      .from(s.bookkeepingPackages)
      .where(eq(s.bookkeepingPackages.organizationId, viewer.organization.id)),
  );
  return new Map(rows.map((r) => [r.month.slice(0, 7), toStored(r)]));
}

/**
 * Efter ändrat "VMB i bokföringen": tar fram nya versioner av sparade paket för avslutade
 * månader som inte är markerade som skickade (skickade månader behåller sitt val och sitt
 * paket). Ägare och admin. Returnerar antalet nya versioner; fel loggas och lämnas åt det
 * schemalagda jobbet och nedladdningen, som tar fram paketet när underlaget ändrats.
 */
export async function refreshUnsentPackagesFor(
  viewer: Viewer,
  today: IsoDate,
  deps: PackageDeps = {},
): Promise<number> {
  await requireRoleFor(viewer.user, viewer.organization.id, ["owner", "admin"]);
  const rows = await withUserDbFor(viewer.user, (tx) =>
    tx
      .select({ month: s.bookkeepingPackages.month })
      .from(s.bookkeepingPackages)
      .leftJoin(
        s.bookkeepingMonths,
        and(
          eq(s.bookkeepingMonths.organizationId, s.bookkeepingPackages.organizationId),
          eq(s.bookkeepingMonths.month, s.bookkeepingPackages.month),
        ),
      )
      .where(
        and(
          eq(s.bookkeepingPackages.organizationId, viewer.organization.id),
          isNull(s.bookkeepingMonths.sentAt),
        ),
      ),
  );
  let created = 0;
  for (const r of rows) {
    const month = r.month.slice(0, 7);
    if (month >= today.slice(0, 7)) continue;
    try {
      const res = await ensureStoredPackage(viewer.organization, month, today, deps);
      if (res.created) created++;
    } catch (error) {
      console.error("bokforing: paketet kunde inte tas fram på nytt", month, error);
    }
  }
  return created;
}

export interface ReadyLine {
  readonly month: string;
  readonly status: PackageStatus;
  readonly reason: string | null;
  readonly version: number;
}

/**
 * Raden i Att göra: senaste sparade paketet för en månad som inte är markerad som skickad.
 * Ägare och admin; null för andra roller och när inget väntar.
 */
export async function readyPackageFor(viewer: Viewer): Promise<ReadyLine | null> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, ["owner", "admin"]);
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
  const rows = await withUserDbFor(viewer.user, (tx) =>
    tx
      .select({
        month: s.bookkeepingPackages.month,
        status: s.bookkeepingPackages.status,
        reason: s.bookkeepingPackages.reason,
        version: s.bookkeepingPackages.version,
      })
      .from(s.bookkeepingPackages)
      .leftJoin(
        s.bookkeepingMonths,
        and(
          eq(s.bookkeepingMonths.organizationId, s.bookkeepingPackages.organizationId),
          eq(s.bookkeepingMonths.month, s.bookkeepingPackages.month),
        ),
      )
      .where(
        and(
          eq(s.bookkeepingPackages.organizationId, viewer.organization.id),
          isNull(s.bookkeepingMonths.sentAt),
        ),
      )
      .orderBy(desc(s.bookkeepingPackages.month))
      .limit(1),
  );
  const r = rows[0];
  return r
    ? { month: r.month.slice(0, 7), status: r.status, reason: r.reason, version: r.version }
    : null;
}
