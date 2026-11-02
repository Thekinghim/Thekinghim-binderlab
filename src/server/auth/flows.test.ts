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

import { acceptInviteFlow, MESSAGES } from "./flows";
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
