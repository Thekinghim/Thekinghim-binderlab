/**
 * Digital signering på plats (Avtal → "Signera på plats").
 *
 * 1. Ägaren eller admin skapar en länk (createSigningLinkFor, som användaren). Mallavtal
 *    skrivs ut som PDF på nytt så att PDF:en och HTML:en som sparas på länken är samma
 *    text; andra avtal måste ha en PDF. Token (32 slumpbyte) visas en gång som länk och
 *    QR-kod; bara hashen sparas. Länken gäller i 7 dagar och kan användas en gång.
 * 2. Butiksägaren öppnar /signera/{token} på sin mobil, läser PDF:en, skriver sitt namn,
 *    ritar sin signatur och bekräftar (signWithLink). Databasen kontrollerar token, att
 *    länken inte är använd, ersatt eller utgången och att PDF:en är samma som när länken
 *    skapades och som visades (sha256), och sparar namn, tid, IP och webbläsare.
 * 3. Den signerade PDF:en (avtalet plus ett signaturblad) skrivs ut och sparas i bucketen
 *    'contracts'. Butiken laddar ner den med länken i 30 dagar, ägaren under Avtal.
 *
 * UNDANTAG från regeln att användarförfrågningar går via RLS: sidan /signera har ingen
 * användare. Uppslag och signering görs som databasägaren genom funktionerna i private
 * (som ingen klientroll kan köra) och token är beviset, som för inbjudningar
 * (src/server/invitations.ts). Filerna läses och skrivs med systemnyckeln, bara på sökvägar
 * som databasen gav för just den token.
 */

import "server-only";

import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import * as s from "@/db/schema";
import { sha256Hex } from "@/import/hash";
import {
  isValidStoragePath,
  LocalFileStore,
  SupabaseFileStore,
  type FileStore,
} from "@/import/file-store";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { accountingConfig } from "@/server/accounting/config";
import { attachContractFileFor, readContractFileFor } from "@/server/accounting/service";
import type { Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import { pgErrorOf } from "@/server/errors";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";

import { ContractError, contractTemplateHtmlFor } from "./service";
import {
  hashSigningToken,
  isSigningToken,
  newSigningToken,
  normalizeSignerName,
  parseSignaturePng,
  SIGNING_LINK_DAYS,
  signedDocumentHtml,
  signedFileName,
  SignatureInputError,
} from "./signing-model";

export class SigningError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "used" | "expired" | "changed" | "invalid" = "invalid",
  ) {
    super(message);
    this.name = "SigningError";
  }
}

type RenderPdf = (html: string) => Promise<Uint8Array>;
type Env = Readonly<Record<string, string | undefined>>;

/**
 * Bucketen 'contracts' med systemnyckeln (lokalt samma katalog som avtalsfilerna). Används
 * bara för sökvägar som databasen gav för en giltig token eller signatur.
 */
