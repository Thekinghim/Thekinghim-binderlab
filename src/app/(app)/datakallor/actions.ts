"use server";

/**
 * Server actions för Datakällor. Tunna omslag kring ./_lib/service: indata
 * valideras här (zod), rollen kontrolleras både här (requireContextRole) och i
 * tjänsten mot databasen, och allt läses och skrivs som användaren med RLS.
 *
 * Alla returnerar { ok, data } eller { ok: false, error } med ett svenskt
 * meddelande. Ändringar som påverkar siffror (import, koppling av automat,
 * källans tidszon) räknar om alla sidor (revalidateAppData) sist.
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { ImportError } from "@/import/errors";
import { AwishApiError } from "@/server/awish/grpc-client";
import {
  AwishSetupError,
  saveAwishCredentialsFor,
  saveCredentialsSchema,
  syncAwishNowFor,
  testAwishConnectionFor,
} from "@/server/awish/manage";
import type { AwishConnectionTest } from "@/server/awish/sync";
import { dbErrorMessage } from "@/server/errors";
import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";

import {
  chunkMetaSchema,
  commitSchema,
  createSourceSchema,
  discardSchema,
  mapMachineSchema,
  previewSchema,
  startUploadSchema,
  updateSourceSchema,
} from "./_lib/schemas";
import {
  appendChunkFor,
  createDataSourceFor,
  discardUploadFor,
  mapSourceMachineFor,
  previewUploadFor,
  runUploadFor,
  startUploadFor,
  updateDataSourceFor,
} from "./_lib/service";
import { importFileStore } from "./_lib/file-store";
import { currentViewer, uploadStaging } from "./_lib/session";
import type { ActionResult, PreviewOutcome, PreviewResult } from "./_lib/types";

function failure(error: unknown): { ok: false; error: string } {
  // redirect() (utloggad) och andra Next-signaler ska inte bli felmeddelanden.
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (
    error instanceof ImportError ||
    error instanceof AuthorizationError ||
    error instanceof AwishSetupError ||
    error instanceof AwishApiError
  ) {
    return { ok: false, error: error.message };
  }
  console.error("[datakallor]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentViewer();
}

/** Mellanlagret (databasen). Filstoret behövs bara vid import. */
function deps() {
  return { staging: uploadStaging() };
}

export async function createDataSource(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = createSourceSchema.parse(raw);
    const id = await createDataSourceFor(viewer, input);
    revalidateAppData();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error);
  }
}

export async function updateDataSource(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = updateSourceSchema.parse(raw);
    await updateDataSourceFor(viewer, input);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function mapSourceMachine(
  raw: unknown,
): Promise<ActionResult<{ orders: number; externalName: string | null; machineCode: string }>> {
  try {
    const viewer = await operator();
    const input = mapMachineSchema.parse(raw);
    const data = await mapSourceMachineFor(viewer, input);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function startUpload(raw: unknown): Promise<ActionResult<{ uploadId: string }>> {
  try {
    const viewer = await operator();
    const input = startUploadSchema.parse(raw);
    return { ok: true, data: await startUploadFor(viewer, deps(), input) };
  } catch (error) {
    return failure(error);
  }
}

/** En bit av filen: FormData med uploadId, index och chunk (Blob). */
export async function uploadChunk(
  form: FormData,
): Promise<ActionResult<{ received: number; size: number }>> {
  try {
    const viewer = await operator();
    const meta = chunkMetaSchema.parse({
      uploadId: form.get("uploadId"),
      index: form.get("index"),
    });
    const chunk = form.get("chunk");
    if (!(chunk instanceof Blob)) {
      return { ok: false, error: "En del av filen saknas. Ladda upp filen igen." };
    }
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    return { ok: true, data: await appendChunkFor(viewer, deps(), { ...meta, bytes }) };
  } catch (error) {
    return failure(error);
  }
}

/** Förhandsvisning: skriver ingenting. */
export async function previewUpload(raw: unknown): Promise<ActionResult<PreviewOutcome>> {
  try {
    const viewer = await operator();
    const input = previewSchema.parse(raw);
    return { ok: true, data: await previewUploadFor(viewer, deps(), input) };
  } catch (error) {
    return failure(error);
  }
}

/** Importen: samma fil och mappning som förhandsvisades. */
export async function commitUpload(raw: unknown): Promise<ActionResult<PreviewResult>> {
  try {
    const viewer = await operator();
    const input = commitSchema.parse(raw);
    const data = await runUploadFor(
      viewer,
      { ...deps(), fileStore: await importFileStore() },
      {
        uploadId: input.uploadId,
        dataSourceId: input.dataSourceId,
        mapping: input.mapping,
        dryRun: false,
        expectedSha256: input.sha256,
        expectedSourceTimezone: input.sourceTimezone,
        saveMapping: input.saveMapping,
      },
    );
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function discardUpload(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = discardSchema.parse(raw);
    await discardUploadFor(viewer, deps(), input.uploadId);
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Awish (gRPC-API): uppgifterna sparas i Vault och lämnar aldrig servern.
// ---------------------------------------------------------------------------

/** Sparar AppId, AppSecret och AppKey (tomt fält = behåll det sparade). */
export async function saveAwishCredentials(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = saveCredentialsSchema.parse(raw);
    await saveAwishCredentialsFor(viewer, input);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/** Testa anslutningen: Merchant, Machines och Orders (en order). Importerar inget. */
export async function testAwishConnection(): Promise<ActionResult<AwishConnectionTest>> {
  try {
    const viewer = await operator();
    return { ok: true, data: await testAwishConnectionFor(viewer) };
  } catch (error) {
    return failure(error);
  }
}

/** Synka nu: samma synk som det schemalagda jobbet. */
export async function syncAwishNow(): Promise<
  ActionResult<{ newOrders: number; fetched: number; historyDone: boolean; message: string | null }>
> {
  try {
    const viewer = await operator();
    const r = await syncAwishNowFor(viewer);
    revalidateAppData();
    if (!r.ok) return { ok: false, error: r.message ?? "Synken misslyckades." };
    return {
      ok: true,
      data: {
        newOrders: r.summary?.new ?? 0,
        fetched: r.fetched,
        historyDone: r.historyDone,
        message: r.message,
      },
    };
  } catch (error) {
    return failure(error);
  }
}
