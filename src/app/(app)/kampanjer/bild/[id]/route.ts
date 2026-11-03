/**
 * GET /kampanjer/bild/{id} → kampanjens bild, för appens egna sidor (CSP tillåter bara
 * 'self'). Ägare, admin och läsare i kampanjens organisation (readCampaignImageFor
 * kontrollerar rollen mot databasen och läser raden som användaren med RLS). Bildtypen
 * kontrolleras mot innehållet innan den skickas.
 */

import { AuthorizationError, isUuid } from "@/server/access";
import { readCampaignImageFor } from "@/server/campaigns/service";
import { requireViewer } from "@/server/data/core";

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
  if (!isUuid(id)) return text(404, "Bilden finns inte.");
  try {
    const viewer = await requireViewer();
    const image = await readCampaignImageFor(viewer, id);
    if (!image) return text(404, "Bilden finns inte.");
    return new Response(Buffer.from(image.bytes), {
      status: 200,
      headers: {
        "content-type": image.type,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return text(403, error.message);
    throw error;
  }
}