export function systemContractStore(env: Env = process.env): FileStore {
  const config = accountingConfig();
  if (config.contractFileStore === "local") {
    return new LocalFileStore(path.resolve(config.contractFileDir));
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL och SUPABASE_SECRET_KEY krävs för signeringen.");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return new SupabaseFileStore(client, "contracts");
}

function signingError(error: unknown): never {
  if (error instanceof SignatureInputError) throw new SigningError(error.message, "invalid");
  const pg = pgErrorOf(error);
  const map: Record<string, SigningError["code"]> = {
    BL070: "missing",
    BL071: "used",
    BL072: "expired",
    BL073: "changed",
    BL074: "invalid",
  };
  if (pg && map[pg.code]) throw new SigningError(pg.message, map[pg.code]);
  throw error;
}

// ---------------------------------------------------------------------------
// 1. Länken (ägare och admin)
// ---------------------------------------------------------------------------

export interface CreateSigningLinkDeps {
  /** Skriver ut HTML som PDF; null = PDF kan inte skapas här (avtalets PDF används). */
  readonly renderPdf: RenderPdf | null;
  /** Avtalsfilernas lagring med användarens session. */
  readonly fileStore: FileStore;
}

/** Skapar en signeringslänk. Token returneras en gång och sparas aldrig. */
export async function createSigningLinkFor(
  viewer: Viewer,
  contractId: string,
  deps: CreateSigningLinkDeps,
): Promise<{ token: string; expiresAt: Date }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const [contract] = await withUserDbFor(viewer.user, (tx) =>
    tx
      .select({
        template: s.contracts.template,
        contentType: s.contracts.fileContentType,
        sha: s.contracts.fileSha256,
        signedAt: s.contracts.signedAt,
        archivedAt: s.contracts.archivedAt,
        terminatedOn: s.contracts.terminatedOn,
        storeId: s.contracts.storeId,
      })
      .from(s.contracts)
      .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, contractId))),
  );
  if (!contract || contract.archivedAt || contract.terminatedOn) {
    throw new ContractError("Avtalet finns inte.");
  }
  if (contract.signedAt) throw new ContractError("Avtalet är redan signerat.");

  let documentSha: string | null = contract.contentType === "application/pdf" ? contract.sha : null;
  let snapshot: string | null = null;
  if (contract.template !== null && deps.renderPdf) {
    // Mallavtalet skrivs ut på nytt: PDF:en som läses och HTML:en som den signerade PDF:en
    // skrivs ut från är då samma text.
    const html = await contractTemplateHtmlFor(viewer, contractId);
    const bytes = await deps.renderPdf(html);
    const [store] = await withUserDbFor(viewer.user, (tx) =>
      tx
        .select({ name: s.stores.name })
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, contract.storeId))),
    );
    await attachContractFileFor(
      viewer,
      { contractId, fileName: `Placeringsavtal ${store?.name ?? "butik"}.pdf`, bytes },
      { fileStore: deps.fileStore },
    );
    documentSha = sha256Hex(bytes);
    snapshot = html;
  }
  if (!documentSha) {
    throw new ContractError("Avtalet behöver en PDF först. Ladda upp den.");
  }
  // Filen måste gå att läsa (och vara en PDF) innan länken lämnas ut.
  const file = await readContractFileFor(viewer, contractId, { fileStore: deps.fileStore });
  if (file.contentType !== "application/pdf" || sha256Hex(file.bytes) !== documentSha) {
    throw new ContractError("Avtalets PDF kunde inte läsas. Ladda upp den igen.");
  }

  const token = newSigningToken();
  const row = await withUserDbFor(viewer.user, async (tx) => {
    try {
      const result = await tx.execute(
        sql`select public.create_contract_signing_link(${orgId}::uuid, ${contractId}::uuid,
              ${hashSigningToken(token)}, ${documentSha}, ${snapshot}, ${SIGNING_LINK_DAYS}) as id`,
      );
      const id = (Array.from(result)[0] as { id: string }).id;
      const [link] = await tx
        .select({ expiresAt: s.contractSigningLinks.expiresAt })
        .from(s.contractSigningLinks)
        .where(
          and(eq(s.contractSigningLinks.organizationId, orgId), eq(s.contractSigningLinks.id, id)),
        );
      return link!;
    } catch (error) {
      const pg = pgErrorOf(error);
      if (pg && /^BL07[0-4]$/.test(pg.code)) throw new ContractError(pg.message);
      throw error;
    }
  });
  return { token, expiresAt: row.expiresAt };
}

// ---------------------------------------------------------------------------
// 2. Sidan /signera/{token} (utan inloggning)
// ---------------------------------------------------------------------------

export type SigningLookup =
  | {
      readonly status: "valid";
      readonly organizationName: string;
      readonly storeName: string;
      readonly contractTitle: string;
      readonly reference: string;
      readonly terms: string | null;
      readonly expiresAt: Date;
      readonly documentSha256: string;
    }
  | {
      readonly status: "signed";
      readonly organizationName: string;
      readonly storeName: string;
      readonly contractTitle: string;
      readonly signerName: string;
      readonly signedAt: Date;
    }
  | { readonly status: "used" | "expired" | "changed"; readonly organizationName: string }
  | { readonly status: "missing" };

