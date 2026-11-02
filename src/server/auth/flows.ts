/**
 * Logiken bakom server actions i src/server/actions/auth.ts, utan beroende på
 * Next (provider, cookies och användare skickas in). Testas mot
 * testdatabasen i test/db/auth-flows.test.ts.
 *
 * Alla funktioner returnerar { ok, error? } med svenska felmeddelanden och
 * kastar inte för förväntade fel. Indata är okontrollerad (från klienten) och
 * valideras med zod.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  MEMBER_ROLES,
  getRoleFor,
  requireRoleFor,
  withUserDbFor,
  type SessionUser,
} from "../access";
import { dbErrorMessage, pgErrorOf } from "../errors";
import { describeInvitation, type InvitationLookup } from "../invitations";
import type { RateLimiter } from "../rate-limit";
import { validateNewPassword } from "./password";
import type { AuthProvider, CookieJar, CookieOptions } from "./types";

export type ActionResult<T = undefined> =
  { ok: true; data?: T; error?: undefined } | { ok: false; error: string; data?: undefined };

export const ACTIVE_ORG_COOKIE = "bl_org";

export function activeOrgCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 60 * 60 * 24 * 365 };
}

export const MESSAGES = {
  loginInvalid: "Fel e-postadress eller lösenord.",
  loginMissing: "Ange e-postadress och lösenord.",
  loginUnavailable: "Inloggningen svarar inte just nu. Försök igen om en stund.",
  notLoggedIn: "Du är inte inloggad.",
  inviteForbidden: "Bara ägare och admin kan bjuda in.",
  inviteInvalidInput: "Ange en giltig e-postadress och roll.",
  inviteSendFailed: "Inbjudan kunde inte skickas. Försök igen.",
  acceptLoginFirst: "Logga in för att ta emot inbjudan.",
  acceptPasswordNeeded: "Välj ett lösenord för att skapa ditt konto.",
  acceptAccountExists:
    "Det finns redan ett konto för adressen. Logga in först och öppna länken igen.",
  invitationMissing: "Inbjudan finns inte.",
  invitationExpired: "Inbjudan har gått ut.",
  invitationAccepted: "Inbjudan har redan använts.",
  invitationOtherEmail: "Inbjudan gäller en annan e-postadress.",
  notMember: "Du är inte medlem i organisationen.",
} as const;

export function tooManyAttemptsMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `För många inloggningsförsök. Vänta ${minutes} ${minutes === 1 ? "minut" : "minuter"} och försök igen.`;
}

// ---------------------------------------------------------------------------
// Inloggning
// ---------------------------------------------------------------------------

const loginInput = z.object({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().max(1024),
});

/** Misslyckade försök per konto (oavsett IP) per fönster. */
export const ACCOUNT_LOGIN_LIMIT = 20;

export interface LoginContext {
  provider: AuthProvider;
  /** Gränsen per IP och e-post är limiterns `limit`. */
  limiter: RateLimiter;
  /** Klientens IP (x-forwarded-for), eller "okänd". */
  ip: string;
  /** Gräns per konto oavsett IP; standard ACCOUNT_LOGIN_LIMIT. */
  accountLimit?: number;
}

/**
 * Inloggning med lösenord.
 *
 * Försöket räknas INNAN lösenordet prövas (i ett synkront steg), så
 * parallella förfrågningar kan inte passera gränsen. Tre räknare:
 * - IP + e-post (limiterns gräns),
 * - kontot oavsett IP (ACCOUNT_LOGIN_LIMIT; skydd mot många IP-adresser),
 * - bara IP för ogiltiga adresser, så att skräpförsök inte skapar nya nycklar.
 * En lyckad inloggning nollställer IP + e-post och kontot.
 */
