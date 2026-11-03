"use server";

/**
 * Server actions för inloggningssidan (formulär med useActionState, fungerar
 * även utan JavaScript).
 *
 * - Lösenord: src/server/actions/auth.ts → loginFlow (begränsning av försök,
 *   samma svar för okänd adress och fel lösenord).
 * - Magisk länk (Supabase): svaret är alltid detsamma, oavsett om adressen
 *   har ett konto, så att sidan inte avslöjar vilka adresser som finns.
 *   Länken i mejlet leder till /logga-in/bekrafta, där en knapp (POST)
 *   förbrukar den: förhandsvisningar i e-postprogram förbrukar den inte.
 *
 * `next` från formuläret är okontrollerad och passerar alltid
 * safeRedirectPath (bara lokala sökvägar).
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";
import { getAuthProvider } from "@/server/auth";
import { login } from "@/server/actions/auth";
import { safeRedirectPath } from "@/server/auth/paths";
import { createRateLimiter } from "@/server/rate-limit";
import { clientIp, resolveAppBaseUrl } from "@/server/request-info";

import {
  LOGIN_UNAVAILABLE,
  MAGIC_COOKIE,
  MAGIC_TTL_SECONDS,
  type ConfirmState,
  type LoginState,
  type MagicLinkState,
} from "./state";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = field(formData, "email").trim();
  let result: Awaited<ReturnType<typeof login>>;
  try {
    result = await login({ email, password: field(formData, "password") });
  } catch {
    // Databasen eller inloggningstjänsten svarar inte: stanna i formuläret med ett fel.
    return { error: LOGIN_UNAVAILABLE, email };
  }
  if (!result.ok) {
    return { error: result.error, email };
  }
  redirect(safeRedirectPath(field(formData, "next")));
}

// 5 länkar per 15 minuter per IP och per adress (per serverinstans; Supabase
// har dessutom egna gränser för utskick).
const globalForLimiter = globalThis as typeof globalThis & {
  __binderlabMagicLinkLimiter?: ReturnType<typeof createRateLimiter>;
};
const magicLimiter = (globalForLimiter.__binderlabMagicLinkLimiter ??= createRateLimiter({
  limit: 5,
  windowMs: 15 * 60 * 1000,
}));

const SENT: MagicLinkState["status"] = "sent";

export async function requestMagicLink(
  _prev: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  const email = field(formData, "email").trim().toLowerCase();
  if (email === "" || !z.email().max(320).safeParse(email).success) {
    return { status: "idle", email, error: "Ange en giltig e-postadress." };
  }
  const provider = await getAuthProvider();
  if (!provider.signInWithMagicLink) {
    return { status: "idle", email, error: "Inloggning med länk finns inte i den här miljön." };
  }
  const requestHeaders = await headers();
  const gate = magicLimiter.consume([
    { key: `magic:ip:${clientIp(requestHeaders)}` },
    { key: `magic:email:${email}` },
  ]);
  if (!gate.allowed) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfterMs / 60_000));
    return {
      status: "idle",
      email,
      error: `För många länkar på kort tid. Vänta ${minutes} ${minutes === 1 ? "minut" : "minuter"} och försök igen.`,
    };
  }
  const env = getServerEnv();
  let baseUrl: string;
  try {
    baseUrl = resolveAppBaseUrl(env, requestHeaders);
  } catch {
    return {
      status: "idle",
      email,
      error: "Inloggningen svarar inte just nu. Försök igen om en stund.",
    };
  }
  // Länken förbrukas bara i den webbläsare som begärde den (skydd mot att
  // någon loggar in en annan person med sin egen länk). Cookien bär också
  // vart användaren ska efter inloggningen.
  (await cookies()).set(MAGIC_COOKIE, safeRedirectPath(field(formData, "next")), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_ENV !== "development",
    path: "/logga-in",
    maxAge: MAGIC_TTL_SECONDS,
  });
  try {
    // Resultatet visas inte: okänd adress och skickad länk ger samma svar.
    await provider.signInWithMagicLink(email, `${baseUrl}/logga-in/bekrafta`);
  } catch (error) {
    console.error("[logga-in] Länken kunde inte skickas:", error);
  }
  return { status: SENT, email };
}

const LINK_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const confirmInput = z.union([
  z.object({ code: LINK_TOKEN }),
  z.object({
    tokenHash: LINK_TOKEN,
    type: z.enum(["magiclink", "email"]).catch("magiclink"),
  }),
]);

/** Förbrukar länken från mejlet och loggar in. */
export async function confirmMagicLink(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const code = field(formData, "code");
  const parsed = confirmInput.safeParse(
    code ? { code } : { tokenHash: field(formData, "token_hash"), type: field(formData, "type") },
  );
  const LINK_ERROR = "Länken har gått ut eller redan använts. Begär en ny.";
  if (!parsed.success) return { error: LINK_ERROR };
  const jar = await cookies();
  const pending = jar.get(MAGIC_COOKIE)?.value;
  if (!pending) {
    return {
      error: "Öppna länken i samma webbläsare som du begärde den i, eller begär en ny länk här.",
    };
  }
  const provider = await getAuthProvider();
  const data = parsed.data;
  // `code`: Supabases standardmall (PKCE); `token_hash`: egen mall (docs/miljoer.md).
  const session =
    "code" in data
      ? provider.completeCodeLink
        ? await provider.completeCodeLink(data.code)
        : null
      : provider.completeEmailLink
        ? await provider.completeEmailLink(data.tokenHash, "magiclink")
        : null;
  if (!session) return { error: LINK_ERROR };
  jar.delete({ name: MAGIC_COOKIE, path: "/logga-in" });
  redirect(safeRedirectPath(pending));
}
