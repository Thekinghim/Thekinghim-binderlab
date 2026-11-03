/**
 * GET /avtal/{id}/mall → placeringsavtalet från mallen som HTML, för utskrift i
 * webbläsaren när PDF inte kunde skapas på servern. Ägare, admin och läsare
 * (contractTemplateHtmlFor kontrollerar rollen mot databasen och läser som användaren).
 *
 * Allt användarinnehåll är escapat (src/reports/contract-pdf.ts); sidan har dessutom en CSP
 * utan skript.
 */

import { currentViewer } from "@/server/accounting";
import { AuthorizationError, isUuid } from "@/server/access";
import { ContractError, contractTemplateHtmlFor } from "@/server/contracts";

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return text(404, "Avtalet finns inte.");
  try {
    const viewer = await currentViewer();
    const html = await contractTemplateHtmlFor(viewer, id);
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return text(403, error.message);
    if (error instanceof ContractError) return text(404, error.message);
    throw error;
  }
}
