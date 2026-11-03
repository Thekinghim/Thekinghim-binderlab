"use server";

/**
 * Signeringen från /signera/{token} (utan inloggning). Token är beviset; databasen
 * kontrollerar allt i en transaktion (src/server/contracts/signing.ts). IP och webbläsare
 * sparas med signaturen. Försöken begränsas per IP.
 */

import { headers } from "next/headers";

import { createRateLimiter } from "@/server/rate-limit";
import { clientIp } from "@/server/request-info";
import { SigningError, signWithLink } from "@/server/contracts/signing";

export type SignResult =
  | { ok: true; signerName: string; signedAt: string }
  | { ok: false; error: string; code: SigningError["code"] | "limit" | "error" };

const limiter = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });

export async function signContract(token: unknown, form: FormData): Promise<SignResult> {
  const h = await headers();
  const ip = clientIp(h);
  if (!limiter.consume([{ key: `signera:${ip}` }]).allowed) {
    return { ok: false, code: "limit", error: "För många försök. Vänta en stund." };
  }
  if (form.get("accept") !== "1") {
    return { ok: false, code: "invalid", error: "Kryssa i att du har läst avtalet." };
  }
  try {
    const result = await signWithLink(String(token ?? ""), {
      signerName: form.get("name"),
      signature: form.get("signature"),
      documentSha256: form.get("document"),
      ip: ip === "okänd" ? null : ip,
      userAgent: h.get("user-agent"),
    });
    return { ok: true, signerName: result.signerName, signedAt: result.signedAt.toISOString() };
  } catch (error) {
    if (error instanceof SigningError) return { ok: false, code: error.code, error: error.message };
    console.error("[signera]", error);
    return { ok: false, code: "error", error: "Något gick fel. Försök igen." };
  }
}
