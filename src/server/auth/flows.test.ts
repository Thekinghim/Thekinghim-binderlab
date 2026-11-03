/**
 * acceptInviteFlow med mejllänk (Supabase): skydd mot inloggnings-CSRF.
 * Databasen ersätts av en fejk; inget nätverk.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeDb = vi.hoisted(() => ({ queries: [] as string[], fail: false }));

vi.mock("@/db/client", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const tx = {
    execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql } = dialect.sqlToQuery(query);
      fakeDb.queries.push(sql);
      if (fakeDb.fail) {
        throw Object.assign(new Error("Inbjudan har gått ut."), { code: "BL011" });
      }
      return [{ id: ORG }];
    },
  };
  return {
    withRls: async (_claims: unknown, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    getServiceDb: () => tx,
  };
});

import { createRateLimiter } from "../rate-limit";
import {
  acceptInviteFlow,
  CHANGE_PASSWORD_LIMIT,
  changePasswordFlow,
  MESSAGES,
  setPasswordFromLinkFlow,
} from "./flows";
import { MemoryCookieJar, type AuthProvider, type AuthSession } from "./types";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "cd".repeat(32);
const ANNA: AuthSession = {
  userId: "0f0e0d0c-0b0a-4908-8706-050403020100",
  email: "anna@example.se",
};
const EVE: AuthSession = {
  userId: "e0e0e0e0-0000-4000-8000-00000000eeee",
  email: "eve@example.se",
};

function emailLinkProvider(session: AuthSession, cookies: MemoryCookieJar) {
  const completeEmailLink = vi.fn(async () => {
    cookies.set("sb-x-auth-token", `session-${session.userId}`);
    return session;
  });
  const signOut = vi.fn(async () => {
    cookies.delete("sb-x-auth-token");
  });
  const setPassword = vi.fn(async () => {});
  const provider = { kind: "supabase", completeEmailLink, signOut, setPassword };
  return { provider: provider as unknown as AuthProvider, completeEmailLink, signOut, setPassword };
}

const validLookup = async () =>
  ({
    status: "valid",
    email: "Anna@Example.se",
    role: "viewer",
    organizationName: "A",
    storeName: null,
  }) as const;

beforeEach(() => {
  fakeDb.queries = [];
  fakeDb.fail = false;
});

describe("acceptInviteFlow med mejllänk", () => {
  it("förbrukar inte länken för en okänd inbjudan", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, completeEmailLink } = emailLinkProvider(EVE, cookies);
    const result = await acceptInviteFlow(
      {
        provider,
        user: null,
        cookies,
        secureCookies: true,
        describe: async () => ({ status: "expired" }),
      },
      { token: TOKEN, emailTokenHash: "hash", emailLinkType: "magiclink" },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.invitationExpired });
    expect(completeEmailLink).not.toHaveBeenCalled();
    expect(cookies.getAll()).toEqual([]);
  });

  it("loggar ut en session som gäller en annan adress än inbjudans", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, signOut } = emailLinkProvider(EVE, cookies);
    const result = await acceptInviteFlow(
      { provider, user: null, cookies, secureCookies: true, describe: validLookup },
      { token: TOKEN, emailTokenHash: "angriparens-hash", emailLinkType: "magiclink" },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.invitationOtherEmail });
    expect(signOut).toHaveBeenCalledOnce();
    expect(cookies.getAll()).toEqual([]);
    expect(fakeDb.queries.some((q) => q.includes("accept_invitation"))).toBe(false);
  });

  it("kontrollerar lösenordet innan engångslänken förbrukas", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, completeEmailLink } = emailLinkProvider(ANNA, cookies);
    const result = await acceptInviteFlow(
      { provider, user: null, cookies, secureCookies: true, describe: validLookup },
      { token: TOKEN, emailTokenHash: "hash", emailLinkType: "invite", password: "kort" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/minst 12/);
    expect(completeEmailLink).not.toHaveBeenCalled();
  });

  it("rätt adress: sätter lösenord och tar emot inbjudan", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, setPassword, signOut } = emailLinkProvider(ANNA, cookies);
    const result = await acceptInviteFlow(
      { provider, user: null, cookies, secureCookies: true, describe: validLookup },
      {
        token: TOKEN,
        emailTokenHash: "hash",
        emailLinkType: "invite",
        password: "ett-långt-lösenord",
      },
    );
    expect(result).toEqual({ ok: true, data: { organizationId: ORG } });
    expect(setPassword).toHaveBeenCalledWith("ett-långt-lösenord");
    expect(signOut).not.toHaveBeenCalled();
    expect(cookies.get("bl_org")).toBe(ORG);
  });

  it("lämnar ingen ny session efter sig när accept_invitation misslyckas", async () => {
    fakeDb.fail = true;
    const cookies = new MemoryCookieJar();
    const { provider, signOut } = emailLinkProvider(ANNA, cookies);
    const result = await acceptInviteFlow(
      { provider, user: null, cookies, secureCookies: true, describe: validLookup },
      { token: TOKEN, emailTokenHash: "hash", emailLinkType: "invite" },
    );
    expect(result.ok).toBe(false);
    expect(signOut).toHaveBeenCalledOnce();
    expect(cookies.getAll()).toEqual([]);
  });
});

describe("changePasswordFlow", () => {
  const CURRENT = "gammalt-lösenord-1";
  const NEXT = "nytt-lösenord-12345";

  function passwordProvider(user: AuthSession = ANNA) {
    let stored = CURRENT;
    const signInWithPassword = vi.fn(async (email: string, password: string) =>
      email === user.email && password === stored
        ? ({ ok: true, session: user } as const)
        : ({ ok: false, reason: "invalid_credentials" } as const),
    );
    const setPassword = vi.fn(async (password: string) => {
      stored = password;
    });
    const provider = { kind: "dev", signInWithPassword, setPassword };
    return { provider: provider as unknown as AuthProvider, signInWithPassword, setPassword };
  }
  const limiter = () => createRateLimiter({ limit: 5, windowMs: 60_000 });

  it("byter lösenordet med rätt nuvarande lösenord", async () => {
    const { provider, setPassword } = passwordProvider();
    const result = await changePasswordFlow(
      { provider, user: ANNA, limiter: limiter() },
      { current: CURRENT, next: NEXT, confirm: NEXT },
    );
    expect(result).toEqual({ ok: true });
    expect(setPassword).toHaveBeenCalledWith(NEXT);
  });

  it("fel nuvarande lösenord ger ett svenskt fel och sparar inget", async () => {
    const { provider, setPassword } = passwordProvider();
    const result = await changePasswordFlow(
      { provider, user: ANNA, limiter: limiter() },
      { current: "fel-lösenord-999", next: NEXT, confirm: NEXT },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.passwordWrong });
    expect(setPassword).not.toHaveBeenCalled();
  });

  it("för kort eller olika nya lösenord prövas inte mot kontot", async () => {
    const { provider, signInWithPassword } = passwordProvider();
    const ctx = { provider, user: ANNA, limiter: limiter() };
    const short = await changePasswordFlow(ctx, {
      current: CURRENT,
      next: "kort",
      confirm: "kort",
    });
    expect(short.ok).toBe(false);
    expect(short.error).toMatch(/minst 12 tecken/);
    const mismatch = await changePasswordFlow(ctx, {
      current: CURRENT,
      next: NEXT,
      confirm: `${NEXT}x`,
    });
    expect(mismatch).toEqual({ ok: false, error: MESSAGES.passwordMismatch });
    const missing = await changePasswordFlow(ctx, { current: "", next: NEXT, confirm: NEXT });
    expect(missing).toEqual({ ok: false, error: MESSAGES.passwordMissing });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("begränsar antalet försök per användare", async () => {
    const { provider, signInWithPassword } = passwordProvider();
    const ctx = { provider, user: ANNA, limiter: limiter() };
    const wrong = { current: "fel-lösenord-999", next: NEXT, confirm: NEXT };
    for (let i = 0; i < CHANGE_PASSWORD_LIMIT; i++) {
      expect((await changePasswordFlow(ctx, wrong)).error).toBe(MESSAGES.passwordWrong);
    }
    const blocked = await changePasswordFlow(ctx, { current: CURRENT, next: NEXT, confirm: NEXT });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/^För många försök att byta lösenord\./);
    expect(signInWithPassword).toHaveBeenCalledTimes(CHANGE_PASSWORD_LIMIT);
  });

  it("kräver inloggning", async () => {
    const { provider } = passwordProvider();
    const result = await changePasswordFlow(
      { provider, user: null, limiter: limiter() },
      { current: CURRENT, next: NEXT, confirm: NEXT },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.notLoggedIn });
  });
});

// Sessionen från länkens fragment (Supabases standardmall): samma skydd som token_hash.
const JWT = "aaa.bbb.ccc";
const REFRESH = "r3fr3sh";

function tokenLinkProvider(session: AuthSession | null, cookies: MemoryCookieJar) {
  const completeTokenLink = vi.fn(async () => {
    if (session) cookies.set("sb-x-auth-token", `session-${session.userId}`);
    return session;
  });
  const signOut = vi.fn(async () => {
    cookies.delete("sb-x-auth-token");
  });
  const setPassword = vi.fn(async () => {});
  const provider = { kind: "supabase", completeTokenLink, signOut, setPassword };
  return { provider: provider as unknown as AuthProvider, completeTokenLink, signOut, setPassword };
}

describe("acceptInviteFlow med sessionen i fragmentet", () => {
  it("rätt adress: tar emot inbjudan", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, completeTokenLink } = tokenLinkProvider(ANNA, cookies);
    const result = await acceptInviteFlow(
      { provider, user: null, cookies, secureCookies: true, describe: validLookup },
      { token: TOKEN, emailTokens: { accessToken: JWT, refreshToken: REFRESH } },
    );
    expect(result).toEqual({ ok: true, data: { organizationId: ORG } });
    expect(completeTokenLink).toHaveBeenCalledWith({ accessToken: JWT, refreshToken: REFRESH });
  });

  it("annan adress (inloggnings-CSRF): loggas ut och inget accepteras", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, signOut } = tokenLinkProvider(EVE, cookies);
    const result = await acceptInviteFlow(
      { provider, user: null, cookies, secureCookies: true, describe: validLookup },
      { token: TOKEN, emailTokens: { accessToken: JWT, refreshToken: REFRESH } },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.invitationOtherEmail });
    expect(signOut).toHaveBeenCalledOnce();
    expect(cookies.getAll()).toEqual([]);
    expect(fakeDb.queries.some((q) => q.includes("accept_invitation"))).toBe(false);
  });

  it("tokens med otillåtna tecken avvisas innan något görs", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, completeTokenLink } = tokenLinkProvider(ANNA, cookies);
    const result = await acceptInviteFlow(
      { provider, user: null, cookies, secureCookies: true, describe: validLookup },
      { token: TOKEN, emailTokens: { accessToken: "<script>", refreshToken: REFRESH } },
    );
    expect(result.ok).toBe(false);
    expect(completeTokenLink).not.toHaveBeenCalled();
  });
});

describe("setPasswordFromLinkFlow (Glömt lösenord?)", () => {
  const input = (password: string, confirm = password) => ({
    accessToken: JWT,
    refreshToken: REFRESH,
    password,
    confirm,
  });

  it("sätter lösenordet efter att länkens session tagits emot", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, completeTokenLink, setPassword } = tokenLinkProvider(ANNA, cookies);
    expect(await setPasswordFromLinkFlow({ provider }, input("ett långt nytt lösenord"))).toEqual({
      ok: true,
    });
    expect(completeTokenLink).toHaveBeenCalledOnce();
    expect(setPassword).toHaveBeenCalledWith("ett långt nytt lösenord");
  });

  it("kontrollerar lösenordet innan länken används", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, completeTokenLink } = tokenLinkProvider(ANNA, cookies);
    const short = await setPasswordFromLinkFlow({ provider }, input("kort"));
    expect(short.ok).toBe(false);
    const mismatch = await setPasswordFromLinkFlow(
      { provider },
      input("ett långt nytt lösenord", "ett annat långt lösenord"),
    );
    expect(mismatch).toEqual({ ok: false, error: MESSAGES.passwordMismatch });
    expect(completeTokenLink).not.toHaveBeenCalled();
  });

  it("en länk som inte går ger 'Länken gick inte att öppna.' och sätter inget", async () => {
    const cookies = new MemoryCookieJar();
    const { provider, setPassword } = tokenLinkProvider(null, cookies);
    expect(await setPasswordFromLinkFlow({ provider }, input("ett långt nytt lösenord"))).toEqual({
      ok: false,
      error: MESSAGES.linkFailed,
    });
    expect(setPassword).not.toHaveBeenCalled();
  });
});
