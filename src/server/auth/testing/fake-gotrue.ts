/**
 * En falsk Supabase Auth (GoTrue) för tester: ingen kontakt med Supabase.
 *
 * Svarar på de anrop supabase-js gör för länkinloggning, nytt lösenord,
 * inbjudan, lösenord och sessioner, med ES256-signerade åtkomsttoken och en
 * JWKS som SupabaseAuthProvider kan verifiera mot. Mejlen "skickas" till
 * `mail` (länken till /auth/v1/verify), och `open(link)` gör det en
 * webbläsare gör när man trycker på länken: följer Supabases omdirigering.
 *
 * Beteendet följer GoTrue: begärs länken med PKCE (code_challenge) landar den
 * med `?code=` och kräver verifieraren; utan PKCE (implicit flöde) landar den
 * med sessionen i fragmentet. En länk gäller en gång.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet } from "jose";

export interface FakeUser {
  id: string;
  email: string;
  password: string | null;
}

export interface FakeMail {
  to: string;
  type: "magiclink" | "recovery" | "invite";
  link: string;
}

interface PendingLink {
  userId: string;
  type: FakeMail["type"];
  redirectTo: string;
  codeChallenge: string | null;
  used: boolean;
}

export interface FakeGoTrue {
  readonly supabaseUrl: string;
  readonly jwks: JSONWebKeySet;
  readonly users: Map<string, FakeUser>;
  readonly mail: FakeMail[];
  /** Senaste anropet till /otp, /recover eller /invite (för att se PKCE eller inte). */
  readonly requests: { path: string; body: Record<string, unknown> }[];
  addUser(email: string, password?: string | null, id?: string): FakeUser;
  handle(request: Request): Promise<Response>;
  /** fetch som går till den falska tjänsten (för SupabaseAuthProvider i tester). */
  fetch: typeof fetch;
  /** Det webbläsaren gör med länken i mejlet: Supabases omdirigering (Location). */
  open(link: string): Promise<string>;
  /** Som HTTP-server (för Playwright mot en dev-server). */
  listen(port: number): Promise<Server>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, msg: string): Response {
  return json({ code: status, error_code: code, msg }, status);
}

function token(): string {
  return randomBytes(24).toString("base64url");
}

