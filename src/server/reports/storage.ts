/**
 * Lagring av rapporternas PDF:er, med samma FileStore-mönster som importen:
 *
 * - `local` (standard i development): disk under `.data/reports`.
 * - `supabase` (standard i preview och production): privata bucketen `reports` i
 *   Supabase Storage. För en inloggad användare används hens egen session
 *   (publishable key + cookies), så att storage-policyerna (has_role) gäller. Bara det
 *   schemalagda jobbet utan användare använder secret key.
 *
 * Sökvägen är alltid "{organization_id}/{ÅÅÅÅ-MM}/{report_id}.pdf". En fil skrivs aldrig
 * över: en ny version av rapporten är en ny rad med eget id.
 */

import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

import { LocalFileStore, SupabaseFileStore, type FileStore } from "@/import/file-store";
import { nextCookieJar } from "@/server/auth/next-cookies";

export type ReportStoreKind = "local" | "supabase";

type Env = Readonly<Record<string, string | undefined>>;

export const REPORTS_BUCKET = "reports";

export function reportStoreKind(env: Env = process.env): ReportStoreKind {
  const v = (env.REPORT_STORAGE ?? "").trim().toLowerCase();
  if (v === "local" || v === "supabase") return v;
  return (env.APP_ENV ?? "development") === "development" ? "local" : "supabase";
}

/** Status för UI:t: var PDF:erna sparas och vad som saknas. Kastar aldrig. */
export function reportStorageStatus(env: Env = process.env): {
  kind: ReportStoreKind;
  configured: boolean;
  missing: string[];
} {
  const kind = reportStoreKind(env);
  if (kind === "local") return { kind, configured: true, missing: [] };
  const missing: string[] = [];
  if (!env.SUPABASE_URL) missing.push("SUPABASE_URL saknas");
  if (!env.SUPABASE_PUBLISHABLE_KEY) missing.push("SUPABASE_PUBLISHABLE_KEY saknas");
  return { kind, configured: missing.length === 0, missing };
}

export function reportPdfPath(organizationId: string, month: string, reportId: string): string {
  return `${organizationId}/${month}/${reportId}.pdf`;
}

function defaultLocalRoot(): string {
  return `${process.cwd()}/.data/reports`;
}

/**
 * Lagringen för den inloggade användaren (server actions och route handlers).
 * Supabase-klienten läser sessionen ur cookies, så policyerna gäller.
 */
export async function userReportStore(env: Env = process.env): Promise<FileStore> {
  if (reportStoreKind(env) === "local") {
    return new LocalFileStore(env.REPORT_STORAGE_DIR?.trim() || defaultLocalRoot());
  }
  const status = reportStorageStatus(env);
  if (!status.configured) throw new Error(`Lagring saknas: ${status.missing.join(", ")}.`);
  const jar = await nextCookieJar();
  const client = createServerClient(env.SUPABASE_URL!, env.SUPABASE_PUBLISHABLE_KEY!, {
    cookies: { getAll: () => jar.getAll(), setAll: () => {} },
  });
  return new SupabaseFileStore(client, REPORTS_BUCKET);
}

/** Lagringen för schemalagda jobb utan användare (secret key, kringgår policyerna). */
export function systemReportStore(env: Env = process.env): FileStore {
  if (reportStoreKind(env) === "local") {
    return new LocalFileStore(env.REPORT_STORAGE_DIR?.trim() || defaultLocalRoot());
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL och SUPABASE_SECRET_KEY krävs för jobbets lagring.");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return new SupabaseFileStore(client, REPORTS_BUCKET);
}
