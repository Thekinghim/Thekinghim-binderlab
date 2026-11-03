/**
 * GET /signera/{token}/avtal → avtalets PDF för en giltig signeringslänk (utan inloggning;
 * token är beviset). Kontrollsumman måste stämma med länkens (readSigningDocument).
 */

import { readSigningDocument, SigningError } from "@/server/contracts/signing";

import { notFound, pdfResponse } from "../responses";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  try {
    const file = await readSigningDocument(token);
    return pdfResponse(file.bytes, file.fileName);
  } catch (error) {
    if (error instanceof SigningError) return notFound(error.message);
    throw error;
  }
}
