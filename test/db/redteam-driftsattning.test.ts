/**
 * Oberoende granskning (red team) av scripts/deploy. Använder samma mockade
 * API:er som test/deploy (inget nät, ingen databas).
 *
 * Testerna beskriver ett önskat, säkert beteende. De skrevs som `it.fails`
 * när bristerna fanns; bristerna är rättade och `.fails` borttaget, så nu
 * ska alla passera.
 *
 *   DATABASE_URL_TEST=postgres://postgres@127.0.0.1:54322/binderlab_test_<namn> \
 *     npx vitest run -c vitest.db.config.ts test/db/redteam-driftsattning.test.ts
 */

import { describe, expect, it } from "vitest";

import { buildOptions, parseArgs, type Phase } from "../../scripts/deploy/lib/config";
import { createLogger, type LogLevel } from "../../scripts/deploy/lib/log";
import { runDeploy, type Deps } from "../../scripts/deploy/lib/pipeline";
import type { MigrationFile } from "../../src/db/migrator";
import {
  createFakeFetch,
  DEV_REF,
  initialState,
  publishableKeyFor,
  secretKeyFor,
  type FakeState,
} from "../deploy/fake-apis";

const SUPABASE_TOKEN = "sbp_testtoken_0123456789abcdef0123";
const VERCEL_TOKEN = "vercel_testtoken_abcdefghijkl";

const MIGRATIONS: MigrationFile[] = [
  {
    version: "20261102100000",
    name: "foundation",
    file: "20261102100000_foundation.sql",
    sql: "create table a (id int);",
  },
];

type Fetch = ReturnType<typeof createFakeFetch>;

function deps(fetch: Fetch, lines: string[]): Deps {
  let n = 0;
  return {
    fetch,
    sleep: async () => {},
    log: createLogger((_l: LogLevel, line: string) => lines.push(line)),
    readMigrations: async () => MIGRATIONS,
    generatePassword: () => `GENLOSEN_${"a".repeat(30)}${++n}`,
    generateCronSecret: () => `GENCRON_${"b".repeat(30)}${++n}`,
    generateVapidKeys: async () => ({
      publicKey: `BPUB_${++n}_${"p".repeat(60)}`,
      privateKey: `VAPIDPRIV_${"c".repeat(30)}${++n}`,
    }),
  };
}

async function run(
  state: FakeState,
  opts: { phases?: Phase[]; env?: Record<string, string>; fetch?: Fetch; argv?: string[] } = {},
): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  const options = buildOptions(
    parseArgs(opts.argv ?? []),
    { SUPABASE_ACCESS_TOKEN: SUPABASE_TOKEN, VERCEL_TOKEN, ...opts.env },
    opts.phases ?? ["supabase", "vercel"],
  );
  const outcome = await runDeploy(options, deps(opts.fetch ?? createFakeFetch(state), lines));
  return { lines, ok: outcome.ok };
}

function prodProjects(state: FakeState) {
  return state.supabase.projects.filter((p) => p.name === "binderlab-prod");
}

/** Fake där Vercel ger projektet en annan produktionsdomän än <namn>.vercel.app. */
function fetchWithForeignDefaultDomain(state: FakeState): Fetch {
  const inner = createFakeFetch(state);
  return async (input, init) => {
    const response = await inner(input, init);
    const url = new URL(input);
    if (url.host === "api.vercel.com" && url.pathname === "/v13/deployments") {
      for (const domains of Object.values(state.vercel.domains)) {
        for (const d of domains) {
          // binderlab.vercel.app tillhör någon annan; Vercel väljer ett annat namn.
          if (d.name === "binderlab.vercel.app") d.name = "binderlab-thekinghim.vercel.app";
        }
      }
    }
    return response;
  };
}

