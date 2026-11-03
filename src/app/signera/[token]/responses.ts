/**
 * Svaren för signeringens filer: aldrig i cache, aldrig indexerade, ingen referer (token
 * står i adressen) och inget skript.
 */

const COMMON: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

/** Filnamn för Content-Disposition: ASCII-reserv plus UTF-8 enligt RFC 5987. */
export function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { ...COMMON, "content-type": "text/plain; charset=utf-8" },
  });
}

export function pdfResponse(
  bytes: Uint8Array,
  fileName: string,
  kind: "inline" | "attachment" = "inline",
): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      ...COMMON,
      "content-type": "application/pdf",
      "content-disposition": disposition(kind, fileName),
    },
  });
}

export function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      ...COMMON,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    },
  });
}
