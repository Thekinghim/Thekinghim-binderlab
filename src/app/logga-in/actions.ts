"use server";

/**
 * Server actions för inloggningssidan (formulär med useActionState, fungerar
 * även utan JavaScript där det går).
 *
 * - Lösenord: src/server/actions/auth.ts → loginFlow (begränsning av försök,
 *   samma svar för okänd adress och fel lösenord).
 * - Länk (Supabase): svaret är alltid detsamma, oavsett om adressen har ett
 *   konto, så att sidan inte avslöjar vilka adresser som finns. Länken begärs
 *   med det implicita flödet och fungerar i vilken webbläsare eller app som
 *   helst (Mail-appen, hemskärmen): den landar på /logga-in/bekrafta med
 *   sessionen i fragmentet, och knappen "Logga in" skickar hit den.
 * - Glömt lösenord: samma sorts länk, till /logga-in/nytt-losenord.
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
import { LINK_JWT, LINK_REFRESH, MESSAGES, setPasswordFromLinkFlow } from "@/server/auth/flows";
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
  type NewPasswordState,
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

/** Gemensamt för "Skicka länk" och "Glömt lösenord?": kontroll, gräns, utskick. */
async function sendLink(formData: FormData, kind: "login" | "reset"): Promise<MagicLinkState> {
  const email = field(formData, "email").trim().toLowerCase();
  if (email === "" || !z.email().max(320).safeParse(email).success) {
    return { status: "idle", email, error: "Ange en giltig e-postadress." };
  }
  const provider = await getAuthProvider();
  const send =
    kind === "login"
      ? provider.signInWithMagicLink?.bind(provider)
      : provider.sendPasswordReset?.bind(provider);
  if (!send) {
    return { status: "idle", email, error: "Finns inte här. Logga in med lösenord." };
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
      error: `För många länkar. Vänta ${minutes} ${minutes === 1 ? "minut" : "minuter"}.`,
    };
  }
  const env = getServerEnv();
  let baseUrl: string;
  try {
    baseUrl = resolveAppBaseUrl(env, requestHeaders);
  } catch {
    return { status: "idle", email, error: LOGIN_UNAVAILABLE };
  }
  if (kind === "login") {
    // Vart man ska efter inloggningen, om länken öppnas i samma webbläsare.
    // Saknas cookien (annan webbläsare eller app) går man till startsidan.
    (await cookies()).set(MAGIC_COOKIE, safeRedirectPath(field(formData, "next")), {
      httpOnly: true,
      sameSite: "lax",
      secure: env.APP_ENV !== "development",
      path: "/logga-in",
      maxAge: MAGIC_TTL_SECONDS,
    });
  }
  try {
    // Resultatet visas inte: okänd adress och skickad länk ger samma svar.
    await send(
      email,
      `${baseUrl}${kind === "login" ? "/logga-in/bekrafta" : "/logga-in/nytt-losenord"}`,
    );
  } catch (error) {
    console.error("[logga-in] Länken kunde inte skickas:", error);
  }
  return { status: SENT, email };
}

export async function requestMagicLink(
  _prev: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  return sendLink(formData, "login");
}

export async function requestPasswordReset(
  _prev: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  return sendLink(formData, "reset");
}

const LINK_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const confirmInput = z.union([
  z.object({ accessToken: LINK_JWT, refreshToken: LINK_REFRESH }),
  z.object({ code: LINK_TOKEN }),
  z.object({
    tokenHash: LINK_TOKEN,
    type: z.enum(["magiclink", "email"]).catch("magiclink"),
  }),
]);

function confirmFields(formData: FormData): unknown {
  const accessToken = field(formData, "access_token");
  if (accessToken) return { accessToken, refreshToken: field(formData, "refresh_token") };
  const code = field(formData, "code");
  if (code) return { code };
  return { tokenHash: field(formData, "token_hash"), type: field(formData, "type") };
}

/**
 * Tar emot länken från mejlet och loggar in. Tre former:
 * - fragmentet `#access_token=…` (Supabases standardmall, implicit flöde),
 *   skickat hit av sidan: fungerar i vilken webbläsare som helst;
 * - `?token_hash=…` (egen mall): fungerar också överallt;
 * - `?code=…` (PKCE, äldre länkar): bara i samma webbläsare.
 */
export async function confirmMagicLink(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const parsed = confirmInput.safeParse(confirmFields(formData));
  if (!parsed.success) return { error: MESSAGES.linkFailed, failed: true };
  const provider = await getAuthProvider();
  const data = parsed.data;
  let session: Awaited<ReturnType<NonNullable<typeof provider.completeTokenLink>>> = null;
  try {
    session =
      "accessToken" in data
        ? ((await provider.completeTokenLink?.(data)) ?? null)
        : "code" in data
          ? ((await provider.completeCodeLink?.(data.code)) ?? null)
          : ((await provider.completeEmailLink?.(data.tokenHash, "magiclink")) ?? null);
  } catch (error) {
    console.error("[logga-in] Länken kunde inte tas emot:", error);
    session = null;
  }
  if (!session) return { error: MESSAGES.linkFailed, failed: true };
  const jar = await cookies();
  const pending = jar.get(MAGIC_COOKIE)?.value;
  jar.delete({ name: MAGIC_COOKIE, path: "/logga-in" });
  redirect(safeRedirectPath(pending));
}

/** Nytt lösenord från länken i "Glömt lösenord?"-mejlet. Loggar in och går till startsidan. */
export async function setNewPassword(
  _prev: NewPasswordState,
  formData: FormData,
): Promise<NewPasswordState> {
  const result = await setPasswordFromLinkFlow(
    { provider: await getAuthProvider() },
    {
      accessToken: field(formData, "access_token"),
      refreshToken: field(formData, "refresh_token"),
      password: field(formData, "password"),
      confirm: field(formData, "confirm"),
    },
  );
  if (!result.ok) {
    return { error: result.error, failed: result.error === MESSAGES.linkFailed };
  }
  redirect("/");
}
