/**
 * Kampanjbilderna: lagring och publik adress.
 *
 * - supabase (standard i preview och production): den publika bucketen 'campaigns'.
 *   Awish hämtar bilden utan inloggning från
 *   {SUPABASE_URL}/storage/v1/object/public/campaigns/{sökväg}. Servern laddar upp med
 *   systemnyckeln; inga klientpolicyer finns.
 * - local (standard i development och testerna): disk under .data/campaigns. Adressen
 *   pekar då på appens egen bildväg (/kampanjer/bild/{id}), som kräver inloggning; Awish
 *   kan inte hämta den, men utvecklingen anropar bara låtsas-Awish.
 *
 * Sökvägen är "{organization_id}/{sha256}.{ext}": servern namnger filen, samma bild får
 * samma namn och skrivs aldrig över. Appens sidor visar alltid bilden via
 * /kampanjer/bild/{id} (inloggning och roll kontrolleras där; CSP tillåter bara 'self').
 */

import "server-only";

import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
  isValidStoragePath,
  LocalFileStore,
  SupabaseFileStore,
  type FileStore,
} from "@/import/file-store";

import { CAMPAIGN_IMAGE_TYPES, type CampaignImageType } from "./model";

export const CAMPAIGNS_BUCKET = "campaigns";

type Env = Readonly<Record<string, string | undefined>>;

export type CampaignStoreKind = "local" | "supabase";

export function campaignStoreKind(env: Env = process.env): CampaignStoreKind {
  const v = (env.CAMPAIGN_STORAGE ?? "").trim().toLowerCase();
  if (v === "local" || v === "supabase") return v;
  return (env.APP_ENV ?? "development") === "development" ? "local" : "supabase";
}

export function campaignImagePath(
  organizationId: string,
  sha256: string,
  type: CampaignImageType,
): string {
  const p = `${organizationId}/${sha256}.${CAMPAIGN_IMAGE_TYPES[type]}`;
  if (!isValidStoragePath(p) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new RangeError(`Ogiltig sökväg för kampanjbild: ${p}`);
  }
  return p;
}

/** Lagringen (systemnyckeln i supabase-läget; disk lokalt). */
export function campaignImageStore(env: Env = process.env): FileStore {
  if (campaignStoreKind(env) === "local") {
    return new LocalFileStore(
      path.resolve(
        env.CAMPAIGN_STORAGE_DIR?.trim() || path.join(process.cwd(), ".data", "campaigns"),
      ),
    );
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL och SUPABASE_SECRET_KEY krävs för kampanjbilderna.");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return new SupabaseFileStore(client, CAMPAIGNS_BUCKET);
}

/** Adressen som skickas till Awish (cover_image). */
export function campaignPublicUrl(
  storagePath: string,
  campaignId: string,
  env: Env = process.env,
): string {
  if (campaignStoreKind(env) === "supabase") {
    const base = (env.SUPABASE_URL ?? "").replace(/\/+$/, "");
    return `${base}/storage/v1/object/public/${CAMPAIGNS_BUCKET}/${storagePath}`;
  }
  const app = (env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${app}/kampanjer/bild/${campaignId}`;
}
