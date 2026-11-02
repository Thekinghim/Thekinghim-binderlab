/**
 * Lagring av importerade källfiler (underlag). Sökvägen är alltid
 * "{organization_id}/{data_source_id}/{sha256}.csv": servern namnger filen
 * själv, och samma innehåll hamnar på samma ställe. En fil skrivs aldrig över
 * (storage-policyerna tillåter det inte heller).
 *
 * - LocalFileStore: disk (.data/imports), för utveckling och tester.
 * - SupabaseFileStore: bucket "imports" i Supabase Storage, med användarens
 *   klient så att storage-policyerna gäller. Kan inte provas i byggmiljön.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

export interface StoredFile {
  path: string;
  /** false om filen redan fanns (samma innehåll laddades upp tidigare). */
  created: boolean;
}

export interface FileStore {
  readonly kind: "local" | "supabase";
  put(storagePath: string, content: Uint8Array, contentType: string): Promise<StoredFile>;
  get(storagePath: string): Promise<Uint8Array>;
}

// Samma regel som private.storage_path_org() i databasen.
const STORAGE_PATH =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,199})+$/;

export function isValidStoragePath(storagePath: string): boolean {
  return STORAGE_PATH.test(storagePath);
}

function assertStoragePath(storagePath: string): void {
  if (!isValidStoragePath(storagePath)) {
    throw new RangeError(`Ogiltig sökväg för fil: ${storagePath}`);
  }
}

/** Sökvägen för en importerad fil. */
export function importStoragePath(
  organizationId: string,
  dataSourceId: string,
  sha256: string,
): string {
  const p = `${organizationId}/${dataSourceId}/${sha256}.csv`;
  assertStoragePath(p);
  return p;
}

export class LocalFileStore implements FileStore {
  readonly kind = "local" as const;
  readonly root: string;

  constructor(root = path.join(process.cwd(), ".data", "imports")) {
    this.root = path.resolve(root);
  }

  private resolve(storagePath: string): string {
    assertStoragePath(storagePath);
    const full = path.resolve(this.root, ...storagePath.split("/"));
    if (!full.startsWith(this.root + path.sep)) {
      throw new RangeError(`Ogiltig sökväg för fil: ${storagePath}`);
    }
    return full;
  }

  async put(storagePath: string, content: Uint8Array): Promise<StoredFile> {
    const full = this.resolve(storagePath);
    await mkdir(path.dirname(full), { recursive: true });
    try {
      await writeFile(full, content, { flag: "wx" });
      return { path: storagePath, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { path: storagePath, created: false };
      }
      throw error;
    }
  }

  async get(storagePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolve(storagePath)));
  }
}

export class SupabaseFileStore implements FileStore {
  readonly kind = "supabase" as const;

  constructor(
    private readonly client: SupabaseClient,
    private readonly bucket = "imports",
  ) {}

  async put(storagePath: string, content: Uint8Array, contentType: string): Promise<StoredFile> {
    assertStoragePath(storagePath);
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(storagePath, content, { contentType, upsert: false });
    if (!error) {
      return { path: storagePath, created: true };
    }
    // Finns redan (samma innehåll, samma namn): inte ett fel.
    const status = String(
      (error as { statusCode?: unknown; status?: unknown }).statusCode ??
        (error as { status?: unknown }).status ??
        "",
    );
    if (status === "409" || /already exists|duplicate/i.test(error.message)) {
      return { path: storagePath, created: false };
    }
    throw new Error(`Kunde inte spara filen i ${this.bucket}: ${error.message}`, { cause: error });
  }

  async get(storagePath: string): Promise<Uint8Array> {
    assertStoragePath(storagePath);
    const { data, error } = await this.client.storage.from(this.bucket).download(storagePath);
    if (error || !data) {
      throw new Error(`Kunde inte läsa filen ${storagePath}: ${error?.message ?? "saknas"}`, {
        cause: error,
      });
    }
    return new Uint8Array(await data.arrayBuffer());
  }
}