export async function loginFlow(ctx: LoginContext, raw: unknown): Promise<ActionResult> {
  const parsed = loginInput.safeParse(raw);
  if (!parsed.success || parsed.data.email === "" || parsed.data.password === "") {
    return { ok: false, error: MESSAGES.loginMissing };
  }
  const { email, password } = parsed.data;
  if (!z.email().safeParse(email).success) {
    const gate = ctx.limiter.consume([{ key: `login:ip:${ctx.ip}` }]);
    return gate.allowed
      ? { ok: false, error: MESSAGES.loginInvalid }
      : { ok: false, error: tooManyAttemptsMessage(gate.retryAfterMs) };
  }
  const pairKey = `login:ip-email:${ctx.ip}|${email}`;
  const accountKey = `login:account:${email}`;
  const gate = ctx.limiter.consume([
    { key: pairKey },
    { key: accountKey, limit: ctx.accountLimit ?? ACCOUNT_LOGIN_LIMIT },
  ]);
  if (!gate.allowed) {
    return { ok: false, error: tooManyAttemptsMessage(gate.retryAfterMs) };
  }
  const result = await ctx.provider.signInWithPassword(email, password);
  if (!result.ok) {
    return {
      ok: false,
      error: result.reason === "unavailable" ? MESSAGES.loginUnavailable : MESSAGES.loginInvalid,
    };
  }
  ctx.limiter.reset(pairKey);
  ctx.limiter.reset(accountKey);
  return { ok: true };
}

export async function logoutFlow(ctx: {
  provider: AuthProvider;
  cookies: CookieJar;
}): Promise<ActionResult> {
  await ctx.provider.signOut();
  ctx.cookies.delete(ACTIVE_ORG_COOKIE);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Inbjudningar
// ---------------------------------------------------------------------------

const inviteInput = z.object({
  organizationId: z.uuid(),
  email: z.email().trim().toLowerCase().max(320),
  role: z.enum(MEMBER_ROLES),
  validDays: z.number().int().min(1).max(30).optional(),
});

export interface InviteContext {
  provider: AuthProvider;
  user: SessionUser | null;
  /** Appens adress utan avslutande snedstreck, t.ex. https://app.binderlab.se. */
  baseUrl: string;
}

/**
 * Skapar inbjudan (RPC create_invitation, som användaren) och skickar mejlet
 * i samma transaktion: misslyckas utskicket rullas inbjudan tillbaka.
 */
export async function createInviteFlow(ctx: InviteContext, raw: unknown): Promise<ActionResult> {
  if (!ctx.user) {
    return { ok: false, error: MESSAGES.notLoggedIn };
  }
  const user = ctx.user;
  const parsed = inviteInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: MESSAGES.inviteInvalidInput };
  }
  const { organizationId, email, role, validDays } = parsed.data;
  try {
    await requireRoleFor(user, organizationId, ["owner", "admin"]);
  } catch {
    return { ok: false, error: MESSAGES.inviteForbidden };
  }
  try {
    await withUserDbFor(user, async (tx) => {
      const result = await tx.execute(
        sql`select public.create_invitation(
              ${organizationId}::uuid, ${email}, ${role}::public.member_role, ${validDays ?? 7}::integer
            ) as token`,
      );
      const token = (Array.from(result)[0] as { token?: unknown } | undefined)?.token;
      if (typeof token !== "string") {
        throw new Error("create_invitation returnerade ingen token.");
      }
      await ctx.provider.sendInvite(email, `${ctx.baseUrl}/inbjudan/${token}`);
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: pgErrorOf(error) ? dbErrorMessage(error) : MESSAGES.inviteSendFailed,
    };
  }
}

const acceptInput = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  password: z.string().max(1024).optional(),
  emailTokenHash: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/)
    .optional(),
  emailLinkType: z.enum(["invite", "magiclink"]).optional(),
});

export interface AcceptContext {
  provider: AuthProvider;
  user: SessionUser | null;
  cookies: CookieJar;
  secureCookies: boolean;
  describe?: (token: string) => Promise<InvitationLookup>;
}

function lookupMessage(lookup: InvitationLookup): string | null {
  switch (lookup.status) {
    case "valid":
      return null;
    case "expired":
      return MESSAGES.invitationExpired;
    case "accepted":
      return MESSAGES.invitationAccepted;
    case "missing":
      return MESSAGES.invitationMissing;
  }
}

/**
 * Tar emot en inbjudan (RPC accept_invitation, som användaren).
 *
 * - Inloggad: accepteras direkt (e-posten måste stämma, kontrolleras i RPC:n).
 * - Supabase: `emailTokenHash` från mejllänken byts mot en session; ny
 *   användare kan samtidigt sätta lösenord.
 * - Dev: en ny användare väljer lösenord; kontot skapas för inbjudans adress.
 */
