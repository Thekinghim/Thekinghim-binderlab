/**
 * Var den importerade orderlistan sparas (underlag), enligt FileStore-mönstret i
 * src/import/file-store.ts:
 *
 * - `local` (standard i development): disk under `.data/imports`.
 * - `supabase` (standard i preview och production): privata bucketen `imports` i
 *   Supabase Storage, med den inloggade användarens session (publishable key och
 *   cookies), så att storage-policyerna gäller (ägare och admin laddar upp).
 *
 * IMPORT_FILE_STORE=local|supabase styr valet uttryckligen. Läses när den används
 * (inte vid import), så att tester kan sätta den.
 */

import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

import { LocalFileStore, SupabaseFileStore, type FileStore } from "@/import/file-store";
import { nextCookieJar } from "@/server/auth/next-cookies";
import { supabaseCookieOptions } from "@/server/auth/supabase-cookies";

type Env = Readonly<Record<string, string | undefined>>;

export const IMPORTS_BUCKET = "imports";

export type ImportFileStoreKind = "local" | "supabase";

export function importFileStoreKind(env: Env = process.env): ImportFileStoreKind {
  const v = (env.IMPORT_FILE_STORE ?? "").trim().toLowerCase();
  if (v === "local" || v === "supabase") return v;
  return (env.APP_ENV ?? "development") === "development" ? "local" : "supabase";
}

/** Lagringen för den inloggade användaren (server actions). */
export async function importFileStore(env: Env = process.env): Promise<FileStore> {
  if (importFileStoreKind(env) === "local") {
    return new LocalFileStore();
  }
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL och SUPABASE_PUBLISHABLE_KEY saknas: filen kan inte sparas.");
  }
  const jar = await nextCookieJar();
  const client = createServerClient(url, key, {
    cookieOptions: supabaseCookieOptions(env.APP_ENV !== "development"),
    cookies: {
      getAll: () => jar.getAll(),
      // Sessionen förnyas av proxyn; här skrivs inga cookies.
      setAll: () => {},
    },
  });
  return new SupabaseFileStore(client, IMPORTS_BUCKET);
}

/**
 * Lagringen med systemnyckeln, för importer som servern gör utan någon medlem i
 * organisationen (Demo för kunder: ägaren som skapar demon är inte medlem i den).
 */
export function systemImportFileStore(env: Env = process.env): FileStore {
  if (importFileStoreKind(env) === "local") {
    return new LocalFileStore();
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL och SUPABASE_SECRET_KEY saknas: filen kan inte sparas.");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return new SupabaseFileStore(client, IMPORTS_BUCKET);
}
