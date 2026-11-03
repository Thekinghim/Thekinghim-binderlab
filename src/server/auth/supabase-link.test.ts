/**
 * Inloggning med länk (Supabase) mot en falsk Supabase Auth: länken ska fungera
 * när den öppnas i en ANNAN webbläsare eller app än den som begärde den (Mail-appen,
 * hemskärmen). Den gamla PKCE-länken (?code=) kräver verifieraren i samma
 * webbläsares cookies och misslyckas där; det implicita flödet (sessionen i
 * fragmentet) fungerar i en helt ny cookieburk. Inget nätverk.
 */

import { createLocalJWKSet } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import { parseLinkFragment } from "@/app/logga-in/link-fragment";

import { SupabaseAuthProvider } from "./supabase-provider";
import { createFakeGoTrue, type FakeGoTrue } from "./testing/fake-gotrue";
import { MemoryCookieJar } from "./types";

const APP = "https://app.binderlab.test";

let gotrue: FakeGoTrue;

function provider(cookies = new MemoryCookieJar()) {
  return {
    cookies,
    provider: new SupabaseAuthProvider({
      env: {
        SUPABASE_URL: gotrue.supabaseUrl,
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        SUPABASE_SECRET_KEY: "sb_secret_test",
        SUPABASE_JWKS_URL: `${gotrue.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      },
      cookies,
      jwks: createLocalJWKSet(gotrue.jwks),
      secureCookies: true,
      fetch: gotrue.fetch,
    }),
  };
}

function fragmentTokens(location: string) {
  const parsed = parseLinkFragment(new URL(location).hash);
  if (parsed.kind !== "tokens") throw new Error(`Inga tokens i ${location}`);
  return parsed;
}

beforeEach(async () => {
  gotrue = await createFakeGoTrue("http://127.0.0.1:54399");
});

describe("inloggningslänk i en annan webbläsare", () => {
  it("begärs utan PKCE och loggar in i en ny cookieburk utan verifierare", async () => {
    const anna = gotrue.addUser("anna@example.se");
    // Webbläsare A (hemskärmsappen) begär länken.
    const a = provider();
    expect(await a.provider.signInWithMagicLink(anna.email, `${APP}/logga-in/bekrafta`)).toEqual({
      ok: true,
    });
    const request = gotrue.requests.at(-1)!;
    expect(request.path).toBe("/otp");
    expect(request.body.code_challenge ?? null).toBeNull();
    expect([...a.cookies.values.keys()].some((k) => k.includes("code-verifier"))).toBe(false);

    // Webbläsare B (Mail-appen): helt nya cookies.
    const location = await gotrue.open(gotrue.mail.at(-1)!.link);
    expect(location.startsWith(`${APP}/logga-in/bekrafta#`)).toBe(true);
    const tokens = fragmentTokens(location);
    expect(tokens.type).toBe("magiclink");
    expect(tokens.email).toBe(anna.email);

    const b = provider();
    const session = await b.provider.completeTokenLink!(tokens);
    expect(session).toEqual({ userId: anna.id, email: anna.email });
    // Sessionen ligger i B:s cookies och läses tillbaka (verifieras lokalt).
    expect(b.cookies.values.size).toBeGreaterThan(0);
    expect(await provider(b.cookies).provider.getSession()).toEqual(session);
  });

  it("PKCE-länken (gamla buggen) går inte att använda utan verifieraren", async () => {
    // Så som @supabase/ssr begärde länken förut: med code_challenge.
    const anna = gotrue.addUser("anna@example.se");
    const challenge = "x".repeat(43);
    await gotrue.handle(
      new Request(`${gotrue.supabaseUrl}/auth/v1/otp?redirect_to=${APP}/logga-in/bekrafta`, {
        method: "POST",
        body: JSON.stringify({ email: anna.email, code_challenge: challenge }),
      }),
    );
    const location = await gotrue.open(gotrue.mail.at(-1)!.link);
    const code = new URL(location).searchParams.get("code");
    expect(code).toBeTruthy();
    const fresh = provider();
    expect(await fresh.provider.completeCodeLink!(code!)).toBeNull();
  });

  it("en använd eller förfalskad länk ger ingen session", async () => {
    const anna = gotrue.addUser("anna@example.se");
    const p = provider();
    await p.provider.signInWithMagicLink(anna.email, `${APP}/logga-in/bekrafta`);
    const link = gotrue.mail.at(-1)!.link;
    await gotrue.open(link);
    // Andra öppningen: Supabase svarar med fel i fragmentet.
    const again = await gotrue.open(link);
    expect(parseLinkFragment(new URL(again).hash)).toEqual({
      kind: "error",
      code: "otp_expired",
    });
    // Token signerad med en annan nyckel avvisas lokalt, innan något sparas.
    const other = await createFakeGoTrue("http://127.0.0.1:54399");
    const eve = other.addUser("eve@example.se");
    await other.handle(
      new Request(`${other.supabaseUrl}/auth/v1/otp?redirect_to=${APP}`, {
        method: "POST",
        body: JSON.stringify({ email: eve.email }),
      }),
    );
    const forged = fragmentTokens(await other.open(other.mail.at(-1)!.link));
    const target = provider();
    expect(await target.provider.completeTokenLink!(forged)).toBeNull();
    expect(target.cookies.values.size).toBe(0);
  });
});

describe("glömt lösenord", () => {
  it("länken begärs utan PKCE och nytt lösenord sätts i en ny webbläsare", async () => {
    const anna = gotrue.addUser("anna@example.se", "gammalt lösenord!!");
    await provider().provider.sendPasswordReset!(anna.email, `${APP}/logga-in/nytt-losenord`);
    expect(gotrue.requests.at(-1)).toMatchObject({ path: "/recover" });
    expect(gotrue.requests.at(-1)!.body.code_challenge ?? null).toBeNull();
    const tokens = fragmentTokens(await gotrue.open(gotrue.mail.at(-1)!.link));
    expect(tokens.type).toBe("recovery");

    const b = provider();
    expect(await b.provider.completeTokenLink!(tokens)).toEqual({
      userId: anna.id,
      email: anna.email,
    });
    await b.provider.setPassword("ett nytt långt lösenord");
    expect(gotrue.users.get(anna.id)!.password).toBe("ett nytt långt lösenord");
    const login = await provider().provider.signInWithPassword(
      anna.email,
      "ett nytt långt lösenord",
    );
    expect(login.ok).toBe(true);
  });
});

describe("konto med lösenord som ägaren sätter", () => {
  it("skapar kontot, och ett befintligt konto ändras aldrig", async () => {
    const p = provider().provider;
    expect(await p.createAccountWithPassword!("delagare@example.se", "delägarens lösenord")).toBe(
      "created",
    );
    expect((await p.signInWithPassword("delagare@example.se", "delägarens lösenord")).ok).toBe(
      true,
    );
    const existing = gotrue.addUser("anna@example.se", "annas eget lösenord");
    expect(await p.createAccountWithPassword!(existing.email, "kapat lösenord!!")).toBe("exists");
    expect(gotrue.users.get(existing.id)!.password).toBe("annas eget lösenord");
  });

  it("inbjudan till ett konto som redan finns skickar en implicit länk", async () => {
    gotrue.addUser("anna@example.se", "annas eget lösenord");
    await provider().provider.sendInvite("anna@example.se", `${APP}/inbjudan/abc`);
    expect(gotrue.requests.at(-1)).toMatchObject({ path: "/otp" });
    expect(gotrue.requests.at(-1)!.body.code_challenge ?? null).toBeNull();
    const location = await gotrue.open(gotrue.mail.at(-1)!.link);
    expect(location.startsWith(`${APP}/inbjudan/abc#access_token=`)).toBe(true);
  });
});
