/**
 * Mellanlagring av en fil som laddas upp i bitar (se CHUNK_BYTES), så att även en
 * orderlista med hela historiken (upp till 50 MB) kan laddas upp med förlopp och
 * förhandsvisas flera gånger (t.ex. med ändrad kolumnmappning) utan att skickas om.
 *
 * Varje uppladdning ligger under {rot}/{organisation}/{användare}/{uppladdning}/:
 * bara den som laddade upp kan läsa den (sökvägen byggs av den inloggade
 * användarens id på servern, aldrig av klientens indata utöver uppladdningens
 * uuid). Bitarna skrivs i ordning; en bit som skickas igen (omförsök) ignoreras.
 * Uppladdningar äldre än ett dygn tas bort.
 *
 * Mellanlagret är disk (.data/import-staging). I drift med flera serverinstanser
 * (Vercel) behöver det ligga i delad lagring; se rapporten för Datakällor.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ImportValidationError } from "@/import/errors";

import { MAX_UPLOAD_BYTES } from "./constants";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Uppladdningar äldre än så tas bort. */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

export interface StagingOwner {
  readonly organizationId: string;
  readonly userId: string;
}

export interface StagedUpload {
  readonly uploadId: string;
  readonly fileName: string;
  readonly size: number;
  readonly received: number;
  readonly nextIndex: number;
  readonly createdAt: string;
}

function defaultRoot(): string {
  return path.join(process.cwd(), ".data", "import-staging");
}

function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) {
    throw new ImportValidationError(`Ogiltigt ${what}.`);
  }
}

export class UploadStaging {
  readonly root: string;

  constructor(root: string = defaultRoot()) {
    this.root = path.resolve(root);
  }

  private ownerDir(owner: StagingOwner): string {
    assertUuid(owner.organizationId, "organisations-id");
    assertUuid(owner.userId, "användar-id");
    return path.join(this.root, owner.organizationId.toLowerCase(), owner.userId.toLowerCase());
  }

  private dir(owner: StagingOwner, uploadId: string): string {
    assertUuid(uploadId, "uppladdnings-id");
    return path.join(this.ownerDir(owner), uploadId.toLowerCase());
  }

  private async readMeta(owner: StagingOwner, uploadId: string): Promise<StagedUpload> {
    try {
      const raw = await readFile(path.join(this.dir(owner, uploadId), "meta.json"), "utf8");
      return JSON.parse(raw) as StagedUpload;
    } catch {
      throw new ImportValidationError(
        "Uppladdningen finns inte längre (den tas bort efter ett dygn). Välj filen igen.",
      );
    }
  }

  private async writeMeta(owner: StagingOwner, meta: StagedUpload): Promise<void> {
    await writeFile(
      path.join(this.dir(owner, meta.uploadId), "meta.json"),
      JSON.stringify(meta),
      "utf8",
    );
  }

  /** Påbörjar en uppladdning. Tar samtidigt bort användarens gamla uppladdningar. */
  async start(
    owner: StagingOwner,
    file: { fileName: string; size: number },
    now: Date = new Date(),
  ): Promise<StagedUpload> {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new ImportValidationError("Filen är tom.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ImportValidationError("Filen är för stor (högst 50 MB).");
    }
    await this.prune(owner, now);
    const meta: StagedUpload = {
      uploadId: randomUUID(),
      fileName: file.fileName.slice(0, 500),
      size: file.size,
      received: 0,
      nextIndex: 0,
      createdAt: now.toISOString(),
    };
    await mkdir(this.dir(owner, meta.uploadId), { recursive: true });
    await writeFile(path.join(this.dir(owner, meta.uploadId), "data.bin"), new Uint8Array());
    await this.writeMeta(owner, meta);
    return meta;
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
    const meta = await this.readMeta(owner, uploadId);
    if (index < meta.nextIndex) {
      return meta;
    }
    if (index > meta.nextIndex) {
      throw new ImportValidationError("En del av filen saknas. Ladda upp filen igen.");
    }
    if (bytes.byteLength === 0 || meta.received + bytes.byteLength > meta.size) {
      throw new ImportValidationError("Filen blev större än väntat. Ladda upp filen igen.");
    }
    await appendFile(path.join(this.dir(owner, uploadId), "data.bin"), bytes);
    const next: StagedUpload = {
      ...meta,
      received: meta.received + bytes.byteLength,
      nextIndex: meta.nextIndex + 1,
    };
    await this.writeMeta(owner, next);
    return next;
  }

  /** Hela filen. Kastar om uppladdningen inte är klar. */
  async read(
    owner: StagingOwner,
    uploadId: string,
  ): Promise<{ meta: StagedUpload; content: Uint8Array }> {
    const meta = await this.readMeta(owner, uploadId);
    if (meta.received !== meta.size) {
      throw new ImportValidationError("Filen är inte färdiguppladdad. Ladda upp filen igen.");
    }
    const content = new Uint8Array(await readFile(path.join(this.dir(owner, uploadId), "data.bin")));
    if (content.byteLength !== meta.size) {
      throw new ImportValidationError("Filen är ofullständig. Ladda upp filen igen.");
    }
    return { meta, content };
  }

  async discard(owner: StagingOwner, uploadId: string): Promise<void> {
    await rm(this.dir(owner, uploadId), { recursive: true, force: true });
  }

  /** Tar bort användarens uppladdningar som är äldre än STAGING_TTL_MS. */
  async prune(owner: StagingOwner, now: Date = new Date()): Promise<number> {
    const dir = this.ownerDir(owner);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!UUID.test(entry)) continue;
      const full = path.join(dir, entry);
      try {
        const info = await stat(full);
        if (now.getTime() - info.mtimeMs > STAGING_TTL_MS) {
          await rm(full, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // Borttagen samtidigt: inget att göra.
      }
    }
    return removed;
  }
}
