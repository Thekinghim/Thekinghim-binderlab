/**
 * Inloggning och inbjudningar mot testdatabasen: DevAuthProvider (auth.users
 * i shimmen) och flödena bakom server actions (src/server/auth/flows.ts).
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getServiceDb } from "../../src/db/client";
import { DevAuthProvider } from "../../src/server/auth/dev-provider";
import {
  ACTIVE_ORG_COOKIE,
  MESSAGES,
  acceptInviteFlow,
  acceptMyInvitationFlow,
  changePasswordFlow,
  createInviteFlow,
  loginFlow,
  logoutFlow,
  myInvitationsFlow,
  switchOrganizationFlow,
} from "../../src/server/auth/flows";
import { hashPassword } from "../../src/server/auth/password";
import { DEV_SESSION_COOKIE } from "../../src/server/auth/session-token";
import { MemoryCookieJar, type AuthProvider } from "../../src/server/auth/types";
import { describeInvitation } from "../../src/server/invitations";
import { createRateLimiter } from "../../src/server/rate-limit";
import {
  asPostgres,
  createMember,
  createOrg,
  createUser,
  one,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const SECRET = "t".repeat(48);
const BASE_URL = "http://localhost:3200";
const PASSWORD = "ett långt testlösenord";

let mailDir: string;

function devProvider(cookies = new MemoryCookieJar()) {
  const provider = new DevAuthProvider({
    env: {
      APP_ENV: "development",
      DATABASE_URL: process.env.DATABASE_URL,
      DEV_AUTH_SECRET: SECRET,
    },
    cookies,
    db: getServiceDb,
    mailDir,
    log: () => {},
  });
  return { provider, cookies };
}

async function setPassword(user: TestUser, password = PASSWORD): Promise<void> {
  const hash = await hashPassword(password);
  await asPostgres((tx) =>
    tx.execute(sql`update auth.users set encrypted_password = ${hash} where id = ${user.id}`),
  );
}

async function latestMailTo(email: string): Promise<{ text: string; token: string }> {
  const files = (await readdir(mailDir)).sort();
  for (const file of files.reverse()) {
    const text = await readFile(path.join(mailDir, file), "utf8");
    if (text.includes(`To: ${email}\r\n`)) {
      const token = /\/inbjudan\/([0-9a-f]{64})/.exec(text)?.[1];
      if (token) {
        return { text, token };
      }
    }
  }
  throw new Error(`Inget mejl till ${email}`);
}

const session = (user: TestUser) => ({ userId: user.id, email: user.email });

beforeAll(async () => {
  mailDir = await mkdtemp(path.join(tmpdir(), "binderlab-auth-mail-"));
});

afterAll(async () => {
  await rm(mailDir, { recursive: true, force: true });
});

describe("DevAuthProvider", () => {
  it("loggar in med rätt lösenord och sätter en httpOnly-, SameSite=Lax-cookie", async () => {
    const user = await createUser(`Anna-${uniqueSuffix()}@Test.Binderlab.se`);
    await setPassword(user);
    const { provider, cookies } = devProvider();

    const result = await provider.signInWithPassword(user.email.toLowerCase(), PASSWORD);
    expect(result).toEqual({ ok: true, session: { userId: user.id, email: user.email } });
    expect(cookies.optionsFor(DEV_SESSION_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(await provider.getSession()).toEqual({ userId: user.id, email: user.email });

    await provider.signOut();
    expect(await provider.getSession()).toBeNull();
  });

  it("nekar fel lösenord, okänd användare och konto utan lösenord med samma svar", async () => {
    const withPassword = await createUser();
    await setPassword(withPassword);
    const withoutPassword = await createUser();
    const { provider, cookies } = devProvider();
    for (const [email, password] of [
      [withPassword.email, "fel lösenord här"],
      [`okand-${uniqueSuffix()}@test.binderlab.se`, PASSWORD],
      [withoutPassword.email, PASSWORD],
    ] as const) {
      expect(await provider.signInWithPassword(email, password)).toEqual({
        ok: false,
        reason: "invalid_credentials",
      });
    }
    expect(cookies.get(DEV_SESSION_COOKIE)).toBeUndefined();
  });

  it("ger ingen session för förfalskad cookie eller raderad användare", async () => {
    const user = await createUser();
    await setPassword(user);
    const { provider, cookies } = devProvider();
    await provider.signInWithPassword(user.email, PASSWORD);
    const token = cookies.get(DEV_SESSION_COOKIE)!;

    const forged = new MemoryCookieJar();
    forged.set(DEV_SESSION_COOKIE, `${token.slice(0, -2)}xx`);
    expect(await devProvider(forged).provider.getSession()).toBeNull();

    await asPostgres((tx) => tx.execute(sql`delete from auth.users where id = ${user.id}`));
    expect(await provider.getSession()).toBeNull();
  });
});

describe("inloggningsflödet", () => {
  it("ger ett generiskt fel och begränsar försöken per IP och e-post", async () => {
    const user = await createUser();
    await setPassword(user);
    const { provider } = devProvider();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    const ctx = { provider, limiter, ip: "203.0.113.9" };

    expect(await loginFlow(ctx, { email: "", password: "" })).toEqual({
      ok: false,
      error: MESSAGES.loginMissing,
    });
    for (let i = 0; i < 3; i += 1) {
      expect(await loginFlow(ctx, { email: user.email, password: "fel lösenord" })).toEqual({
        ok: false,
        error: MESSAGES.loginInvalid,
      });
    }
    // Även rätt lösenord stoppas nu, men från en annan IP går det.
    const blocked = await loginFlow(ctx, { email: user.email, password: PASSWORD });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/För många inloggningsförsök/);
    expect(
      await loginFlow({ ...ctx, ip: "198.51.100.1" }, { email: user.email, password: PASSWORD }),
    ).toEqual({
      ok: true,
    });
  });

  it("utloggning tar bort sessionen och den aktiva organisationen", async () => {
    const user = await createUser();
    await setPassword(user);
    const { provider, cookies } = devProvider();
    await provider.signInWithPassword(user.email, PASSWORD);
    cookies.set(ACTIVE_ORG_COOKIE, crypto.randomUUID());
    expect(await logoutFlow({ provider, cookies })).toEqual({ ok: true });
    expect(cookies.getAll()).toEqual([]);
  });
});

describe("byte av eget lösenord", () => {
  it("dev-providern: rätt nuvarande lösenord byter, fel ger svenskt fel", async () => {
    const user = await createUser();
    await setPassword(user);
    const { provider } = devProvider();
    await provider.signInWithPassword(user.email, PASSWORD);
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    const ctx = { provider, user: session(user), limiter };
    const next = "ett nytt långt lösenord";

    expect(
      await changePasswordFlow(ctx, { current: "fel lösenord!!", next, confirm: next }),
    ).toEqual({ ok: false, error: MESSAGES.passwordWrong });
    expect(await changePasswordFlow(ctx, { current: PASSWORD, next, confirm: next })).toEqual({
      ok: true,
    });
    const fresh = devProvider().provider;
    expect((await fresh.signInWithPassword(user.email, PASSWORD)).ok).toBe(false);
    expect((await fresh.signInWithPassword(user.email, next)).ok).toBe(true);
  });
});

describe("inbjudningar", () => {
  it("ägaren bjuder in, ny användare väljer lösenord och blir medlem", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, "Inbjudande AB");
    const { provider } = devProvider();
    const invitee = `ny-${uniqueSuffix()}@test.binderlab.se`;

    expect(
      await createInviteFlow(
        { provider, user: session(owner), baseUrl: BASE_URL },
        { organizationId: org, email: invitee.toUpperCase(), role: "viewer" },
      ),
    ).toMatchObject({ ok: true });
    const { text, token } = await latestMailTo(invitee);
    expect(text).toContain(`${BASE_URL}/inbjudan/${token}`);
    expect(await describeInvitation(token)).toEqual({
      status: "valid",
      email: invitee,
      role: "viewer",
      organizationName: "Inbjudande AB",
      storeName: null,
    });

    const cookies = new MemoryCookieJar();
    const invited = devProvider(cookies);
    const ctx = { provider: invited.provider, user: null, cookies, secureCookies: false };
    expect(await acceptInviteFlow(ctx, { token })).toEqual({
      ok: false,
      error: MESSAGES.acceptPasswordNeeded,
    });
    expect((await acceptInviteFlow(ctx, { token, password: "kort" })).error).toMatch(/minst 12/);

    const accepted = await acceptInviteFlow(ctx, { token, password: PASSWORD });
    expect(accepted).toEqual({ ok: true, data: { organizationId: org } });
    expect(cookies.get(ACTIVE_ORG_COOKIE)).toBe(org);
    const me = await invited.provider.getSession();
    expect(me?.email).toBe(invitee);

    const membership = await asPostgres((tx) =>
      one<{ role: string }>(
        tx,
        sql`select m.role::text as role from public.memberships m
            where m.organization_id = ${org} and m.user_id = ${me!.userId}`,
      ),
    );
    expect(membership.role).toBe("viewer");

    // Länken fungerar bara en gång, och kontot kan logga in med lösenordet.
    expect(await acceptInviteFlow({ ...ctx, user: me }, { token })).toEqual({
      ok: false,
      error: "Inbjudan har redan använts.",
    });
    expect(await describeInvitation(token)).toEqual({ status: "accepted" });
    expect((await devProvider().provider.signInWithPassword(invitee, PASSWORD)).ok).toBe(true);
  });

  it("en befintlig användare måste logga in först, och e-posten måste stämma", async () => {
    const owner = await createUser();
    const org = await createOrg(owner);
    const existing = await createUser();
    await setPassword(existing);
    const { provider } = devProvider();
    await createInviteFlow(
      { provider, user: session(owner), baseUrl: BASE_URL },
      { organizationId: org, email: existing.email, role: "admin" },
    );
    const { token } = await latestMailTo(existing.email);

    const cookies = new MemoryCookieJar();
    const ctx = {
      provider: devProvider(cookies).provider,
      user: null,
      cookies,
      secureCookies: true,
    };
    expect(await acceptInviteFlow(ctx, { token, password: PASSWORD })).toEqual({
      ok: false,
      error: MESSAGES.acceptAccountExists,
    });

    const someoneElse = await createUser();
    expect(await acceptInviteFlow({ ...ctx, user: session(someoneElse) }, { token })).toEqual({
      ok: false,
      error: "Inbjudan gäller en annan e-postadress.",
    });

    expect(await acceptInviteFlow({ ...ctx, user: session(existing) }, { token })).toEqual({
      ok: true,
      data: { organizationId: org },
    });
    expect(cookies.optionsFor(ACTIVE_ORG_COOKIE)).toMatchObject({ httpOnly: true, secure: true });
  });

  it("bara ägare och admin kan bjuda in; admin kan inte bjuda in en ägare", async () => {
    const owner = await createUser();
    const org = await createOrg(owner);
    const { provider } = devProvider();
    const ctxFor = (user: TestUser) => ({ provider, user: session(user), baseUrl: BASE_URL });
    const input = (role: "owner" | "viewer") => ({
      organizationId: org,
      email: `x-${uniqueSuffix()}@test.binderlab.se`,
      role,
    });

    for (const role of ["viewer", "refiller"] as const) {
      const member = await createMember(org, role);
      expect(await createInviteFlow(ctxFor(member), input("viewer"))).toEqual({
        ok: false,
        error: MESSAGES.inviteForbidden,
      });
    }
    const outsider = await createUser();
    expect((await createInviteFlow(ctxFor(outsider), input("viewer"))).ok).toBe(false);
    expect(
      await createInviteFlow({ provider, user: null, baseUrl: BASE_URL }, input("viewer")),
    ).toEqual({
      ok: false,
      error: MESSAGES.notLoggedIn,
    });

    const admin = await createMember(org, "admin");
    expect(await createInviteFlow(ctxFor(admin), input("viewer"))).toMatchObject({ ok: true });
    expect(await createInviteFlow(ctxFor(admin), input("owner"))).toEqual({
      ok: false,
      error: "Du har inte behörighet till det här.",
    });
    expect(await createInviteFlow(ctxFor(owner), input("owner"))).toMatchObject({ ok: true });

    expect(
      await createInviteFlow(ctxFor(owner), {
        organizationId: org,
        email: "inte-en-adress",
        role: "viewer",
      }),
    ).toEqual({ ok: false, error: MESSAGES.inviteInvalidInput });
    expect(
      await createInviteFlow(ctxFor(owner), { ...input("viewer"), role: "superuser" }),
    ).toEqual({
      ok: false,
      error: MESSAGES.inviteInvalidInput,
    });
  });

  it("inbjudan sparas även om mejlet inte kan skickas, och kan skickas om", async () => {
    const owner = await createUser();
    const org = await createOrg(owner);
    const failing: AuthProvider = {
      ...devProvider().provider,
      kind: "dev",
      getSession: async () => null,
      signInWithPassword: async () => ({ ok: false, reason: "unavailable" }),
      signOut: async () => {},
      sendInvite: async () => {
        throw new Error("SMTP nere");
      },
    };
    const email = `rollback-${uniqueSuffix()}@test.binderlab.se`;
    expect(
      await createInviteFlow(
        { provider: failing, user: session(owner), baseUrl: BASE_URL },
        { organizationId: org, email, role: "viewer" },
      ),
    ).toEqual({ ok: true, data: { emailSent: false } });
    const count = await asPostgres((tx) =>
      one<{ n: number }>(
        tx,
        sql`select count(*)::int as n from public.invitations where organization_id = ${org} and email = ${email}`,
      ),
    );
    expect(count.n).toBe(1);
  });

  it("utgångna och okända inbjudningar ger tydliga fel", async () => {
    const owner = await createUser();
    const org = await createOrg(owner);
    const { provider } = devProvider();
    const email = `utgangen-${uniqueSuffix()}@test.binderlab.se`;
    await createInviteFlow(
      { provider, user: session(owner), baseUrl: BASE_URL },
      { organizationId: org, email, role: "viewer" },
    );
    const { token } = await latestMailTo(email);
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.invitations set expires_at = now() - interval '1 minute'
            where organization_id = ${org} and email = ${email}`,
      ),
    );
    const cookies = new MemoryCookieJar();
    const ctx = {
      provider: devProvider(cookies).provider,
      user: null,
      cookies,
      secureCookies: false,
    };
    expect(await acceptInviteFlow(ctx, { token, password: PASSWORD })).toEqual({
      ok: false,
      error: MESSAGES.invitationExpired,
    });
    expect(await describeInvitation(token)).toEqual({ status: "expired" });
    expect(await acceptInviteFlow(ctx, { token: "0".repeat(64), password: PASSWORD })).toEqual({
      ok: false,
      error: MESSAGES.invitationMissing,
    });
    expect(await acceptInviteFlow(ctx, { token: "../../etc" })).toEqual({
      ok: false,
      error: MESSAGES.invitationMissing,
    });
    // Inget konto skapades för en utgången inbjudan.
    const users = await asPostgres((tx) =>
      one<{ n: number }>(tx, sql`select count(*)::int as n from auth.users where email = ${email}`),
    );
    expect(users.n).toBe(0);
  });
});

describe("byte av organisation", () => {
  it("sätter cookien bara för organisationer där användaren är medlem", async () => {
    const user = await createUser();
    const mine = await createOrg(user);
    const other = await createOrg(await createUser());
    const cookies = new MemoryCookieJar();
    const ctx = { user: session(user), cookies, secureCookies: false };

    expect(await switchOrganizationFlow(ctx, mine)).toEqual({ ok: true });
    expect(cookies.get(ACTIVE_ORG_COOKIE)).toBe(mine);
    expect(await switchOrganizationFlow(ctx, other)).toEqual({
      ok: false,
      error: MESSAGES.notMember,
    });
    expect(await switchOrganizationFlow(ctx, "x")).toEqual({
      ok: false,
      error: MESSAGES.notMember,
    });
    expect(cookies.get(ACTIVE_ORG_COOKIE)).toBe(mine);
    expect(await switchOrganizationFlow({ ...ctx, user: null }, mine)).toEqual({
      ok: false,
      error: MESSAGES.notLoggedIn,
    });
  });
});

describe("lösenord som ägaren sätter vid inbjudan", () => {
  it("delägaren loggar in med lösenordet och går med på ett tryck, utan mejlet", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, "Delägarbolaget");
    const invitee = `delagare-${uniqueSuffix()}@test.binderlab.se`;
    const { provider } = devProvider();
    expect(
      await createInviteFlow(
        { provider, user: session(owner), baseUrl: BASE_URL },
        { organizationId: org, email: invitee, role: "admin", password: "delägarens lösenord" },
      ),
    ).toMatchObject({ ok: true });

    // Inloggning med lösenordet, i en ny webbläsare.
    const cookies = new MemoryCookieJar();
    const invited = devProvider(cookies);
    const login = await invited.provider.signInWithPassword(invitee, "delägarens lösenord");
    expect(login.ok).toBe(true);
    const user = login.ok ? login.session : null;

    const mine = await myInvitationsFlow(user);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ organizationName: "Delägarbolaget", role: "admin" });
    expect(Object.keys(mine[0]!).sort()).toEqual(
      ["expiresAt", "id", "organizationName", "role", "storeName"].sort(),
    );

    const accepted = await acceptMyInvitationFlow(
      { user, cookies, secureCookies: false },
      mine[0]!.id,
    );
    expect(accepted).toEqual({ ok: true, data: { organizationId: org } });
    expect(cookies.get(ACTIVE_ORG_COOKIE)).toBe(org);
    const member = await one<{ role: string }>(
      getServiceDb(),
      sql`select role::text as role from public.memberships
          where organization_id = ${org} and user_id = ${user!.userId}`,
    );
    expect(member.role).toBe("admin");
    // Inbjudan är använd: syns inte längre och kan inte tas emot igen.
    expect(await myInvitationsFlow(user)).toEqual([]);
    expect(
      await acceptMyInvitationFlow({ user, cookies, secureCookies: false }, mine[0]!.id),
    ).toEqual({ ok: false, error: "Inbjudan har redan använts." });
  });

  it("ett befintligt konto får aldrig nytt lösenord, och ingen inbjudan skapas", async () => {
    const owner = await createUser();
    const org = await createOrg(owner);
    const existing = await createUser();
    await setPassword(existing, "existerande lösenord");
    const { provider } = devProvider();
    expect(
      await createInviteFlow(
        { provider, user: session(owner), baseUrl: BASE_URL },
        {
          organizationId: org,
          email: existing.email,
          role: "viewer",
          password: "kapat lösenord!!",
        },
      ),
    ).toEqual({ ok: false, error: MESSAGES.inviteAccountExists });
    expect((await provider.signInWithPassword(existing.email, "existerande lösenord")).ok).toBe(
      true,
    );
    const count = await one<{ n: number }>(
      getServiceDb(),
      sql`select count(*)::int as n from public.invitations where organization_id = ${org}`,
    );
    expect(count.n).toBe(0);
  });

  it("för kort lösenord avvisas innan kontot skapas", async () => {
    const owner = await createUser();
    const org = await createOrg(owner);
    const email = `kort-${uniqueSuffix()}@test.binderlab.se`;
    const { provider } = devProvider();
    const result = await createInviteFlow(
      { provider, user: session(owner), baseUrl: BASE_URL },
      { organizationId: org, email, role: "viewer", password: "kort" },
    );
    expect(result.ok).toBe(false);
    const users = await one<{ n: number }>(
      getServiceDb(),
      sql`select count(*)::int as n from auth.users where lower(email::text) = ${email}`,
    );
    expect(users.n).toBe(0);
  });

  it("my_invitations och accept_my_invitation visar och tar bara egna inbjudningar", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, "Annans bolag");
    const anna = await createUser();
    const eve = await createUser();
    const { provider } = devProvider();
    await createInviteFlow(
      { provider, user: session(owner), baseUrl: BASE_URL },
      { organizationId: org, email: anna.email, role: "viewer" },
    );
    const annas = await myInvitationsFlow(session(anna));
    expect(annas).toHaveLength(1);
    expect(await myInvitationsFlow(session(eve))).toEqual([]);
    // Eve kan inte ta Annas inbjudan med id:t: samma svar som för en okänd.
    expect(
      await acceptMyInvitationFlow(
        { user: session(eve), cookies: new MemoryCookieJar(), secureCookies: false },
        annas[0]!.id,
      ),
    ).toEqual({ ok: false, error: "Inbjudan finns inte." });
    // Utgången inbjudan syns inte och kan inte tas emot.
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.invitations set expires_at = now() - interval '1 minute' where id = ${annas[0]!.id}`,
      ),
    );
    expect(await myInvitationsFlow(session(anna))).toEqual([]);
    expect(
      await acceptMyInvitationFlow(
        { user: session(anna), cookies: new MemoryCookieJar(), secureCookies: false },
        annas[0]!.id,
      ),
    ).toEqual({ ok: false, error: "Inbjudan har gått ut." });
  });
});