export async function createFakeGoTrue(
  supabaseUrl = "http://127.0.0.1:54399",
  options: {
    /** Id för konton som skapas av tjänsten (t.ex. samma som i en lokal auth.users). */
    idForEmail?: (email: string) => string | undefined;
  } = {},
): Promise<FakeGoTrue> {
  const base = supabaseUrl.replace(/\/+$/, "");
  const issuer = `${base}/auth/v1`;
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = "fake-es256";
  const jwks: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }],
  };
  const users = new Map<string, FakeUser>();
  const mail: FakeMail[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const links = new Map<string, PendingLink>();
  const codes = new Map<string, { userId: string; challenge: string; used: boolean }>();
  const refreshTokens = new Map<string, string>();

  const byEmail = (email: string) =>
    [...users.values()].find((u) => u.email.toLowerCase() === email.trim().toLowerCase());

  const addUser = (
    email: string,
    password: string | null = null,
    id = options.idForEmail?.(email.trim().toLowerCase()) ?? randomUUID(),
  ) => {
    const user = { id, email: email.trim().toLowerCase(), password };
    users.set(id, user);
    return user;
  };

  const userJson = (u: FakeUser) => ({
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: "2026-11-01T00:00:00Z",
  });

  const accessToken = (u: FakeUser, key: CryptoKey = privateKey) =>
    new SignJWT({ email: u.email, role: "authenticated", is_anonymous: false })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject(u.id)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);

  const session = async (u: FakeUser) => {
    const refresh = token();
    refreshTokens.set(refresh, u.id);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return {
      access_token: await accessToken(u),
      token_type: "bearer",
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token: refresh,
      user: userJson(u),
    };
  };

  const userFromBearer = async (request: Request): Promise<FakeUser | undefined> => {
    const auth = request.headers.get("authorization") ?? "";
    const jwt = auth.replace(/^Bearer\s+/i, "");
    const payload = jwt.split(".")[1];
    if (!payload) return undefined;
    try {
      const { sub } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        sub?: string;
      };
      return sub ? users.get(sub) : undefined;
    } catch {
      return undefined;
    }
  };

  const sendLink = (
    u: FakeUser,
    type: FakeMail["type"],
    redirectTo: string,
    challenge: unknown,
  ) => {
    const t = token();
    links.set(t, {
      userId: u.id,
      type,
      redirectTo,
      codeChallenge: typeof challenge === "string" && challenge !== "" ? challenge : null,
      used: false,
    });
    const link = `${issuer}/verify?token=${t}&type=${type}&redirect_to=${encodeURIComponent(redirectTo)}`;
    mail.push({ to: u.email, type, link });
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/auth\/v1/, "");
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? {}
        : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const redirectTo = url.searchParams.get("redirect_to") ?? base;

    if (path === "/.well-known/jwks.json") return json(jwks);
    // Bara för tester: brevlådan (vad som "skickats").
    if (request.method === "GET" && url.pathname === "/__mail") return json(mail);

    if (request.method === "POST" && (path === "/otp" || path === "/recover")) {
      requests.push({ path, body });
      const u = byEmail(String(body.email ?? ""));
      // Okänd adress: samma svar (shouldCreateUser: false).
      if (u)
        sendLink(u, path === "/otp" ? "magiclink" : "recovery", redirectTo, body.code_challenge);
      return json({});
    }

    if (request.method === "POST" && path === "/invite") {
      requests.push({ path, body });
      const email = String(body.email ?? "");
      if (byEmail(email)) return fail(422, "email_exists", "A user with this email already exists");
      const u = addUser(email);
      sendLink(u, "invite", redirectTo, null);
      return json(userJson(u));
    }

    if (request.method === "POST" && path === "/admin/users") {
      const email = String(body.email ?? "");
      if (byEmail(email)) return fail(422, "email_exists", "A user with this email already exists");
      const password = typeof body.password === "string" ? body.password : null;
      return json(userJson(addUser(email, password)));
    }

    if (request.method === "GET" && path === "/verify") {
      const pending = links.get(url.searchParams.get("token") ?? "");
      const target = pending?.redirectTo ?? redirectTo;
      if (!pending || pending.used) {
        return new Response(null, {
          status: 303,
          headers: {
            location: `${target}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`,
          },
        });
      }
      pending.used = true;
      const u = users.get(pending.userId)!;
      if (pending.codeChallenge) {
        const code = randomUUID();
        codes.set(code, { userId: u.id, challenge: pending.codeChallenge, used: false });
        const sep = target.includes("?") ? "&" : "?";
        return new Response(null, {
          status: 303,
          headers: { location: `${target}${sep}code=${code}` },
        });
      }
      const s = await session(u);
      const fragment = new URLSearchParams({
        access_token: s.access_token,
        expires_at: String(s.expires_at),
        expires_in: String(s.expires_in),
        refresh_token: s.refresh_token,
        token_type: "bearer",
        type: pending.type,
      });
      return new Response(null, { status: 303, headers: { location: `${target}#${fragment}` } });
    }

    if (request.method === "POST" && path === "/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const u = byEmail(String(body.email ?? ""));
        if (!u || u.password === null || u.password !== body.password) {
          return fail(400, "invalid_credentials", "Invalid login credentials");
        }
        return json(await session(u));
      }
      if (grant === "refresh_token") {
        const userId = refreshTokens.get(String(body.refresh_token ?? ""));
        if (!userId) return fail(400, "refresh_token_not_found", "Invalid Refresh Token");
        refreshTokens.delete(String(body.refresh_token));
        return json(await session(users.get(userId)!));
      }
      if (grant === "pkce") {
        const entry = codes.get(String(body.auth_code ?? ""));
        const verifier = String(body.code_verifier ?? "");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!entry || entry.used || verifier === "" || challenge !== entry.challenge) {
          return fail(
            400,
            "bad_code_verifier",
            "code challenge does not match previously saved code verifier",
          );
        }
        entry.used = true;
        return json(await session(users.get(entry.userId)!));
      }
      return fail(400, "unsupported_grant_type", "Unsupported grant type");
    }

    if (path === "/user") {
      const u = await userFromBearer(request);
      if (!u) return fail(401, "bad_jwt", "invalid JWT");
      if (request.method === "PUT") {
        if (typeof body.password === "string") u.password = body.password;
      }
      return json(userJson(u));
    }

    if (request.method === "POST" && path === "/logout") return new Response(null, { status: 204 });

    return fail(404, "not_found", `Fake GoTrue: ${request.method} ${path}`);
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handle(new Request(input, init))) as typeof fetch;

  return {
    supabaseUrl: base,
    jwks,
    users,
    mail,
    requests,
    addUser,
    handle,
    fetch: fakeFetch,
    async open(link: string) {
      const response = await handle(new Request(link));
      return response.headers.get("location") ?? "";
    },
    listen(port: number) {
      return new Promise<Server>((resolve) => {
        const server = createServer(async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string") headers.set(k, v);
          }
          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const response = await handle(
            new Request(`${base}${req.url ?? "/"}`, {
              method: req.method,
              headers,
              body: hasBody ? Buffer.concat(chunks) : undefined,
            }),
          );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        });
        server.listen(port, "127.0.0.1", () => resolve(server));
      });
    },
  };
}
