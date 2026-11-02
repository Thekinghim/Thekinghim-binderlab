/**
 * Mellanlagring av en fil som laddas upp i bitar (se CHUNK_BYTES), så att även en
 * orderlista med hela historiken (upp till 50 MB) kan laddas upp med förlopp och
 * förhandsvisas flera gånger (t.ex. med ändrad kolumnmappning) utan att skickas om.
 *
 * Bitarna ligger i databasen (public.import_uploads och public.import_upload_chunks,
 * migreringen 20261102133644_datakallor_import_uploads.sql), så att alla
 * serverinstanser ser samma uppladdning och inget skrivs till serverns disk
 * (skrivskyddad på Vercel). Allt läses och skrivs som användaren med RLS: bara den
 * som laddade upp, och bara som ägare eller admin, ser sina rader.
 *
 * Bitarna tas emot i ordning; en bit som skickas igen (omförsök) ignoreras och en
 * bit som hoppar över en annan avvisas. Uppladdningen tas bort efter importen, när
 * användaren avbryter och när den är äldre än ett dygn (vid användarens nästa
 * uppladdning).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import { ImportValidationError } from "@/import/errors";
import { withUserDbFor, type SessionUser } from "@/server/access";

import { MAX_UPLOAD_BYTES } from "./constants";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Uppladdningar äldre än så tas bort. */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

export interface StagingOwner {
  readonly organizationId: string;
  readonly user: SessionUser;
}

export interface StagedUpload {
  readonly uploadId: string;
  readonly fileName: string;
  readonly size: number;
  readonly received: number;
  readonly nextIndex: number;
  readonly createdAt: string;
}

const GONE = "Uppladdningen finns inte längre (den tas bort efter ett dygn). Välj filen igen.";

function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) {
    throw new ImportValidationError(`Ogiltigt ${what}.`);
  }
}

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

const META_COLUMNS = sql`id, file_name, size_bytes, received_bytes, next_index, created_at`;

function toMeta(r: Row): StagedUpload {
  const created = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at));
  return {
    uploadId: String(r.id),
    fileName: String(r.file_name),
    size: Number(r.size_bytes),
    received: Number(r.received_bytes),
    nextIndex: Number(r.next_index),
    createdAt: created.toISOString(),
  };
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  // Textform (\x…) om drivrutinen inte tolkar bytea.
  const text = String(value);
  return Buffer.from(text.startsWith("\\x") ? text.slice(2) : text, "hex");
}

export class UploadStaging {
  /** Påbörjar en uppladdning. Tar samtidigt bort användarens gamla uppladdningar. */
  async start(
    owner: StagingOwner,
    file: { fileName: string; size: number },
    now: Date = new Date(),
  ): Promise<StagedUpload> {
    assertUuid(owner.organizationId, "organisations-id");
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new ImportValidationError("Filen är tom.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ImportValidationError("Filen är för stor (högst 50 MB).");
    }
    await this.prune(owner, now);
    return withUserDbFor(owner.user, async (tx) => {
      const [row] = await query(
        tx,
        sql`insert into public.import_uploads (organization_id, file_name, size_bytes)
            values (${owner.organizationId}::uuid, ${file.fileName.slice(0, 500)}, ${file.size})
            returning ${META_COLUMNS}`,
      );
      if (!row) throw new Error("Uppladdningen kunde inte påbörjas.");
      return toMeta(row);
    });
  }