interface RawLookup {
  status: SigningLookup["status"];
  organization_id?: string;
  contract_id?: string;
  organization_name?: string;
  store_name?: string;
  contract_title?: string;
  terms?: string | null;
  expires_at?: string;
  document_sha256?: string;
  document_path?: string | null;
  document_name?: string | null;
  signature_id?: string | null;
  signer_name?: string | null;
  signed_at?: string | null;
}

async function rawLookup(token: string, db: Db): Promise<RawLookup> {
  if (!isSigningToken(token)) return { status: "missing" };
  const result = await db.execute(sql`select private.contract_signing_lookup(${token}) as r`);
  return (Array.from(result)[0] as { r: RawLookup }).r;
}

/** Vad sidan får visa för token. Avslöjar inget för en okänd eller ersatt länk. */
export async function describeSigningLink(
  token: string,
  db: Db = getServiceDb(),
): Promise<SigningLookup> {
  const r = await rawLookup(token, db);
  if (r.status === "valid") {
    return {
      status: "valid",
      organizationName: r.organization_name ?? "",
      storeName: r.store_name ?? "",
      contractTitle: r.contract_title ?? "Avtal",
      reference: (r.contract_id ?? "").slice(0, 8).toUpperCase(),
      terms: r.terms ?? null,
      expiresAt: new Date(r.expires_at!),
      documentSha256: r.document_sha256!,
    };
  }
  if (r.status === "signed") {
    return {
      status: "signed",
      organizationName: r.organization_name ?? "",
      storeName: r.store_name ?? "",
      contractTitle: r.contract_title ?? "Avtal",
      signerName: r.signer_name ?? "",
      signedAt: new Date(r.signed_at!),
    };
  }
  if (r.status === "used" || r.status === "expired" || r.status === "changed") {
    return { status: r.status, organizationName: r.organization_name ?? "" };
  }
  return { status: "missing" };
}

export interface PublicSigningDeps {
  readonly db?: Db;
  /** Bucketen 'contracts' med systemnyckeln. */
  readonly store?: FileStore;
  readonly renderPdf?: RenderPdf | null;
}

/** Avtalets PDF för en giltig länk. Kontrollsumman måste stämma med länkens. */
export async function readSigningDocument(
  token: string,
  deps: PublicSigningDeps = {},
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const r = await rawLookup(token, deps.db ?? getServiceDb());
  if (r.status !== "valid" || !r.document_path || !r.organization_id || !r.contract_id) {
    throw new SigningError("Länken känns inte igen.", "missing");
  }
  if (
    !isValidStoragePath(r.document_path) ||
    !r.document_path.startsWith(`${r.organization_id}/${r.contract_id}/`)
  ) {
    throw new SigningError("Länken känns inte igen.", "missing");
  }
  const store = deps.store ?? systemContractStore();
  let bytes: Uint8Array;
  try {
    bytes = await store.get(r.document_path);
  } catch (error) {
    console.error("[signera] avtalets PDF kunde inte läsas", r.contract_id, error);
    throw new SigningError("Avtalet kunde inte öppnas. Be om en ny länk.", "changed");
  }
  if (sha256Hex(bytes) !== r.document_sha256) {
    throw new SigningError("Avtalet har ändrats. Be om en ny länk.", "changed");
  }
  return { fileName: r.document_name ?? "Avtal.pdf", bytes };
}

