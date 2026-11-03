/**
 * SupabaseAuthProvider (preview och production).
 *
 * - Sessionen ligger i Supabase-cookies som @supabase/ssr läser och skriver
 *   (och förnyar). Åtkomsttoken verifieras ALLTID lokalt med jose mot
 *   SUPABASE_JWKS_URL: signatur, issuer, audience `authenticated` och exp.
 *   Innehållet i cookien litar vi aldrig på utan verifiering.
 * - Inbjudningsmejl skickas med admin-API:t (SUPABASE_SECRET_KEY). Finns
 *   kontot redan skickas en inloggningslänk till samma adress i stället.
 * - Länkar (inloggning, nytt lösenord) begärs med det IMPLICITA flödet, så
 *   att Supabases standardmall fungerar i vilken webbläsare eller app som
 *   helst: länken landar med sessionen i fragmentet (`#access_token=…`), som
 *   sidan skickar hit (completeTokenLink). PKCE (`?code=`) kräver
 *   verifieraren i samma webbläsare och fungerade inte när länken öppnades
 *   från Mail-appen eller hemskärmen. En egen mall med token_hash fungerar
 *   också (completeEmailLink), se docs/miljoer.md.
 */

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { JWTVerifyGetKey } from "jose";

import { supabaseCookieOptions } from "./supabase-cookies";
import { createSupabaseJwtVerifier, remoteJwks } from "./supabase-jwt";
import type {
  AuthProvider,
  AuthSession,
  CookieJar,
  CreateAccountResult,
  EmailLinkType,
  LinkTokens,
  SignInResult,
} from "./types";

