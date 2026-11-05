/**
 * GET /inkopspriser/ny-produkt/bild?u=…&s=… → en varubild från Awish, för listan "Varor i
 * Awish" (sidornas CSP tillåter bara bilder från appen själv). Adressen måste vara signerad
 * av servern för den aktiva organisationen (image-proxy.ts), som bara signerar bilder Awish
 * svarat med. Bara ägare och
 * admin. Hämtas utan omdirigeringar, med tidsgräns och storleksgräns, och skickas bara
 * vidare om det är en bild.
 */

import { AuthorizationError } from "@/server/access";
import {
  AWISH_IMAGE_MAX_BYTES,
  AWISH_IMAGE_TYPES,
  verifyAwishImage,
} from "@/server/awish/image-proxy";
import { OPERATOR_ROLES, requireContextRole } from "@/server/data/core";

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  let organizationId: string;
  try {
    organizationId = (await requireContextRole(OPERATOR_ROLES)).organization.id;
  } catch (error) {
    if (error instanceof AuthorizationError) return text(403, "Bara ägare och admin.");
    throw error;
  }
  // Signaturen gäller bara den aktiva organisationen (inte en annan kund eller en demo).
  const url = verifyAwishImage(organizationId, params.get("u"), params.get("s"));
  if (!url) return text(404, "Bilden finns inte.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { redirect: "error", signal: controller.signal });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !(AWISH_IMAGE_TYPES as readonly string[]).includes(type)) {
      return text(404, "Bilden finns inte.");
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > AWISH_IMAGE_MAX_BYTES) return text(404, "Bilden är för stor.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > AWISH_IMAGE_MAX_BYTES) return text(404, "Bilden är för stor.");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": type,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return text(404, "Bilden gick inte att hämta.");
  } finally {
    clearTimeout(timer);
  }
}