export async function acceptInviteFlow(
  ctx: AcceptContext,
  raw: unknown,
): Promise<ActionResult<{ organizationId: string }>> {
  const parsed = acceptInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: MESSAGES.invitationMissing };
  }
  const { token, password, emailTokenHash, emailLinkType } = parsed.data;
  const describe = ctx.describe ?? ((t: string) => describeInvitation(t));

  let user = ctx.user;
  let cameFromEmailLink = false;

  if (!user && emailTokenHash && ctx.provider.completeEmailLink) {
    // Skydd mot inloggnings-CSRF: mejllänken byts mot en session bara för en
    // giltig inbjudan, och bara om sessionen gäller inbjudans e-postadress.
    // Annars kan en länk med angriparens egen token_hash logga in offret som
    // angriparen.
    const lookup = await describe(token);
    const lookupError = lookupMessage(lookup);
    if (lookupError || lookup.status !== "valid") {
      return { ok: false, error: lookupError ?? MESSAGES.invitationMissing };
    }
    // Lösenordet kontrolleras innan engångslänken förbrukas.
    const earlyPasswordError = password ? validateNewPassword(password) : null;
    if (earlyPasswordError) {
      return { ok: false, error: earlyPasswordError };
    }
    user = await ctx.provider.completeEmailLink(emailTokenHash, emailLinkType ?? "invite");
    cameFromEmailLink = user !== null;
    if (user && !sameEmail(user.email, lookup.email)) {
      await signOutQuietly(ctx);
      return { ok: false, error: MESSAGES.invitationOtherEmail };
    }
  }

  if (!user) {
    if (!ctx.provider.registerInvitedUser) {
      return { ok: false, error: MESSAGES.acceptLoginFirst };
    }
    const lookup = await describe(token);
    const lookupError = lookupMessage(lookup);
    if (lookupError || lookup.status !== "valid") {
      return { ok: false, error: lookupError ?? MESSAGES.invitationMissing };
    }
    if (!password) {
      return { ok: false, error: MESSAGES.acceptPasswordNeeded };
    }
    const passwordError = validateNewPassword(password);
    if (passwordError) {
      return { ok: false, error: passwordError };
    }
    const registered = await ctx.provider.registerInvitedUser(lookup.email, password);
    if (!registered.ok) {
      return { ok: false, error: MESSAGES.acceptAccountExists };
    }
    user = registered.session;
  } else if (cameFromEmailLink && password && ctx.provider.setPassword) {
    const passwordError = validateNewPassword(password);
    if (passwordError) {
      // Kontrollerat redan före completeEmailLink; kvar som skydd.
      await signOutQuietly(ctx);
      return { ok: false, error: passwordError };
    }
    await ctx.provider.setPassword(password);
  }

  const sessionUser = user;
  let failure: string;
  try {
    const organizationId = await withUserDbFor(sessionUser, async (tx) => {
      const result = await tx.execute(sql`select public.accept_invitation(${token}) as id`);
      return (Array.from(result)[0] as { id?: unknown } | undefined)?.id;
    });
    if (typeof organizationId === "string") {
      ctx.cookies.set(ACTIVE_ORG_COOKIE, organizationId, activeOrgCookieOptions(ctx.secureCookies));
      return { ok: true, data: { organizationId } };
    }
    failure = MESSAGES.invitationMissing;
  } catch (error) {
    failure = dbErrorMessage(error);
  }
  // En session som skapades av mejllänken i just det här anropet lämnas
  // inte kvar när inbjudan inte kunde tas emot.
  if (cameFromEmailLink) {
    await signOutQuietly(ctx);
  }
  return { ok: false, error: failure };
}

function sameEmail(a: string | undefined, b: string): boolean {
  return typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function signOutQuietly(ctx: AcceptContext): Promise<void> {
  try {
    await ctx.provider.signOut();
  } catch {
    // Utloggningen får inte dölja det egentliga felet.
  }
}

// ---------------------------------------------------------------------------
// Byte av organisation
// ---------------------------------------------------------------------------

export async function switchOrganizationFlow(
  ctx: { user: SessionUser | null; cookies: CookieJar; secureCookies: boolean },
  raw: unknown,
): Promise<ActionResult> {
  if (!ctx.user) {
    return { ok: false, error: MESSAGES.notLoggedIn };
  }
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: MESSAGES.notMember };
  }
  const organizationId = parsed.data.toLowerCase();
  const role = await getRoleFor(ctx.user, organizationId);
  if (!role) {
    return { ok: false, error: MESSAGES.notMember };
  }
  ctx.cookies.set(ACTIVE_ORG_COOKIE, organizationId, activeOrgCookieOptions(ctx.secureCookies));
  return { ok: true };
}