describe("red team: driftsättning", () => {
  it("en antagen *.vercel.app-adress som inte blev projektets ligger inte kvar i uri_allow_list (öppen omdirigering av inloggningslänkar)", async () => {
    const state = initialState();
    await run(state, { fetch: fetchWithForeignDefaultDomain(state) });
    const ref = prodProjects(state)[0]!.id;
    const auth = state.supabase.auth[ref]!;
    expect(auth.site_url).toBe("https://binderlab-thekinghim.vercel.app");
    expect(String(auth.uri_allow_list)).not.toContain("https://binderlab.vercel.app/");
  });

  it("supabase.ts följt av vercel.ts (dokumenterad ordning) rättar site_url när domänen blev en annan", async () => {
    const state = initialState();
    const fetch = fetchWithForeignDefaultDomain(state);
    await run(state, { phases: ["supabase"], fetch });
    await run(state, { phases: ["vercel"], fetch });
    const ref = prodProjects(state)[0]!.id;
    expect(state.supabase.auth[ref]!.site_url).toBe("https://binderlab-thekinghim.vercel.app");
  });

  it("ett binderlab-prod i en ANNAN Supabase-organisation används inte som produktion", async () => {
    const state = initialState();
    const foreign = "foreignprodxxxxxxxxx";
    state.supabase.projects.push({
      id: foreign,
      name: "binderlab-prod",
      organization_id: "nagon-annans-org",
      region: "eu-north-1",
      status: "ACTIVE_HEALTHY",
      bootPolls: 0,
    });
    state.supabase.apiKeys[foreign] = [
      { id: "fk1", name: "default", type: "publishable", api_key: publishableKeyFor(foreign) },
      { id: "fk2", name: "default", type: "secret", api_key: secretKeyFor(foreign) },
    ];
    state.supabase.auth[foreign] = { site_url: "http://localhost:3000", uri_allow_list: "" };
    state.supabase.signingKeys[foreign] = [{ id: "fsk", algorithm: "ES256", status: "in_use" }];
    state.supabase.buckets[foreign] = [];
    state.supabase.users[foreign] = [];
    await run(state).catch(() => undefined);
    const touched = state.calls.some((c) => c.method !== "GET" && c.url.includes(foreign));
    expect(touched).toBe(false);
  });

  it("ett 504 på POST /v1/projects (projektet skapades ändå) ger inte två produktionsprojekt", async () => {
    const state = initialState();
    const inner = createFakeFetch(state);
    let failed = false;
    const fetch: Fetch = async (input, init) => {
      const response = await inner(input, init);
      const url = new URL(input);
      if (
        !failed &&
        url.host === "api.supabase.com" &&
        url.pathname === "/v1/projects" &&
        (init?.method ?? "GET").toUpperCase() === "POST"
      ) {
        failed = true;
        return new Response("Gateway Timeout", { status: 504 });
      }
      return response;
    };
    await run(state, { fetch }).catch(() => undefined);
    expect(prodProjects(state)).toHaveLength(1);
  });

  it("en känslig DATABASE_URL som delas mellan Production och Preview (pekar på utveckling) behålls inte i produktion", async () => {
    const state = initialState();
    await run(state);
    const project = state.vercel.projects[0]!;
    const envs = state.vercel.envs[project.id]!;
    const devUrl = `postgresql://postgres.${DEV_REF}:x@aws-1-eu-north-1.pooler.supabase.com:6543/postgres`;
    state.vercel.envs[project.id] = [
      ...envs.filter((e) => e.key !== "DATABASE_URL"),
      {
        id: "env_9999",
        key: "DATABASE_URL",
        value: devUrl,
        type: "sensitive",
        target: ["production", "preview"],
      },
    ];
    await run(state);
    const prodDb = state.vercel.envs[project.id]!.find(
      (e) => e.key === "DATABASE_URL" && e.target.includes("production"),
    )!;
    expect(prodDb.value).not.toContain(DEV_REF);
  });

  it("efter en misslyckad driftsättning driftsätter nästa körning igen (variablerna ändrades men nådde aldrig en färdig version)", async () => {
    const state = initialState();
    await run(state);
    const inner = createFakeFetch(state);
    let failId: string | undefined;
    const failing: Fetch = async (input, init) => {
      const url = new URL(input);
      const response = await inner(input, init);
      if (url.host === "api.vercel.com" && url.pathname === "/v13/deployments") {
        failId = ((await response.clone().json()) as { id: string }).id;
      }
      if (failId && url.pathname === `/v13/deployments/${failId}`) {
        const d = state.vercel.deployments.find((x) => x.id === failId)!;
        d.readyState = "ERROR";
        return new Response(JSON.stringify({ id: failId, readyState: "ERROR" }), { status: 200 });
      }
      return response;
    };
    const env = { RESEND_API_KEY: "re_NYNYCKEL_eeeeeeeeeeeeeeeeee", MAIL_FROM: "a@b.se" };
    await expect(run(state, { env, fetch: failing })).rejects.toThrow(/ERROR/);
    const before = state.calls.filter((c) => c.path === "/v13/deployments").length;
    await run(state, { env });
    const after = state.calls.filter((c) => c.path === "/v13/deployments").length;
    expect(after).toBeGreaterThan(before);
  });

  it("inga hemligheter i utskriften i röda-team-scenarierna", async () => {
    const state = initialState();
    const { lines } = await run(state, { fetch: fetchWithForeignDefaultDomain(state) });
    const out = lines.join("\n");
    for (const secret of [
      SUPABASE_TOKEN,
      VERCEL_TOKEN,
      secretKeyFor(DEV_REF),
      ...state.supabase.projects.map((p) => secretKeyFor(p.id)),
      ...Object.values(state.supabase.dbPasswords),
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).not.toMatch(/GENLOSEN_|GENCRON_|VAPIDPRIV_/);
  });
});