export interface SignInput {
  readonly signerName: unknown;
  /** Signaturen som data-URL (PNG). */
  readonly signature: unknown;
  /** Kontrollsumman för PDF:en som sidan visade. */
  readonly documentSha256: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** Signerar med länken. Kastar SigningError med ett meddelande till butiksägaren. */
export async function signWithLink(
  token: string,
  input: SignInput,
  deps: PublicSigningDeps = {},
): Promise<{ signerName: string; signedAt: Date; pdf: boolean }> {
  if (!isSigningToken(token)) throw new SigningError("Länken känns inte igen.", "missing");
  const db = deps.db ?? getServiceDb();
  let result: { signature_id: string; signed_at: string; signer_name: string };
  try {
    const name = normalizeSignerName(input.signerName);
    const png = parseSignaturePng(input.signature);
    const sha = typeof input.documentSha256 === "string" ? input.documentSha256 : "";
    const rows = await db.execute(
      sql`select private.contract_signing_sign(${token}, ${sha}, ${name}, ${Buffer.from(png)}::bytea,
            ${input.ip?.slice(0, 64) ?? null}, ${input.userAgent?.slice(0, 500) ?? null}) as r`,
    );
    result = (Array.from(rows)[0] as { r: typeof result }).r;
  } catch (error) {
    signingError(error);
  }
  let pdf = false;
  try {
    const doc = await ensureSignedPdf(result.signature_id, { ...deps, db });
    pdf = doc.kind === "pdf";
  } catch (error) {
    // Signaturen är sparad; PDF:en skrivs ut när den laddas ner.
    console.error("[signera] signerad PDF kunde inte skapas", result.signature_id, error);
  }
  return { signerName: result.signer_name, signedAt: new Date(result.signed_at), pdf };
}

export type SignedDocument =
  | { readonly kind: "pdf"; readonly fileName: string; readonly bytes: Uint8Array }
  | { readonly kind: "html"; readonly fileName: string; readonly html: string };

/** Den signerade PDF:en för länken (de första 30 dagarna efter signeringen). */
export async function signedDocumentForLink(
  token: string,
  deps: PublicSigningDeps = {},
): Promise<SignedDocument> {
  const db = deps.db ?? getServiceDb();
  const r = await rawLookup(token, db);
  if (r.status !== "signed" || !r.signature_id) {
    throw new SigningError("Länken känns inte igen.", "missing");
  }
  return ensureSignedPdf(r.signature_id, { ...deps, db });
}

interface SignatureRow {
  id: string;
  organization_id: string;
  contract_id: string;
  signer_name: string;
  signature_png: Uint8Array;
  document_sha256: string;
  signed_at: Date | string;
  ip: string | null;
  user_agent: string | null;
  signed_file_path: string | null;
  signed_file_sha256: string | null;
  snapshot_html: string | null;
  contract_title: string | null;
  document_name: string | null;
  store_name: string;
  organization_name: string;
  timezone: string;
}

/**
 * Den signerade PDF:en: sparad, eller utskriven nu och sparad (en gång). Utan PDF-utskrift
 * blir det HTML för utskrift i webbläsaren. Anroparen har redan kontrollerat behörigheten
 * (giltig token eller ägarens roll och RLS).
 */
async function ensureSignedPdf(
  signatureId: string,
  deps: PublicSigningDeps & { readonly db: Db },
): Promise<SignedDocument> {
  const [row] = Array.from(
    await deps.db.execute(
      sql`select s.id, s.organization_id, s.contract_id, s.signer_name, s.signature_png,
                 s.document_sha256, s.signed_at, s.ip, s.user_agent, s.signed_file_path,
                 s.signed_file_sha256, l.snapshot_html, c.title as contract_title,
                 c.file_name as document_name, st.name as store_name,
                 o.name as organization_name, o.timezone
          from public.contract_signatures s
          join public.contract_signing_links l
            on l.organization_id = s.organization_id and l.id = s.link_id
          join public.contracts c on c.organization_id = s.organization_id and c.id = s.contract_id
          join public.stores st on st.organization_id = c.organization_id and st.id = c.store_id
          join public.organizations o on o.id = s.organization_id
          where s.id = ${signatureId}::uuid`,
    ),
  ) as unknown as SignatureRow[];
  if (!row) throw new SigningError("Signaturen finns inte.", "missing");
  const fileName = signedFileName(row.store_name);
  const store = deps.store ?? systemContractStore();

  if (row.signed_file_path) {
    const bytes = await store.get(row.signed_file_path);
    if (sha256Hex(bytes) !== row.signed_file_sha256) {
      throw new SigningError("Den signerade PDF:en stämmer inte med kontrollsumman.", "changed");
    }
    return { kind: "pdf", fileName, bytes };
  }

  const html = signedDocumentHtml(row.snapshot_html, {
    organizationName: row.organization_name,
    storeName: row.store_name,
    contractTitle: row.contract_title ?? "Avtal",
    reference: row.contract_id.slice(0, 8).toUpperCase(),
    signerName: row.signer_name,
    signedAt: new Date(row.signed_at),
    timezone: row.timezone,
    ip: row.ip,
    userAgent: row.user_agent,
    documentSha256: row.document_sha256,
    documentName: row.document_name,
    signatureId: row.id,
    signaturePng: new Uint8Array(row.signature_png),
  });
  const render = deps.renderPdf === undefined ? defaultRenderer() : deps.renderPdf;
  if (!render) return { kind: "html", fileName, html };

  const bytes = await render(html);
  const sha = sha256Hex(bytes);
  const storagePath = `${row.organization_id}/${row.contract_id}/${sha}.pdf`;
  await store.put(storagePath, bytes, "application/pdf");
  const attached = Array.from(
    await deps.db.execute(
      sql`select private.contract_signing_attach(${row.id}::uuid, ${storagePath}, ${sha},
            ${bytes.byteLength}::bigint) as ok`,
    ),
  )[0] as { ok: boolean };
  if (!attached.ok) {
    // Någon annan hann före: använd den sparade.
    return ensureSignedPdf(signatureId, deps);
  }
  return { kind: "pdf", fileName, bytes };
}

function defaultRenderer(): RenderPdf | null {
  return pdfStatus().configured ? (html) => getPdfRenderer().renderHtml(html) : null;
}

// ---------------------------------------------------------------------------
// 3. Avtal (ägare, admin och läsare)
// ---------------------------------------------------------------------------

export interface ContractSignature {
  readonly signatureId: string;
  readonly signerName: string;
  readonly signedAt: Date;
}

/** Signaturen per avtal (den senaste). Ägare, admin och läsare. */
export async function loadContractSignaturesFor(
  viewer: Viewer,
): Promise<Map<string, ContractSignature>> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const rows = await withUserDbFor(viewer.user, (tx) =>
    tx
      .select({
        id: s.contractSignatures.id,
        contractId: s.contractSignatures.contractId,
        signerName: s.contractSignatures.signerName,
        signedAt: s.contractSignatures.signedAt,
      })
      .from(s.contractSignatures)
      .where(eq(s.contractSignatures.organizationId, orgId))
      .orderBy(desc(s.contractSignatures.signedAt)),
  );
  const out = new Map<string, ContractSignature>();
  for (const r of rows) {
    if (!out.has(r.contractId)) {
      out.set(r.contractId, { signatureId: r.id, signerName: r.signerName, signedAt: r.signedAt });
    }
  }
  return out;
}

/** Den signerade PDF:en för ett avtal. Ägare, admin och läsare (RLS avgör om den syns). */
export async function signedDocumentFor(
  viewer: Viewer,
  contractId: string,
  deps: PublicSigningDeps = {},
): Promise<SignedDocument> {
  const signatures = await loadContractSignaturesFor(viewer);
  const sig = signatures.get(contractId);
  if (!sig) throw new SigningError("Avtalet är inte signerat digitalt.", "missing");
  return ensureSignedPdf(sig.signatureId, { ...deps, db: deps.db ?? getServiceDb() });
}
