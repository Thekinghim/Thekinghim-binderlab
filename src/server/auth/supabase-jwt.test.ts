import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createSupabaseJwtVerifier, supabaseIssuer } from "./supabase-jwt";

const SUPABASE_URL = "https://ukuuwokxbtwhqfnttzwr.supabase.co";
const ISSUER = supabaseIssuer(SUPABASE_URL);
const USER = "0f0e0d0c-0b0a-4908-8706-050403020100";

let es256: { privateKey: CryptoKey; kid: string };
let rs256: { privateKey: CryptoKey; kid: string };
let stranger: { privateKey: CryptoKey; kid: string };
let jwks: JSONWebKeySet;

async function keyPair(alg: "ES256" | "RS256", kid: string) {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { privateKey, kid, jwk };
}

beforeAll(async () => {
  const a = await keyPair("ES256", "es-1");
  const b = await keyPair("RS256", "rs-1");
  const c = await keyPair("ES256", "es-1"); // samma kid, annan nyckel
  es256 = a;
  rs256 = b;
  stranger = c;
  jwks = { keys: [a.jwk, b.jwk] };
});

function token(
  claims: JWTPayload & Record<string, unknown>,
  options: {
    key?: { privateKey: CryptoKey; kid: string };
    alg?: string;
    issuer?: string;
    audience?: string;
    exp?: number | string;
  } = {},
) {
  const key = options.key ?? es256;
  return new SignJWT({ email: "anna@example.se", role: "authenticated", ...claims })
    .setProtectedHeader({ alg: options.alg ?? "ES256", kid: key.kid })
    .setSubject(typeof claims.sub === "string" ? claims.sub : USER)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(options.exp ?? "1h")
    .sign(key.privateKey);
}

function verifier() {
  return createSupabaseJwtVerifier({ supabaseUrl: SUPABASE_URL, jwks: createLocalJWKSet(jwks) });
}

describe("Supabase-JWT mot lokal JWKS", () => {
  it("godtar en giltig ES256- och RS256-token", async () => {
    const verify = verifier();
    expect(await verify(await token({}))).toEqual({
      ok: true,
      session: { userId: USER, email: "anna@example.se" },
    });
    expect((await verify(await token({}, { key: rs256, alg: "RS256" }))).ok).toBe(true);
  });

  it("nekar fel issuer", async () => {
    const verify = verifier();
    for (const issuer of [
      "https://annat-projekt.supabase.co/auth/v1",
      SUPABASE_URL,
      `${ISSUER}/`,
    ]) {
      expect(await verify(await token({}, { issuer }))).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("nekar fel audience", async () => {
    const verify = verifier();
    expect(await verify(await token({}, { audience: "anon" }))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("nekar en utgången token", async () => {
    const verify = verifier();
    const exp = Math.floor(Date.now() / 1000) - 60;
    expect(await verify(await token({}, { exp }))).toEqual({ ok: false, reason: "expired" });
    // Med en klocka före utgången godtas samma token.
    const t = await token({}, { exp });
    expect((await verify(t, { now: new Date((exp - 30) * 1000) })).ok).toBe(true);
  });

  it("nekar en token signerad med en annan nyckel (samma kid)", async () => {
    const verify = verifier();
    expect((await verify(await token({}, { key: stranger }))).ok).toBe(false);
  });

  it("nekar HS256 (algoritmförväxling) och osignerade token", async () => {
    const verify = verifier();
    const hs = await new SignJWT({ email: "anna@example.se", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", kid: "es-1" })
      .setSubject(USER)
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("x".repeat(64)));
    expect((await verify(hs)).ok).toBe(false);
    const [h, p] = (await token({})).split(".");
    expect((await verify(`${h}.${p}.`)).ok).toBe(false);
  });

  it("nekar anonyma användare, fel roll, saknad e-post och sub som inte är uuid", async () => {
    const verify = verifier();
    expect((await verify(await token({ is_anonymous: true }))).ok).toBe(false);
    expect((await verify(await token({ role: "service_role" }))).ok).toBe(false);
    expect((await verify(await token({ email: undefined }))).ok).toBe(false);
    expect((await verify(await token({ sub: "inte-ett-uuid" }))).ok).toBe(false);
  });
});