  /**
   * Lägger till bit nummer `index`. En bit som redan tagits emot (omförsök efter ett
   * nätverksfel) ignoreras; en bit som hoppar över en annan avvisas.
   */
  async append(
    owner: StagingOwner,
    uploadId: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<StagedUpload> {
    assertUuid(uploadId, "uppladdnings-id");
    return withUserDbFor(owner.user, async (tx) => {
      // Låser uppladdningen så att två bitar inte läggs till samtidigt.
      const [row] = await query(
        tx,
        sql`select ${META_COLUMNS} from public.import_uploads
            where organization_id = ${owner.organizationId}::uuid and id = ${uploadId}::uuid
            for update`,
      );
      if (!row) throw new ImportValidationError(GONE);
      const meta = toMeta(row);
      if (index < meta.nextIndex) {
        return meta;
      }
      if (index > meta.nextIndex) {
        throw new ImportValidationError("En del av filen saknas. Ladda upp filen igen.");
      }
      if (bytes.byteLength === 0 || meta.received + bytes.byteLength > meta.size) {
        throw new ImportValidationError("Filen blev större än väntat. Ladda upp filen igen.");
      }
      await tx.execute(
        sql`insert into public.import_upload_chunks (organization_id, upload_id, chunk_index, data)
            values (${owner.organizationId}::uuid, ${uploadId}::uuid, ${index}, ${Buffer.from(bytes)})`,
      );
      const [next] = await query(
        tx,
        sql`update public.import_uploads
            set received_bytes = received_bytes + ${bytes.byteLength}, next_index = next_index + 1
            where organization_id = ${owner.organizationId}::uuid and id = ${uploadId}::uuid
            returning ${META_COLUMNS}`,
      );
      if (!next) throw new ImportValidationError(GONE);
      return toMeta(next);
    });
  }

  /** Hela filen. Kastar om uppladdningen inte är klar. */
  async read(
    owner: StagingOwner,
    uploadId: string,
  ): Promise<{ meta: StagedUpload; content: Uint8Array }> {
    assertUuid(uploadId, "uppladdnings-id");
    return withUserDbFor(owner.user, async (tx) => {
      const [row] = await query(
        tx,
        sql`select ${META_COLUMNS} from public.import_uploads
            where organization_id = ${owner.organizationId}::uuid and id = ${uploadId}::uuid`,
      );
      if (!row) throw new ImportValidationError(GONE);
      const meta = toMeta(row);
      if (meta.received !== meta.size) {
        throw new ImportValidationError("Filen är inte färdiguppladdad. Ladda upp filen igen.");
      }
      const chunks = await query<{ chunk_index: number; data: unknown }>(
        tx,
        sql`select chunk_index, data from public.import_upload_chunks
            where organization_id = ${owner.organizationId}::uuid and upload_id = ${uploadId}::uuid
            order by chunk_index`,
      );
      const parts = chunks.map((c, i) => {
        if (Number(c.chunk_index) !== i) {
          throw new ImportValidationError("Filen är ofullständig. Ladda upp filen igen.");
        }
        return toBuffer(c.data);
      });
      const content = new Uint8Array(Buffer.concat(parts));
      if (content.byteLength !== meta.size) {
        throw new ImportValidationError("Filen är ofullständig. Ladda upp filen igen.");
      }
      return { meta, content };
    });
  }

  async discard(owner: StagingOwner, uploadId: string): Promise<void> {
    assertUuid(uploadId, "uppladdnings-id");
    await withUserDbFor(owner.user, async (tx) => {
      await tx.execute(
        sql`delete from public.import_upload_chunks
            where organization_id = ${owner.organizationId}::uuid and upload_id = ${uploadId}::uuid`,
      );
      await tx.execute(
        sql`delete from public.import_uploads
            where organization_id = ${owner.organizationId}::uuid and id = ${uploadId}::uuid`,
      );
    });
  }

  /** Tar bort användarens uppladdningar som är äldre än STAGING_TTL_MS. */
  async prune(owner: StagingOwner, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STAGING_TTL_MS).toISOString();
    return withUserDbFor(owner.user, async (tx) => {
      const old = await query<{ id: string }>(
        tx,
        sql`select id from public.import_uploads
            where organization_id = ${owner.organizationId}::uuid
              and created_by = (select auth.uid())
              and created_at < ${cutoff}::timestamptz`,
      );
      if (old.length === 0) return 0;
      const ids = JSON.stringify(old.map((r) => String(r.id)));
      await tx.execute(
        sql`delete from public.import_upload_chunks
            where organization_id = ${owner.organizationId}::uuid
              and upload_id in (select (jsonb_array_elements_text(${ids}::jsonb))::uuid)`,
      );
      await tx.execute(
        sql`delete from public.import_uploads
            where organization_id = ${owner.organizationId}::uuid
              and id in (select (jsonb_array_elements_text(${ids}::jsonb))::uuid)`,
      );
      return old.length;
    });
  }
}
