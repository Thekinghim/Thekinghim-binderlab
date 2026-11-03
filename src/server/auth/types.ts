/**
 * Auth-abstraktionen. Två implementationer:
 *
 * - `SupabaseAuthProvider` (preview och production): Supabase Auth via
 *   @supabase/ssr-cookies. Åtkomsttoken verifieras lokalt med jose mot
 *   projektets JWKS.
 * - `DevAuthProvider` (ENDAST lokalt): användare i auth.users i den lokala
 *   auth-shimmen, egen sessions-JWT i en httpOnly-cookie och mejl till
 *   .data/mail.
 *
 * Providern svarar bara på VEM som är inloggad. VAD personen får göra avgörs
 * av `requireRole()` (src/server/session.ts) och RLS i databasen.
 */

/** Den verifierade inloggningen. */
export interface AuthSession {
  /** auth.users.id (uuid). */
  userId: string;
  email: string;
}

export type SignInResult =
  | { ok: true; session: AuthSession }
  | {
      ok: false;
      /**
       * `invalid_credentials`: fel e-post eller lösenord (eller okänd användare).
       * `account_exists`: kontot finns redan (vid registrering via inbjudan).
       * `unavailable`: tjänsten svarade inte.
       */
      reason: "invalid_credentials" | "account_exists" | "unavailable";
    };

/** Typer av e-postlänkar som Supabase kan skicka (token_hash i länken). */
export type EmailLinkType = "invite" | "magiclink";

export interface AuthProvider {
  readonly kind: "supabase" | "dev";

  /** Den inloggade användaren, eller null. Verifierar alltid token. */
  getSession(): Promise<AuthSession | null>;

  signInWithPassword(email: string, password: string): Promise<SignInResult>;

  /** Skickar en inloggningslänk (bara Supabase). */
  signInWithMagicLink?(email: string, redirectTo: string): Promise<{ ok: boolean }>;

  signOut(): Promise<void>;

  /** Skickar inbjudningsmejlet med länken `acceptUrl` (/inbjudan/[token]). */
  sendInvite(email: string, acceptUrl: string): Promise<void>;

  /**
   * Bara dev: skapar ett konto för en inbjuden adress (som inte redan har
   * ett) och loggar in. Anroparen har redan kontrollerat inbjudan.
   */
  registerInvitedUser?(email: string, password: string): Promise<SignInResult>;

  /** Bara Supabase: byter token_hash från en mejllänk mot en session. */
  completeEmailLink?(tokenHash: string, type: EmailLinkType): Promise<AuthSession | null>;

  /**
   * Bara Supabase: byter `code` (PKCE) från Supabases standardmall mot en
   * session. Kräver verifieraren i cookien från samma webbläsare.
   */
  completeCodeLink?(code: string): Promise<AuthSession | null>;

  /** Bara Supabase: sätter lösenord för den inloggade användaren. */
  setPassword?(password: string): Promise<void>;
}

/** Cookie-inställningar (delmängd av Next/@supabase/ssr). */
export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none" | boolean;
  path?: string;
  maxAge?: number;
  expires?: Date;
  domain?: string;
}

/**
 * Cookies för en förfrågan. I Next är det `cookies()` från next/headers; i
 * tester en enkel Map. `set` och `delete` kan tyst ignoreras där cookies inte
 * kan skrivas (serverkomponenter).
 */
export interface CookieJar {
  get(name: string): string | undefined;
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options?: CookieOptions): void;
  delete(name: string): void;
}

/** Cookie-burk i minnet (tester och skript). */
export class MemoryCookieJar implements CookieJar {
  readonly values = new Map<string, { value: string; options?: CookieOptions }>();

  get(name: string): string | undefined {
    return this.values.get(name)?.value;
  }

  getAll(): { name: string; value: string }[] {
    return [...this.values].map(([name, { value }]) => ({ name, value }));
  }

  set(name: string, value: string, options?: CookieOptions): void {
    if (value === "" || options?.maxAge === 0) {
      this.values.delete(name);
      return;
    }
    this.values.set(name, { value, options });
  }

  delete(name: string): void {
    this.values.delete(name);
  }

  optionsFor(name: string): CookieOptions | undefined {
    return this.values.get(name)?.options;
  }
}
