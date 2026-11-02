/**
 * DevAuthProvider: inloggning för LOKAL utveckling och CI.
 *
 * - Användarna ligger i auth.users i auth-shimmen (supabase/local/auth-shim.sql)
 *   med lösenordshash i `encrypted_password` (se password.ts).
 * - Sessionen är en HS256-JWT (DEV_AUTH_SECRET) i en httpOnly-cookie med
 *   SameSite=Lax.
 * - Inbjudningsmejl skrivs till .data/mail/*.eml och loggas.
 *
 * HÅRD SPÄRR: konstruktorn kastar om APP_ENV inte är development eller om
 * DATABASE_URL inte pekar på localhost/127.0.0.1 (se dev-guard.ts).
 *
 * Providern läser och skriver auth.users som databasägare. Det är
 * inloggningstjänstens egen tabell (motsvarar Supabase Auth) och undantaget
 * från regeln att användarförfrågningar går via withUserDb.
 */

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";

import { writeDevMail } from "../mail/dev-mailbox";
import { assertDevAuthAllowed } from "./dev-guard";
import { inviteMail } from "./invite-mail";
import { hashPassword, verifyPassword } from "./password";
import {
  DEV_SESSION_COOKIE,
  DEV_SESSION_TTL_SECONDS,
  signDevSession,
  verifyDevSession,
} from "./session-token";
import type { AuthProvider, AuthSession, CookieJar, SignInResult } from "./types";

export interface DevAuthProviderOptions {
  env: {
    APP_ENV: string | undefined;
    DATABASE_URL: string | undefined;
    DEV_AUTH_SECRET: string | undefined;
  };
  cookies: CookieJar;
  /** Databasen (ägaranslutningen) för auth.users. */
  db: () => Db;
  /** Katalog för .eml-filer (standard .data/mail). */
  mailDir?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  encrypted_password: string | null;
}

export class DevAuthProvider implements AuthProvider {
  readonly kind = "dev" as const;
  private readonly secret: string;

  constructor(private readonly options: DevAuthProviderOptions) {
    assertDevAuthAllowed(options.env);
    const secret = options.env.DEV_AUTH_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error("DEV_AUTH_SECRET saknas eller är kortare än 32 tecken.");
    }
    this.secret = secret;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async findUserByEmail(email: string): Promise<UserRow | undefined> {
    const result = await this.options
      .db()
      .execute(
        sql`select id, email::text as email, encrypted_password from auth.users where lower(email::text) = lower(${email.trim()}) limit 1`,
      );
    return Array.from(result)[0] as UserRow | undefined;
  }

  private async userExists(userId: string): Promise<{ email: string } | undefined> {
    const result = await this.options
      .db()
      .execute(sql`select email::text as email from auth.users where id = ${userId}::uuid`);
    return Array.from(result)[0] as { email: string } | undefined;
  }

  private async startSession(session: AuthSession): Promise<void> {
    const token = await signDevSession(session, this.secret, { now: this.now() });
    this.options.cookies.set(DEV_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // lokalt över http; dev-providern körs aldrig i drift
      path: "/",
      maxAge: DEV_SESSION_TTL_SECONDS,
    });
  }

  async getSession(): Promise<AuthSession | null> {
    const token = this.options.cookies.get(DEV_SESSION_COOKIE);
    if (!token) {
      return null;
    }
    const check = await verifyDevSession(token, this.secret, { now: this.now() });
    if (!check.ok) {
      return null;
    }
    // Användaren kan ha raderats sedan sessionen skapades.
    const user = await this.userExists(check.session.userId);
    return user ? { userId: check.session.userId, email: user.email } : null;
  }

  async signInWithPassword(email: string, password: string): Promise<SignInResult> {
    const user = await this.findUserByEmail(email);
    // verifyPassword räknar även när användaren saknas, så att tiden inte avslöjar något.
    const valid = await verifyPassword(password, user?.encrypted_password ?? null);
    if (!user || !valid) {
      return { ok: false, reason: "invalid_credentials" };
    }
    const session = { userId: user.id, email: user.email };
    await this.startSession(session);
    return { ok: true, session };
  }

  async signOut(): Promise<void> {
    this.options.cookies.delete(DEV_SESSION_COOKIE);
  }

  async sendInvite(email: string, acceptUrl: string): Promise<void> {
    const file = await writeDevMail({ to: email, ...inviteMail(acceptUrl) }, this.options.mailDir);
    (this.options.log ?? console.info)(`[dev-mejl] Inbjudan till ${email} sparad i ${file}`);
  }

  async registerInvitedUser(email: string, password: string): Promise<SignInResult> {
    const encrypted = await hashPassword(password);
    const normalized = email.trim().toLowerCase();
    const userId = await this.options.db().transaction(async (tx) => {
      const existing = Array.from(
        await tx.execute(
          sql`select id, encrypted_password from auth.users
              where lower(email::text) = ${normalized} for update`,
        ),
      )[0] as { id: string; encrypted_password: string | null } | undefined;
      if (existing?.encrypted_password) {
        return null;
      }
      if (existing) {
        await tx.execute(
          sql`update auth.users set encrypted_password = ${encrypted} where id = ${existing.id}::uuid`,
        );
        return existing.id;
      }
      const inserted = Array.from(
        await tx.execute(
          sql`insert into auth.users (email, encrypted_password) values (${normalized}, ${encrypted})
              returning id`,
        ),
      )[0] as { id: string } | undefined;
      return inserted?.id ?? null;
    });
    if (!userId) {
      return { ok: false, reason: "account_exists" };
    }
    const session = { userId, email: normalized };
    await this.startSession(session);
    return { ok: true, session };
  }
}
