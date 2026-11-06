/**
 * Ett minnesbaserat Supabase Management API, Supabase-projekt (Auth,
 * Storage, JWKS) och Vercel REST API för testerna av scripts/deploy. Bara
 * det som skripten använder finns med, med samma former som de riktiga
 * API:erna (enligt deras dokumentation). Varje anrop loggas i `calls`.
 */

import { randomBytes } from "node:crypto";

import { md5 } from "../../scripts/deploy/lib/supabase";

export interface Call {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface SbProject {
  id: string;
  name: string;
  organization_id: string;
  region: string;
  status: string;
  /** Antal GET innan ett nytt projekt blir ACTIVE_HEALTHY. */
  bootPolls: number;
}

export interface EnvRow {
  id: string;
  key: string;
  value: string;
  type: string;
  target: string[];
  gitBranch?: string | null;
}

export interface FakeState {
  supabase: {
    projects: SbProject[];
    apiKeys: Record<string, { id: string; name: string; type: string; api_key: string }[]>;
    auth: Record<string, Record<string, unknown>>;
    signingKeys: Record<string, { id: string; algorithm: string; status: string }[]>;
    migrations: Record<string, Map<string, { name: string; sql: string }>>;
    passwordVerifiers: Record<string, string>;
    buckets: Record<string, { id: string; public: boolean }[]>;
    users: Record<string, { id: string; email: string; email_confirmed_at: string | null }[]>;
    dbPasswords: Record<string, string>;
    /** Supabase Vault per projekt: namn → värde. */
    vault: Record<string, Record<string, string>>;
    /**
     * pg_cron/pg_net och jobbet per projekt: true (påslagna, jobbet finns var femte
     * minut; standard), "old" (jobbet finns med det äldre schemat var tionde minut),
     * "nojob" (påslagna men jobbet saknas) eller false (inte påslagna).
     */
    awishCron?: Record<string, boolean | "nojob" | "old">;
    /** Jobb som schemalagts via deploy (namn). */
    cronScheduled?: Record<string, string[]>;
    /** Gör att signing-keys-API:t svarar 404 (äldre API). */
    noSigningKeysApi?: boolean;
  };
  vercel: {
    teams: { id: string; slug: string; billing?: { plan: string } }[];
    username: string;
    projects: {
      id: string;
      name: string;
      teamId: string;
      serverlessFunctionRegion: string | null;
      link: {
        type: string;
        org: string;
        repo: string;
        repoId: number;
        productionBranch: string;
      } | null;
    }[];
    envs: Record<string, EnvRow[]>;
    deployments: {
      id: string;
      projectId: string;
      target: string;
      readyState: string;
      polls: number;
      url: string;
      createdAt: number;
    }[];
    domains: Record<string, { name: string; verified: boolean; redirect: null; gitBranch: null }[]>;
    /** Svar för /logga-in per värd: "ok" | "not-configured". */
    site?: "ok" | "not-configured";
  };
  calls: Call[];
  seq: number;
}

export const DEV_REF = "ukuuwokxbtwhqfnttzwr";
export const ORG = "org-binderlab";
export const TEAM = { id: "team_abc123", slug: "thekinghim" };

export function secretKeyFor(ref: string): string {
  return `sb_secret_${ref}_SECRETVALUE1234567890`;
}
export function publishableKeyFor(ref: string): string {
  return `sb_publishable_${ref}_PUBLIC1234567890`;
}

export function initialState(): FakeState {
  return {
    supabase: {
      projects: [
        {
          id: DEV_REF,
          name: "binderlab",
          organization_id: ORG,
          region: "eu-north-1",
          status: "ACTIVE_HEALTHY",
          bootPolls: 0,
        },
      ],
      apiKeys: {
        [DEV_REF]: [
          {
            id: "k1",
            name: "anon",
            type: "legacy",
            api_key: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.x",
          },
          { id: "k2", name: "default", type: "publishable", api_key: publishableKeyFor(DEV_REF) },
          { id: "k3", name: "default", type: "secret", api_key: secretKeyFor(DEV_REF) },
        ],
      },
      auth: {
        [DEV_REF]: {
          site_url: "http://localhost:3000",
          uri_allow_list: "",
          disable_signup: false,
          mailer_autoconfirm: false,
        },
      },
      signingKeys: { [DEV_REF]: [{ id: "legacy", algorithm: "HS256", status: "in_use" }] },
      migrations: {},
      passwordVerifiers: {},
      buckets: { [DEV_REF]: [] },
      users: { [DEV_REF]: [] },
      dbPasswords: {},
      vault: {},
    },
    vercel: {
      teams: [{ ...TEAM, billing: { plan: "pro" } }],
      username: "thekinghim",
      projects: [],
      envs: {},
      deployments: [],
      domains: {},
    },
    calls: [],
    seq: 0,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function publicProject(p: SbProject): Omit<SbProject, "bootPolls"> {
  return {
    id: p.id,
    name: p.name,
    organization_id: p.organization_id,
    region: p.region,
    status: p.status,
  };
}

const BOOKKEEPING = /create table if not exists supabase_migrations\.schema_migrations/;

export function createFakeFetch(state: FakeState) {
  const next = (prefix: string) => `${prefix}${++state.seq}`;

  async function handle(
    method: string,
    url: URL,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    const host = url.host;
    const p = url.pathname;
    let m: RegExpExecArray | null;
    const sb = state.supabase;
    const vc = state.vercel;

    // ---------------- Supabase Management API ----------------
    if (host === "api.supabase.com") {
      if (headers.authorization !== "Bearer sbp_testtoken_0123456789abcdef0123")
        return json(401, { message: "Unauthorized" });
      if (method === "GET" && p === "/v1/projects") {
        return json(200, sb.projects.map(publicProject));
      }
      if (method === "POST" && p === "/v1/projects") {
        const b = body as Record<string, string>;
        const ref = `prod${String(++state.seq).padStart(16, "x")}`;
        sb.projects.push({
          id: ref,
          name: b.name!,
          organization_id: b.organization_id!,
          region: b.region!,
          status: "COMING_UP",
          bootPolls: 2,
        });
        sb.dbPasswords[ref] = b.db_pass!;
        sb.apiKeys[ref] = [
          { id: next("k"), name: "default", type: "publishable", api_key: publishableKeyFor(ref) },
          { id: next("k"), name: "default", type: "secret", api_key: secretKeyFor(ref) },
        ];
        sb.auth[ref] = {
          site_url: "http://localhost:3000",
          uri_allow_list: "",
          disable_signup: false,
          mailer_autoconfirm: true,
        };
        sb.signingKeys[ref] = [{ id: next("sk"), algorithm: "ES256", status: "in_use" }];
        sb.buckets[ref] = [];
        sb.users[ref] = [];
        return json(201, {
          id: ref,
          name: b.name,
          organization_id: b.organization_id,
          region: b.region,
          status: "COMING_UP",
        });
      }
      if ((m = /^\/v1\/projects\/([a-z0-9]+)$/.exec(p)) && method === "GET") {
        const proj = sb.projects.find((x) => x.id === m![1]);
        if (!proj) return json(404, { message: "Project not found" });
        if (proj.status === "COMING_UP") {
          if (proj.bootPolls <= 0) proj.status = "ACTIVE_HEALTHY";
          else proj.bootPolls -= 1;
        }
        return json(200, publicProject(proj));
      }
      if ((m = /^\/v1\/projects\/([a-z0-9]+)\/health$/.exec(p))) {
        return json(
          200,
          url.searchParams
            .getAll("services")
            .map((name) => ({ name, healthy: true, status: "ACTIVE_HEALTHY" })),
        );
      }
      if ((m = /^\/v1\/projects\/([a-z0-9]+)\/api-keys$/.exec(p))) {
        const ref = m[1]!;
        if (method === "GET") {
          const reveal = url.searchParams.get("reveal") === "true";
          return json(
            200,
            (sb.apiKeys[ref] ?? []).map((k) => ({
              ...k,
              api_key: k.type === "secret" && !reveal ? `${k.api_key.slice(0, 12)}••••` : k.api_key,
            })),
          );
        }
        if (method === "POST") {
          const b = body as { type: string; name: string };
          const key = {
            id: next("k"),
            name: b.name,
            type: b.type,
            api_key: b.type === "secret" ? secretKeyFor(ref) : publishableKeyFor(ref),
          };
          (sb.apiKeys[ref] ??= []).push(key);
          return json(201, { ...key, api_key: null });
        }
      }
      if ((m = /^\/v1\/projects\/([a-z0-9]+)\/config\/database\/pooler$/.exec(p))) {
        const ref = m[1]!;
        return json(200, [
          {
            database_type: "PRIMARY",
            db_host: "aws-1-eu-north-1.pooler.supabase.com",
            db_port: 5432,
            db_user: `postgres.${ref}`,
            db_name: "postgres",
            pool_mode: "transaction",
          },
        ]);
      }
      if ((m = /^\/v1\/projects\/([a-z0-9]+)\/config\/auth$/.exec(p))) {
        const ref = m[1]!;
        if (method === "GET") {
          const visible = { ...sb.auth[ref] };
          visible.smtp_pass = visible.smtp_pass ? "********" : null;
          return json(200, visible);
        }
        if (method === "PATCH") {
          sb.auth[ref] = { ...sb.auth[ref], ...(body as Record<string, unknown>) };
          return json(200, sb.auth[ref]);
        }
      }
      if (
        (m =
          /^\/v1\/projects\/([a-z0-9]+)\/config\/auth\/signing-keys(?:\/(legacy|[a-z0-9]+))?$/.exec(
            p,
          ))
      ) {
        if (sb.noSigningKeysApi) return json(404, { message: "Not Found" });
        const ref = m[1]!;
        const keys = (sb.signingKeys[ref] ??= []);
        if (method === "GET" && !m[2]) return json(200, { keys });
        if (method === "POST" && m[2] === "legacy") {
          if (keys.length === 0)
            keys.push({ id: next("sk"), algorithm: "HS256", status: "in_use" });
          return json(201, keys[0]);
        }
        if (method === "POST" && !m[2]) {
          const b = body as { algorithm: string; status: string };
          const key = { id: next("sk"), algorithm: b.algorithm, status: b.status };
          keys.push(key);
          return json(201, key);
        }
        if (method === "PATCH" && m[2]) {
          const key = keys.find((k) => k.id === m![2]);
          if (!key) return json(404, { message: "no key" });
          for (const k of keys) if (k.status === "in_use") k.status = "previously_used";
          key.status = (body as { status: string }).status;
          return json(200, key);
        }
      }
      if ((m = /^\/v1\/projects\/([a-z0-9]+)\/database\/query$/.exec(p)) && method === "POST") {
        const ref = m[1]!;
        const query = (body as { query: string }).query;
        const hadTable = sb.migrations[ref] !== undefined;
        const done = (sb.migrations[ref] ??= new Map());
        const unq = (v: string) => v.replace(/''/g, "'");
        const vault = (sb.vault[ref] ??= {});
        if (/binderlab:vault-read \*\//.test(query)) {
          const name = /name = '((?:[^']|'')*)';$/.exec(query)?.[1];
          const value = name === undefined ? undefined : vault[unq(name)];
          return json(201, value === undefined ? [] : [{ value }]);
        }
        if (/binderlab:vault-write \*\/ vault\.create_secret/.test(query)) {
          const v = /create_secret\('((?:[^']|'')*)', '((?:[^']|'')*)', '(?:[^']|'')*'\);$/.exec(
            query,
          );
          if (!v) return json(400, { message: "syntax error" });
          if (vault[unq(v[2]!)] !== undefined)
            return json(400, { message: "duplicate key value violates unique constraint" });
          vault[unq(v[2]!)] = unq(v[1]!);
          return json(201, [{ create_secret: "id" }]);
        }
        if (/binderlab:vault-write \*\/ vault\.update_secret/.test(query)) {
          const v = /where name = '((?:[^']|'')*)'\), '((?:[^']|'')*)'\);$/.exec(query);
          if (!v || vault[unq(v[1]!)] === undefined) return json(400, { message: "syntax error" });
          vault[unq(v[1]!)] = unq(v[2]!);
          return json(201, [{ update_secret: "" }]);
        }
        if (/binderlab:vault-generate \*\//.test(query)) {
          const name = /where name = '((?:[^']|'')*)'\) then/.exec(query)?.[1];
          if (!name || !/gen_random_uuid\(\)/.test(query))
            return json(400, { message: "syntax error" });
          vault[unq(name)] = randomBytes(32).toString("hex");
          return json(201, []);
        }
        if (/binderlab:awish-cron \*\//.test(query)) {
          return json(201, [{ ok: sb.awishCron?.[ref] !== false }]);
        }
        if (/binderlab:awish-cron-job \*\//.test(query)) {
          const c = sb.awishCron?.[ref];
          if (c === false || c === "nojob") return json(201, []);
          return json(201, [{ schedule: c === "old" ? "*/10 * * * *" : "*/5 * * * *" }]);
        }
        if (/binderlab:awish-cron-schedule \*\//.test(query)) {
          if (sb.awishCron?.[ref] === false)
            return json(400, { message: 'schema "cron" does not exist' });
          const names = [...query.matchAll(/cron\.schedule\('([a-z-]+)'/g)].map((m) => m[1]!);
          (sb.cronScheduled ??= {})[ref] = names;
          // Awish-jobbets schema måste vara var femte minut (annars skrivs "old" kvar).
          if (!/cron\.schedule\('binderlab-awish-sync', '\*\/5 \* \* \* \*'/.test(query))
            return json(400, { message: "fel schema för binderlab-awish-sync" });
          (sb.awishCron ??= {})[ref] = true;
          return json(201, []);
        }
        if (BOOKKEEPING.test(query)) {
          return json(
            201,
            [...done].map(([version, r]) => ({ version, hash: md5(r.sql), n: 1 })),
          );
        }
        if (/^set transaction read only;/.test(query)) {
          if (/to_regclass/.test(query))
            return json(201, [{ t: hadTable ? "supabase_migrations.schema_migrations" : null }]);
          return json(
            201,
            [...done].map(([version, r]) => ({ version, hash: md5(r.sql) })),
          );
        }
        if (/^select pg_advisory_xact_lock/.test(query)) {
          const v =
            /values \('(\d{14})', '([a-z0-9_]+)', array\[(\$bl_mig\d*\$)([\s\S]*)\3\]\);$/.exec(
              query,
            );
          if (!v) return json(400, { message: "syntax error" });
          if (done.has(v[1]!))
            return json(400, { message: "ERROR: P0001: binderlab: migreringen är redan körd" });
          if (v[4]!.includes("FAIL_HERE"))
            return json(400, { message: 'ERROR: 42601: syntax error at or near "FAIL_HERE"' });
          done.set(v[1]!, { name: v[2]!, sql: v[4]! });
          return json(201, []);
        }
        if (/^select version from supabase_migrations/.test(query)) {
          return json(
            201,
            [...done.keys()].map((version) => ({ version })),
          );
        }
        if ((m = /^alter role postgres with password '([^']+)';$/.exec(query))) {
          sb.passwordVerifiers[ref] = m[1]!;
          return json(201, []);
        }
        return json(400, { message: `okänd fråga i testet: ${query.slice(0, 60)}` });
      }
      return json(404, { message: `Not Found (${method} ${p})` });
    }

    // ---------------- Supabase-projekten ----------------
    if ((m = /^([a-z0-9]+)\.supabase\.co$/.exec(host))) {
      const ref = m[1]!;
      if (p === "/auth/v1/.well-known/jwks.json") {
        const asym = (sb.signingKeys[ref] ?? []).some(
          (k) => k.algorithm !== "HS256" && k.status === "in_use",
        );
        return json(200, { keys: asym ? [{ kty: "EC", alg: "ES256", kid: "x" }] : [] });
      }
      const validKey = (sb.apiKeys[ref] ?? []).some(
        (k) => k.type === "secret" && k.api_key === headers.apikey,
      );
      if (!validKey) return json(401, { message: "Invalid API key" });
      if (p === "/storage/v1/bucket") {
        const buckets = (sb.buckets[ref] ??= []);
        if (method === "GET") return json(200, buckets);
        if (method === "POST") {
          const b = body as { id: string; public: boolean };
          if (buckets.some((x) => x.id === b.id))
            return json(409, { message: "The resource already exists" });
          buckets.push({ id: b.id, public: b.public });
          return json(200, { name: b.id });
        }
      }
      const users = (sb.users[ref] ??= []);
      if (p === "/auth/v1/admin/users" && method === "GET")
        return json(200, { users, aud: "authenticated" });
      if (p === "/auth/v1/admin/users" && method === "POST") {
        const b = body as { email: string; email_confirm: boolean };
        if (users.some((u) => u.email === b.email))
          return json(422, {
            code: "email_exists",
            msg: "A user with this email address has already been registered",
          });
        const user = {
          id: next("u"),
          email: b.email,
          email_confirmed_at: b.email_confirm ? "2026-11-02T00:00:00Z" : null,
        };
        users.push(user);
        return json(200, user);
      }
      if ((m = /^\/auth\/v1\/admin\/users\/([a-z0-9]+)$/.exec(p)) && method === "PUT") {
        const user = users.find((u) => u.id === m![1]);
        if (!user) return json(404, { msg: "User not found" });
        if ((body as { email_confirm?: boolean }).email_confirm)
          user.email_confirmed_at = "2026-11-02T00:00:00Z";
        return json(200, user);
      }
      return json(404, { message: "not found" });
    }

    // ---------------- Vercel ----------------
    if (host === "api.vercel.com") {
      if (headers.authorization !== "Bearer vercel_testtoken_abcdefghijkl")
        return json(403, { error: { code: "forbidden", message: "Not authorized" } });
      const teamId = url.searchParams.get("teamId");
      if (method === "GET" && p === "/v2/teams")
        return json(200, { teams: vc.teams, pagination: { next: null } });
      if (method === "GET" && p === "/v2/user")
        return json(200, { user: { username: vc.username } });
      if (method === "GET" && p === "/v10/projects") {
        return json(200, {
          projects: vc.projects.filter((x) => x.teamId === teamId),
          pagination: { next: null },
        });
      }
      if (method === "POST" && p === "/v11/projects") {
        const b = body as { name: string; gitRepository: { repo: string } };
        const [org, repo] = b.gitRepository.repo.split("/");
        const proj = {
          id: next("prj_"),
          name: b.name,
          teamId: teamId!,
          serverlessFunctionRegion: "iad1",
          link: { type: "github", org: org!, repo: repo!, repoId: 4242, productionBranch: "main" },
        };
        vc.projects.push(proj);
        vc.envs[proj.id] = [];
        vc.domains[proj.id] = [];
        return json(200, proj);
      }
      if ((m = /^\/v9\/projects\/(prj_\d+)$/.exec(p)) && method === "PATCH") {
        const proj = vc.projects.find((x) => x.id === m![1])!;
        Object.assign(proj, body);
        return json(200, proj);
      }
      if ((m = /^\/v9\/projects\/(prj_\d+)\/domains$/.exec(p)))
        return json(200, { domains: vc.domains[m[1]!] ?? [] });
      if ((m = /^\/v10\/projects\/(prj_\d+)\/env$/.exec(p))) {
        const envs = (vc.envs[m[1]!] ??= []);
        if (method === "GET") {
          return json(200, {
            envs: envs.map((e) => ({ ...e, value: e.type === "sensitive" ? "" : `enc:${e.id}` })),
          });
        }
        if (method === "POST") {
          const b = body as EnvRow;
          for (const t of b.target) {
            if (envs.some((e) => e.key === b.key && !e.gitBranch && e.target.includes(t))) {
              return json(400, {
                error: {
                  code: "ENV_CONFLICT",
                  message: `A variable with the name ${b.key} already exists for ${t}`,
                },
              });
            }
          }
          const row = {
            id: next("env_"),
            key: b.key,
            value: b.value,
            type: b.type,
            target: b.target,
          };
          envs.push(row);
          return json(201, { created: row });
        }
      }
      if ((m = /^\/v1\/projects\/(prj_\d+)\/env\/(env_\d+)$/.exec(p)) && method === "GET") {
        const row = (vc.envs[m[1]!] ?? []).find((e) => e.id === m![2]);
        if (!row) return json(404, { error: { message: "not found" } });
        return json(
          200,
          row.type === "sensitive"
            ? { ...row, value: "", decrypted: false }
            : { ...row, decrypted: true },
        );
      }
      if ((m = /^\/v9\/projects\/(prj_\d+)\/env\/(env_\d+)$/.exec(p))) {
        const envs = vc.envs[m[1]!] ?? [];
        const i = envs.findIndex((e) => e.id === m![2]);
        if (i === -1) return json(404, { error: { message: "not found" } });
        if (method === "DELETE") {
          envs.splice(i, 1);
          return json(200, {});
        }
        if (method === "PATCH") {
          Object.assign(envs[i]!, body);
          return json(200, envs[i]);
        }
      }
      if (method === "GET" && p === "/v6/deployments") {
        const list = vc.deployments
          .filter(
            (d) =>
              d.projectId === url.searchParams.get("projectId") &&
              d.target === "production" &&
              d.readyState === "READY",
          )
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((d) => ({ uid: d.id, url: d.url, state: d.readyState }));
        return json(200, { deployments: list.slice(0, 1) });
      }
      if (method === "POST" && p === "/v13/deployments") {
        const b = body as { project: string; target: string; gitSource: { ref: string } };
        const d = {
          id: next("dpl_"),
          projectId: b.project,
          target: b.target,
          readyState: "QUEUED",
          polls: 2,
          url: `binderlab-${state.seq}.vercel.app`,
          createdAt: state.seq,
        };
        vc.deployments.push(d);
        const proj = vc.projects.find((x) => x.id === b.project)!;
        const domains = (vc.domains[proj.id] ??= []);
        if (domains.length === 0)
          domains.push({
            name: `${proj.name}.vercel.app`,
            verified: true,
            redirect: null,
            gitBranch: null,
          });
        return json(200, { id: d.id, url: d.url, readyState: d.readyState });
      }
      if ((m = /^\/v13\/deployments\/(dpl_\d+)$/.exec(p)) && method === "GET") {
        const d = vc.deployments.find((x) => x.id === m![1])!;
        if (d.readyState !== "READY") {
          d.polls -= 1;
          d.readyState = d.polls <= 0 ? "READY" : "BUILDING";
        }
        return json(200, { id: d.id, url: d.url, readyState: d.readyState });
      }
      return json(404, { error: { code: "not_found", message: `Not Found (${method} ${p})` } });
    }

    // ---------------- Appen ----------------
    if (p === "/logga-in") {
      if (vc.site === "not-configured") {
        return new Response(
          '<h1>Binderlab är inte konfigurerat än.</h1><ul><li class="x">SUPABASE_SECRET_KEY: saknas</li></ul>',
          { status: 200 },
        );
      }
      return new Response("<h1>Logga in.</h1>", { status: 200 });
    }
    return json(404, { message: "okänd värd" });
  }

  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {}))
      headers[k.toLowerCase()] = v;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    state.calls.push({ method, url: url.toString(), path: url.pathname, body, headers });
    return handle(method, url, body, headers);
  };
}

/** Anrop som ändrar något (allt utom GET och läsfrågor). */
export function mutatingCalls(state: FakeState): Call[] {
  return state.calls.filter((c) => {
    if (c.method === "GET" || c.method === "HEAD") return false;
    if (c.path.endsWith("/database/query")) {
      const q = (c.body as { query: string }).query;
      return !/^set transaction read only;/.test(q);
    }
    return true;
  });
}