export interface SupabaseAuthProviderOptions {
  env: {
    SUPABASE_URL: string | undefined;
    SUPABASE_PUBLISHABLE_KEY: string | undefined;
    SUPABASE_SECRET_KEY: string | undefined;
    SUPABASE_JWKS_URL: string | undefined;
  };
  cookies: CookieJar;
  /** Nyckelkälla för tester; standard är SUPABASE_JWKS_URL. */
  jwks?: JWTVerifyGetKey;
  /**
   * Secure-flagga på sessionscookiesarna. Standard true; false bara lokalt
   * (APP_ENV=development, http://localhost).
   */
  secureCookies?: boolean;
  /** fetch för Supabase-anropen (tester med en falsk Supabase); standard global fetch. */
  fetch?: typeof fetch;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} saknas (krävs när AUTH_PROVIDER=supabase).`);
  }
  return value;
}

export class SupabaseAuthProvider implements AuthProvider {
  readonly kind = "supabase" as const;
  private readonly url: string;
  private readonly publishableKey: string;
  private readonly verify: ReturnType<typeof createSupabaseJwtVerifier>;
  private client: SupabaseClient | undefined;
  private implicitClient: SupabaseClient | undefined;

  constructor(private readonly options: SupabaseAuthProviderOptions) {
    this.url = required(options.env.SUPABASE_URL, "SUPABASE_URL");
    this.publishableKey = required(
      options.env.SUPABASE_PUBLISHABLE_KEY,
      "SUPABASE_PUBLISHABLE_KEY",
    );
    const jwks =
      options.jwks ?? remoteJwks(required(options.env.SUPABASE_JWKS_URL, "SUPABASE_JWKS_URL"));
    this.verify = createSupabaseJwtVerifier({ supabaseUrl: this.url, jwks });
  }

  /** Klient med användarens cookies (publishable key, RLS gäller i Supabase). */
  private userClient(): SupabaseClient {
    const flags = supabaseCookieOptions(this.options.secureCookies ?? true);
    this.client ??= createServerClient(this.url, this.publishableKey, {
      ...this.globalOptions(),
      cookieOptions: flags,
      cookies: {
        getAll: () => this.options.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            this.options.cookies.set(name, value, {
              // Flaggorna tvingas, oavsett vad biblioteket skickar.
              httpOnly: flags.httpOnly,
              secure: flags.secure,
              sameSite: flags.sameSite,
              path: options.path,
              maxAge: options.maxAge,
              expires: options.expires,
              domain: options.domain,
            });
          }
        },
      },
    });
    return this.client;
  }

  private globalOptions(): { global?: { fetch: typeof fetch } } {
    return this.options.fetch ? { global: { fetch: this.options.fetch } } : {};
  }

  /**
   * Klient utan session för att BEGÄRA länkar med det implicita flödet (ingen
   * code_challenge): länken fungerar då i vilken webbläsare som helst.
   */
  private linkClient(): SupabaseClient {
    this.implicitClient ??= createClient(this.url, this.publishableKey, {
      ...this.globalOptions(),
      auth: {
        flowType: "implicit",
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    return this.implicitClient;
  }

  /** Admin-klient (secret key). Bara för inbjudningar och konton som ägaren skapar. */
  private adminClient(): SupabaseClient {
    const secret = required(this.options.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    return createClient(this.url, secret, {
      ...this.globalOptions(),
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  private async sessionFromToken(token: string | undefined): Promise<AuthSession | null> {
    if (!token) {
      return null;
    }
    const check = await this.verify(token);
    return check.ok ? check.session : null;
  }

  async getSession(): Promise<AuthSession | null> {
    // getSession() läser cookien och förnyar en utgången token. Själva
    // token verifieras sedan lokalt; cookiens innehåll är inte betrott.
    const { data, error } = await this.userClient().auth.getSession();
    if (error) {
      return null;
    }
    return this.sessionFromToken(data.session?.access_token);
  }

  async signInWithPassword(email: string, password: string): Promise<SignInResult> {
    const { data, error } = await this.userClient().auth.signInWithPassword({ email, password });
    if (error) {
      return {
        ok: false,
        reason:
          error.status !== undefined && error.status >= 500 ? "unavailable" : "invalid_credentials",
      };
    }
    const session = await this.sessionFromToken(data.session?.access_token);
    return session ? { ok: true, session } : { ok: false, reason: "invalid_credentials" };
  }

  async signInWithMagicLink(email: string, redirectTo: string): Promise<{ ok: boolean }> {
    const { error } = await this.linkClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
    });
    return { ok: !error };
  }

  async signOut(): Promise<void> {
    await this.userClient().auth.signOut({ scope: "local" });
  }

  async sendInvite(email: string, acceptUrl: string): Promise<void> {
    const { error } = await this.adminClient().auth.admin.inviteUserByEmail(email, {
      redirectTo: acceptUrl,
    });
    if (!error) {
      return;
    }
    if (error.code === "email_exists" || error.status === 422) {
      // Kontot finns: skicka en inloggningslänk som leder till samma inbjudan.
      const fallback = await this.signInWithMagicLink(email, acceptUrl);
      if (fallback.ok) {
        return;
      }
    }
    throw new Error(
      `Supabase kunde inte skicka inbjudan (${error.code ?? error.status ?? "okänt"}).`,
    );
  }

  async completeEmailLink(tokenHash: string, type: EmailLinkType): Promise<AuthSession | null> {
    const { data, error } = await this.userClient().auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) {
      return null;
    }
    return this.sessionFromToken(data.session?.access_token);
  }

  async completeCodeLink(code: string): Promise<AuthSession | null> {
    const { data, error } = await this.userClient().auth.exchangeCodeForSession(code);
    if (error) {
      return null;
    }
    return this.sessionFromToken(data.session?.access_token);
  }

  async completeTokenLink(tokens: LinkTokens): Promise<AuthSession | null> {
    // Token verifieras lokalt (signatur, issuer, exp) innan något sparas.
    const check = await this.verify(tokens.accessToken);
    if (!check.ok) {
      return null;
    }
    const { data, error } = await this.userClient().auth.setSession({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    });
    if (error) {
      return null;
    }
    const session = await this.sessionFromToken(data.session?.access_token);
    return session && session.userId === check.session.userId ? session : null;
  }

  async sendPasswordReset(email: string, redirectTo: string): Promise<{ ok: boolean }> {
    const { error } = await this.linkClient().auth.resetPasswordForEmail(email, { redirectTo });
    return { ok: !error };
  }

  async createAccountWithPassword(email: string, password: string): Promise<CreateAccountResult> {
    const { error } = await this.adminClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (!error) {
      return "created";
    }
    // 422 betyder också t.ex. weak_password: bara koderna för befintligt konto räknas.
    if (error.code === "email_exists" || error.code === "user_already_exists") {
      return "exists";
    }
    throw new Error(`Kontot kunde inte skapas (${error.code ?? error.status ?? "okänt"}).`);
  }

  async setPassword(password: string): Promise<void> {
    const { error } = await this.userClient().auth.updateUser({ password });
    if (error) {
      throw new Error(`Lösenordet kunde inte sparas (${error.code ?? error.status ?? "okänt"}).`);
    }
  }
}
