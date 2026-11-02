/**
 * Kroppen i POST /api/ingest/awish: schema, storleksgränser och fel med HTTP-status.
 * Ren modul (ingen databas, ingen "server-only"), så att tilläggets tester kan använda
 * samma validering som servern.
 */

import { ZodError, z } from "zod";

import { extensionBatchSchema } from "@/import/adapters/awish-extension";

import { MAX_BATCH_ROWS, MAX_BODY_BYTES } from "./limits";

export type IngestErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "too_large"
  | "invalid"
  | "source_unavailable"
  | "failed";

/** Fel med HTTP-status och ett svenskt meddelande som tillägget visar. */
export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/** Tilläggets rapport om hur synken gick (med eller utan rader). */
export const reportSchema = z
  .object({
    state: z.enum(["ok", "logged_out", "error"]),
    message: z.string().max(500).optional(),
    /** Har tillägget läst hela historiken (första synken eller "Läs hela historiken igen")? */
    fullHistory: z.boolean().optional(),
    pagesRead: z.number().int().min(0).max(1_000_000).optional(),
    rowsSeen: z.number().int().min(0).max(100_000_000).optional(),
    mode: z.enum(["json", "html"]).optional(),
  })
  .strict();

export const ingestBodySchema = extensionBatchSchema.extend({
  report: reportSchema.optional(),
  client: z
    .object({ version: z.string().max(40).optional(), name: z.string().max(60).optional() })
    .strict()
    .optional(),
  /** Batchens nummer i synken (för loggen), från 1. */
  batch: z.number().int().min(1).max(1_000_000).optional(),
});

export type IngestBody = z.infer<typeof ingestBodySchema>;

/** Läser och validerar JSON-kroppen (storleksgräns, schema). */
export async function readIngestBody(request: Request): Promise<IngestBody> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new IngestError(
      "too_large",
      413,
      "Batchen är för stor (högst 2 MB). Skicka färre rader.",
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new IngestError(
      "too_large",
      413,
      "Batchen är för stor (högst 2 MB). Skicka färre rader.",
    );
  }
  return parseIngestBody(text);
}

export function parseIngestBody(text: string): IngestBody {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new IngestError("invalid", 400, "Kroppen är inte giltig JSON.");
  }
  if (
    json &&
    typeof json === "object" &&
    Array.isArray((json as { rows?: unknown }).rows) &&
    (json as { rows: unknown[] }).rows.length > MAX_BATCH_ROWS
  ) {
    throw new IngestError(
      "too_large",
      413,
      `Högst ${MAX_BATCH_ROWS} rader per batch. Skicka färre rader åt gången.`,
    );
  }
  try {
    return ingestBodySchema.parse(json);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
      throw new IngestError(
        "invalid",
        400,
        `Ogiltig batch${where}: ${issue?.message ?? "fel form"}.`,
      );
    }
    throw error;
  }
}
