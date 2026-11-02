/**
 * Avtalsfiler: lagring enligt FileStore-mönstret i src/import/file-store.ts.
 *
 * Sökvägen är alltid "{organization_id}/{contract_id}/{sha256}.{ext}": servern namnger
 * filen själv, och samma innehåll hamnar på samma ställe. En fil skrivs aldrig över
 * (storage-policyerna tillåter det inte heller); ett nytt avtalsdokument får en ny sökväg.
 *
 * - local: disk (.data/contracts), för utveckling och tester.
 * - supabase: bucket 'contracts' med användarens klient, så att storage-policyerna gäller
 *   (ägare och admin laddar upp, läsaren läser, påfyllaren ingenting).
 *
 * Filtypen kontrolleras mot innehållet både när filen laddas upp och när den läses, och bara
 * typerna i CONTRACT_FILE_TYPES skickas till webbläsaren (se readContractFileFor och routen
 * /avtal/{id}/fil).
 *
 * Här finns också lagringen för utbetalningsfilerna (payoutFileStore), som delar bucket och
 * miljövariabel med orderimporten.
 */

import "server-only";

import { createServerClient } from "@supabase/ssr";

import {
  LocalFileStore,
  SupabaseFileStore,
  isValidStoragePath,
  type FileStore,
} from "@/import/file-store";
import { nextCookieJar } from "@/server/auth/next-cookies";
import { supabaseCookieOptions } from "@/server/auth/supabase-cookies";

import { accountingConfig, type AccountingConfig } from "./config";

/** Filtyper som tas emot, med filändelse. */
export const CONTRACT_FILE_TYPES: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/** Största avtalsfil (20 MB). */
export const MAX_CONTRACT_FILE_BYTES = 20 * 1024 * 1024;

/** Kontrollerar filens typ mot innehållet (magiska bytes), inte bara mot webbläsarens uppgift. */
export function sniffContractFile(bytes: Uint8Array): string | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return null;
}

export function contractStoragePath(
  organizationId: string,
  contractId: string,
  sha256: string,
  contentType: string,
): string {
  const ext = CONTRACT_FILE_TYPES[contentType];
  if (!ext) throw new RangeError(`Filtypen ${contentType} tas inte emot.`);
  const p = `${organizationId}/${contractId}/${sha256}.${ext}`;
  if (!isValidStoragePath(p)) throw new RangeError(`Ogiltig sökväg för fil: ${p}`);
  return p;
}

/** Läget för lagringen (för sidan). */
export function contractFileStoreStatus(config: AccountingConfig = accountingConfig()): {
  kind: "local" | "supabase";
  configured: boolean;
  detail: string;
} {
  if (config.contractFileStore === "local") {
    return { kind: "local", configured: true, detail: "Avtalsfilerna sparas lokalt." };
  }
  const ok = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
  return {
    kind: "supabase",
    configured: ok,
    detail: ok
      ? "Avtalsfilerna sparas i Supabase Storage."
      : "SUPABASE_URL och SUPABASE_PUBLISHABLE_KEY saknas, så avtalsfiler kan inte sparas.",
  };
}

/** Lagringen i en bucket med den inloggade användarens session (storage-policyerna gäller). */
async function userBucketStore(bucket: string, what: string): Promise<FileStore> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(`SUPABASE_URL och SUPABASE_PUBLISHABLE_KEY saknas: ${what} kan inte sparas.`);
  }
  const jar = await nextCookieJar();
  const flags = supabaseCookieOptions(process.env.APP_ENV !== "development");
  const client = createServerClient(url, key, {
    cookieOptions: flags,
    cookies: {
      getAll: () => jar.getAll(),
      // Sessionen förnyas av proxyn; här skrivs inga cookies.
      setAll: () => {},
    },
  });
  return new SupabaseFileStore(client, bucket);
}

/** FileStore för avtalsfiler enligt CONTRACT_FILE_STORE. */
export async function contractFileStore(
  config: AccountingConfig = accountingConfig(),
): Promise<FileStore> {
  if (config.contractFileStore === "local") {
    return new LocalFileStore(config.contractFileDir);
  }
  return userBucketStore("contracts", "avtalsfiler");
}

/**
 * FileStore för utbetalningsfiler (underlag), samma lagring som orderimporten: bucket
 * 'imports' under "{org}/payouts/{sha256}.csv". Väljs med IMPORT_FILE_STORE (local|supabase),
 * standard local i development och supabase annars, precis som orderimporten.
 */
export async function payoutFileStore(env: NodeJS.ProcessEnv = process.env): Promise<FileStore> {
  const v = (env.IMPORT_FILE_STORE ?? "").trim().toLowerCase();
  const kind =
    v === "local" || v === "supabase"
      ? v
      : (env.APP_ENV ?? "development") === "development"
        ? "local"
        : "supabase";
  if (kind === "local") return new LocalFileStore();
  return userBucketStore("imports", "utbetalningsfilen");
}
