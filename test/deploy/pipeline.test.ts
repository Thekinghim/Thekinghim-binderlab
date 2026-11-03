import { describe, expect, it } from "vitest";

import { buildOptions, parseArgs, type Phase } from "../../scripts/deploy/lib/config";
import { createLogger, type LogLevel } from "../../scripts/deploy/lib/log";
import { printSummary } from "../../scripts/deploy/lib/main";
import { runDeploy, type Deps } from "../../scripts/deploy/lib/pipeline";
import type { MigrationFile } from "../../src/db/migrator";
import {
  createFakeFetch,
  DEV_REF,
  initialState,
  mutatingCalls,
  secretKeyFor,
  TEAM,
  type FakeState,
} from "./fake-apis";

const SUPABASE_TOKEN = "sbp_testtoken_0123456789abcdef0123";
const VERCEL_TOKEN = "vercel_testtoken_abcdefghijkl";
const PASSWORD = "GENERERATLOSENORD_aaaaaaaaaaaaaaaaaaaaaaaa";
const CRON = "GENERERADCRON_bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VAPID_PRIVATE = "VAPIDPRIVAT_cccccccccccccccccccccccccc";
const RESEND = "re_RESENDHEMLIG_ddddddddddddddddddd";
const OWNER = "agare@exempel.se";

const MIGRATIONS: MigrationFile[] = [
  {
    version: "20261102100000",
    name: "foundation",
    file: "20261102100000_foundation.sql",
    sql: "create table a (id int);",
  },
  {
    version: "20261102100100",
    name: "second",
    file: "20261102100100_second.sql",
    sql: "create table b (id int);",
  },
  {
    version: "20261102100200",
    name: "storage",
    file: "20261102100200_storage.sql",
    sql: "select 1; -- $bl_mig$ i en kommentar",
  },
];

interface Run {
  lines: string[];
  output: string;
  outcome: Awaited<ReturnType<typeof runDeploy>>;
}

function makeDeps(
  state: FakeState,
  lines: string[],
  migrations = MIGRATIONS,
  extra: Partial<Deps> = {},
): Deps {
  const log = createLogger((_level: LogLevel, line: string) => lines.push(line));
  let n = 0;
  return {
    ...extra,
    fetch: extra.fetch ?? createFakeFetch(state),
    sleep: async () => {},
    log,
    readMigrations: async () => migrations,
    generatePassword: () => `${PASSWORD}${++n}`,
    generateCronSecret: () => `${CRON}${++n}`,
    generateVapidKeys: async () => ({
      publicKey: `BPUBLIC_${++n}_${"p".repeat(60)}`,
      privateKey: `${VAPID_PRIVATE}${++n}`,
    }),
  };
}

async function run(
  state: FakeState,
  argv: string[] = [],
  opts: {
    phases?: Phase[];
    env?: Record<string, string>;
    migrations?: MigrationFile[];
    deps?: Partial<Deps>;
  } = {},
): Promise<Run> {
  const lines: string[] = [];
  const options = buildOptions(
    parseArgs(argv),
    { SUPABASE_ACCESS_TOKEN: SUPABASE_TOKEN, VERCEL_TOKEN, ...opts.env },
    opts.phases ?? ["supabase", "vercel", "invite"],
  );
  const deps = makeDeps(state, lines, opts.migrations, opts.deps);
  const outcome = await runDeploy(options, deps);
  printSummary(deps.log, outcome, options.dryRun);
  return { lines, output: lines.join("\n"), outcome };
}

function prodRef(state: FakeState): string {
  return state.supabase.projects.find((p) => p.name === "binderlab-prod")!.id;
}

function envOf(state: FakeState, target: string): Record<string, { value: string; type: string }> {
  const project = state.vercel.projects[0]!;
  const out: Record<string, { value: string; type: string }> = {};
  for (const e of state.vercel.envs[project.id] ?? []) {
    if (e.target.includes(target)) out[e.key] = { value: e.value, type: e.type };
  }
  return out;
}

function allSecrets(state: FakeState): string[] {
  const values = [SUPABASE_TOKEN, VERCEL_TOKEN, RESEND, secretKeyFor(DEV_REF)];
  for (const p of state.supabase.projects) values.push(secretKeyFor(p.id));
  values.push(...Object.values(state.supabase.dbPasswords));
  for (const envs of Object.values(state.vercel.envs)) {
    for (const e of envs) if (e.type === "sensitive") values.push(e.value);
  }
  return values;
}

describe("all.ts från noll", () => {
  it("skapar produktionsprojektet, kör migreringarna, sätter Vercel och driftsätter", async () => {
    const state = initialState();
    const { outcome, output } = await run(state, ["--agare", OWNER], {
      env: { RESEND_API_KEY: RESEND, MAIL_FROM: "Binderlab <rapporter@binderlab.se>" },
    });
    expect(outcome.ok).toBe(true);
    const ref = prodRef(state);

    // Supabase: projektet i rätt region, med ett genererat lösenord.
    const create = state.calls.find((c) => c.method === "POST" && c.path === "/v1/projects")!;
    expect(create.body).toMatchObject({
      name: "binderlab-prod",
      region: "eu-north-1",
      organization_id: "org-binderlab",
    });
    expect((create.body as { db_pass: string }).db_pass).toMatch(/^GENERERATLOSENORD_/);

    // Auth i båda projekten.
    for (const r of [DEV_REF, ref]) {
      const auth = state.supabase.auth[r]!;
      expect(auth.disable_signup).toBe(true);
      expect(auth.mailer_autoconfirm).toBe(false);
      expect(auth.mailer_templates_invite_content).toContain(
        "{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite",
      );
      expect(auth.mailer_templates_magic_link_content).toContain(
        "{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink",
      );
      expect(auth.smtp_host).toBe("smtp.resend.com");
      expect(auth.smtp_admin_email).toBe("rapporter@binderlab.se");
    }
    expect(state.supabase.auth[ref]!.site_url).toBe("https://binderlab.vercel.app");
    expect(state.supabase.auth[ref]!.uri_allow_list).toBe("https://binderlab.vercel.app/**");
    expect(state.supabase.auth[DEV_REF]!.uri_allow_list).toBe(
      `https://binderlab-*-${TEAM.slug}.vercel.app/**`,
    );
    // Utvecklingsprojektets site_url lämnas (appen skickar alltid redirect_to).
    expect(state.supabase.auth[DEV_REF]!.site_url).toBe("http://localhost:3000");
    // Den antagna adressen skrevs inte in i produktionens auth före driftsättningen.
    const firstDeploy = state.calls.findIndex(
      (c) => c.method === "POST" && c.path === "/v13/deployments",
    );
    const prodAuthUrlWrites = state.calls
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          c.method === "PATCH" &&
          c.path === `/v1/projects/${ref}/config/auth` &&
          /site_url|uri_allow_list/.test(JSON.stringify(c.body)),
      );
    expect(prodAuthUrlWrites.length).toBeGreaterThan(0);
    for (const { i } of prodAuthUrlWrites) expect(i).toBeGreaterThan(firstDeploy);

    // Utvecklingsprojektet bytte från HS256 till ES256.
    expect(state.supabase.signingKeys[DEV_REF]!.find((k) => k.status === "in_use")!.algorithm).toBe(
      "ES256",
    );

    // Migreringarna i ordning, i båda projekten.
    for (const r of [DEV_REF, ref]) {
      expect([...state.supabase.migrations[r]!.keys()]).toEqual(MIGRATIONS.map((m) => m.version));
      expect(state.supabase.migrations[r]!.get("20261102100200")!.sql).toBe(MIGRATIONS[2]!.sql);
    }
    const devQueries = state.calls.filter(
      (c) => c.path === `/v1/projects/${DEV_REF}/database/query`,
    );
    const order = devQueries
      .map((c) => /values \('(\d{14})'/.exec((c.body as { query: string }).query)?.[1])
      .filter(Boolean);
    expect(order).toEqual(MIGRATIONS.map((m) => m.version));

    // Buckets.
    for (const r of [DEV_REF, ref]) {
      expect(state.supabase.buckets[r]!.map((b) => b.id).sort()).toEqual([
        "contracts",
        "imports",
        "reports",
      ]);
    }

    // Vercel: projektet kopplat till repot, lhr1, variabler.
    const project = state.vercel.projects[0]!;
    expect(project.link).toMatchObject({ org: "Thekinghim", repo: "thekinghim-binderlab" });
    expect(project.serverlessFunctionRegion).toBe("lhr1");
    const prod = envOf(state, "production");
    const preview = envOf(state, "preview");
    expect(prod.APP_ENV!.value).toBe("production");
    expect(preview.APP_ENV!.value).toBe("preview");
    expect(prod.AUTH_PROVIDER!.value).toBe("supabase");
    expect(prod.APP_URL!.value).toBe("https://binderlab.vercel.app");
    expect(preview.APP_URL).toBeUndefined();
    expect(prod.DATABASE_POOL_MAX!.value).toBe("10");
    expect(prod.SUPABASE_URL!.value).toBe(`https://${ref}.supabase.co`);
    expect(preview.SUPABASE_URL!.value).toBe(`https://${DEV_REF}.supabase.co`);
    expect(prod.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.value).toMatch(/^sb_publishable_/);
    expect(prod.SUPABASE_SECRET_KEY).toEqual({ value: secretKeyFor(ref), type: "sensitive" });
    expect(prod.SUPABASE_JWKS_URL!.value).toBe(
      `https://${ref}.supabase.co/auth/v1/.well-known/jwks.json`,
    );
    // DATABASE_URL: poolern i transaktionsläge med lösenordet som projektet skapades med.
    const dbUrl = new URL(prod.DATABASE_URL!.value);
    expect(prod.DATABASE_URL!.type).toBe("sensitive");
    expect(dbUrl.port).toBe("6543");
    expect(dbUrl.username).toBe(`postgres.${ref}`);
    expect(decodeURIComponent(dbUrl.password)).toBe(state.supabase.dbPasswords[ref]);
    expect(prod.CRON_SECRET!.type).toBe("sensitive");
    expect(prod.CRON_SECRET!.value).not.toBe(preview.CRON_SECRET!.value);
    expect(prod.MAIL_PROVIDER!.value).toBe("resend");
    expect(prod.RESEND_API_KEY!.type).toBe("sensitive");
    expect(prod.PUSH_PROVIDER!.value).toBe("webpush");
    expect(prod.VAPID_SUBJECT!.value).toBe(`mailto:${OWNER}`);
    expect(prod.VAPID_PRIVATE_KEY!.type).toBe("sensitive");
    // Inga publika variabler med hemligheter.
    for (const [key, v] of Object.entries(prod)) {
      if (key.startsWith("NEXT_PUBLIC_")) expect(v.value).not.toMatch(/sb_secret_/);
    }

    // Utvecklingsprojektets lösenord är okänt: det byts INTE utan --byt-dev-losenord.
    expect(state.supabase.passwordVerifiers[DEV_REF]).toBeUndefined();
    expect(preview.DATABASE_URL).toBeUndefined();
    expect(outcome.manual.join("\n")).toMatch(
      /DATABASE_URL för Preview.*SUPABASE_DEV_DB_PASSWORD.*--byt-dev-losenord/,
    );

    // Driftsättning från main.
    const deploy = state.calls.find((c) => c.method === "POST" && c.path === "/v13/deployments")!;
    expect(deploy.body).toMatchObject({
      target: "production",
      gitSource: { type: "github", ref: "main", repoId: 4242 },
    });
    expect(outcome.deployed).toBe(true);
    expect(state.calls.some((c) => c.url === "https://binderlab.vercel.app/logga-in")).toBe(true);

    // Ägaren.
    expect(state.supabase.users[ref]).toEqual([
      expect.objectContaining({ email: OWNER, email_confirmed_at: expect.any(String) }),
    ]);
    expect(output).toContain("Kom igång");
    expect(output).toContain("https://binderlab.vercel.app/logga-in");
  });

  it("skriver aldrig ut hemligheter", async () => {
    const state = initialState();
    const { output } = await run(state, ["--agare", OWNER], {
      env: { RESEND_API_KEY: RESEND, MAIL_FROM: "rapporter@binderlab.se" },
    });
    const secrets = allSecrets(state);
    expect(secrets.length).toBeGreaterThan(8);
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(encodeURIComponent(secret));
    }
    expect(output).not.toMatch(/sb_secret_/);
    expect(output).not.toMatch(/postgres(ql)?:\/\/[^\s]*:[^\s@[]+@/);
    expect(output).not.toContain(CRON);
    expect(output).not.toContain(VAPID_PRIVATE);
    expect(output).not.toContain(PASSWORD);
  });
});

describe("idempotens", () => {
  it("en andra körning ändrar ingenting och driftsätter inte igen", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    const before = state.calls.length;
    const envBefore = JSON.stringify(state.vercel.envs);
    const { outcome, output } = await run(state, ["--agare", OWNER]);
    const second = { ...state, calls: state.calls.slice(before) };
    const changes = mutatingCalls(second).filter(
      (c) =>
        !(
          c.path.endsWith("/database/query") &&
          /create table if not exists supabase_migrations/.test((c.body as { query: string }).query)
        ),
    );
    expect(changes.map((c) => `${c.method} ${c.path}`)).toEqual([]);
    expect(JSON.stringify(state.vercel.envs)).toBe(envBefore);
    expect(outcome.deployed).toBe(false);
    expect(output).toContain("redan körda");
    expect(output).toContain("Produktionen är redan driftsatt");
    expect(output).toContain("Ägarens konto finns redan");
    expect(state.supabase.projects.filter((p) => p.name === "binderlab-prod")).toHaveLength(1);
  });

  it("kör bara nya migreringar och varnar för ändrade", async () => {
    const state = initialState();
    await run(state);
    const changed = [
      { ...MIGRATIONS[0]!, sql: "create table a (id bigint);" },
      MIGRATIONS[1]!,
      MIGRATIONS[2]!,
    ];
    const extra: MigrationFile = {
      version: "20261103090000",
      name: "ny",
      file: "20261103090000_ny.sql",
      sql: "create table c (id int);",
    };
    const before = state.calls.length;
    const { output } = await run(state, [], { migrations: [...changed, extra] });
    const ran = state.calls
      .slice(before)
      .map((c) => /values \('(\d{14})'/.exec(JSON.stringify(c.body ?? ""))?.[1])
      .filter(Boolean);
    expect(ran).toEqual(["20261103090000", "20261103090000"]);
    expect(output).toContain("20261102100000_foundation.sql har ändrats");
  });

  it("en migrering som misslyckas stoppar kedjan med ett tydligt fel", async () => {
    const state = initialState();
    const bad: MigrationFile = {
      version: "20261102100150",
      name: "trasig",
      file: "20261102100150_trasig.sql",
      sql: "FAIL_HERE;",
    };
    await expect(
      run(state, [], { migrations: [MIGRATIONS[0]!, bad, MIGRATIONS[1]!] }),
    ).rejects.toThrow(
      /Migreringen 20261102100150_trasig.sql misslyckades i ukuuwokxbtwhqfnttzwr och rullades tillbaka/,
    );
    expect([...state.supabase.migrations[DEV_REF]!.keys()]).toEqual(["20261102100000"]);
    // Produktionen rördes inte (utveckling först).
    const ref = prodRef(state);
    expect(state.supabase.migrations[ref]).toBeUndefined();
  });

  it("använder ett befintligt produktionsprojekt och byter lösenordet bara om DATABASE_URL saknas", async () => {
    const state = initialState();
    await run(state);
    const ref = prodRef(state);
    const project = state.vercel.projects[0]!;
    // Någon har tagit bort DATABASE_URL i Production.
    state.vercel.envs[project.id] = state.vercel.envs[project.id]!.filter(
      (e) => !(e.key === "DATABASE_URL" && e.target.includes("production")),
    );
    const verifierBefore = state.supabase.passwordVerifiers[ref];
    const { outcome } = await run(state);
    expect(
      state.calls.filter((c) => c.method === "POST" && c.path === "/v1/projects"),
    ).toHaveLength(1);
    expect(state.supabase.passwordVerifiers[ref]).toMatch(/^SCRAM-SHA-256\$/);
    expect(state.supabase.passwordVerifiers[ref]).not.toBe(verifierBefore);
    expect(envOf(state, "production").DATABASE_URL).toBeDefined();
    expect(outcome.deployed).toBe(true);
  });

  it("delar upp en variabel som delas mellan Production och Preview med fel värde", async () => {
    const state = initialState();
    await run(state);
    const project = state.vercel.projects[0]!;
    const envs = state.vercel.envs[project.id]!;
    for (const target of ["production", "preview"]) {
      const i = envs.findIndex((e) => e.key === "APP_ENV" && e.target.includes(target));
      envs.splice(i, 1);
    }
    envs.push({
      id: "env_999",
      key: "APP_ENV",
      value: "production",
      type: "encrypted",
      target: ["production", "preview", "development"],
    });
    await run(state);
    const appEnv = state.vercel.envs[project.id]!.filter((e) => e.key === "APP_ENV");
    expect(appEnv.find((e) => e.id === "env_999")).toMatchObject({
      target: ["production", "development"],
      value: "production",
    });
    expect(appEnv.find((e) => e.target.length === 1 && e.target[0] === "preview")).toMatchObject({
      value: "preview",
    });
  });

  it("uppdaterar en känslig variabel när nyckeln ändrats (fingeravtryck), annars inte", async () => {
    const state = initialState();
    await run(state);
    const ref = prodRef(state);
    state.supabase.apiKeys[ref] = state.supabase.apiKeys[ref]!.map((k) =>
      k.type === "secret" ? { ...k, api_key: `sb_secret_${ref}_ROTERAD_9876543210` } : k,
    );
    const { outcome } = await run(state);
    expect(envOf(state, "production").SUPABASE_SECRET_KEY!.value).toBe(
      `sb_secret_${ref}_ROTERAD_9876543210`,
    );
    expect(outcome.deployed).toBe(true);
  });
});

describe("dry-run", () => {
  it("skickar bara läsningar och visar planen", async () => {
    const state = initialState();
    const { output, outcome } = await run(state, ["--dry-run", "--agare", OWNER]);
    expect(mutatingCalls(state).map((c) => `${c.method} ${c.path}`)).toEqual([]);
    expect(state.supabase.projects).toHaveLength(1);
    expect(output).toContain("DRY-RUN");
    expect(output).toContain("skulle: skapa Supabase-projektet binderlab-prod i eu-north-1");
    expect(output).toContain("skulle: köra 20261102100000_foundation.sql i ukuuwokxbtwhqfnttzwr");
    expect(output).toContain("skulle: skapa Vercel-projektet binderlab");
    expect(output).toContain("Sammanfattning");
    expect(outcome.deployed).toBe(false);
  });

  it("dry-run efter en körning visar att inget behövs", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    const before = state.calls.length;
    const { output } = await run(state, ["--dry-run", "--agare", OWNER]);
    expect(mutatingCalls({ ...state, calls: state.calls.slice(before) })).toEqual([]);
    expect(output).not.toContain("→ skulle:");
  });
});

describe("faser och fel", () => {
  it("supabase.ts ändrar inget i Vercel", async () => {
    const state = initialState();
    await run(state, [], { phases: ["supabase"] });
    const vercelWrites = mutatingCalls(state).filter((c) =>
      c.url.startsWith("https://api.vercel.com"),
    );
    expect(vercelWrites).toEqual([]);
    expect(state.supabase.migrations[prodRef(state)]!.size).toBe(MIGRATIONS.length);
  });

  it("vercel.ts kräver att produktionsprojektet finns", async () => {
    const state = initialState();
    await expect(run(state, [], { phases: ["vercel"] })).rejects.toThrow(
      /Kör scripts\/deploy\/supabase.ts/,
    );
  });

  it("invite-owner bekräftar ett befintligt obekräftat konto", async () => {
    const state = initialState();
    await run(state);
    const ref = prodRef(state);
    state.supabase.users[ref] = [{ id: "u1", email: OWNER, email_confirmed_at: null }];
    const { output } = await run(state, [OWNER], { phases: ["invite"] });
    expect(state.supabase.users[ref]![0]!.email_confirmed_at).not.toBeNull();
    expect(output).toContain("e-posten är nu bekräftad");
  });

  it("säger tydligt vad som är manuellt när signing-keys-API:t saknas", async () => {
    const state = initialState();
    state.supabase.noSigningKeysApi = true;
    const { outcome } = await run(state);
    expect(outcome.manual.join("\n")).toMatch(/JWT Keys.*ES256/);
  });

  it("varnar för Vercel Hobby (cron var 10:e minut kräver Pro)", async () => {
    const state = initialState();
    state.vercel.teams[0]!.billing = { plan: "hobby" };
    const { output } = await run(state);
    expect(output).toMatch(/Hobby-planen/);
  });

  it('misslyckas när /logga-in visar "inte konfigurerat"', async () => {
    const state = initialState();
    state.vercel.site = "not-configured";
    const { outcome, output } = await run(state);
    expect(outcome.ok).toBe(false);
    expect(output).toContain('säger "inte konfigurerat": SUPABASE_SECRET_KEY');
  });

  it("fel token ger ett begripligt fel utan att visa token", async () => {
    const state = initialState();
    const lines: string[] = [];
    const options = buildOptions(
      parseArgs([]),
      { SUPABASE_ACCESS_TOKEN: "sbp_fel_token_9999999999999999999999", VERCEL_TOKEN },
      ["supabase"],
    );
    const error = await runDeploy(options, makeDeps(state, lines)).catch((e: Error) => e);
    expect(String(error)).toMatch(/svarade 401.*token/);
    expect(String(error)).not.toContain("sbp_fel_token");
  });

  it("väntar tills ett nytt projekt och en driftsättning är klara", async () => {
    const state = initialState();
    const { output } = await run(state);
    expect(output).toMatch(/Väntar på prod.*COMING_UP/);
    expect(output).toMatch(/Driftsättningen: (QUEUED|BUILDING)/);
  });
});

// ---------------------------------------------------------------------------
// Granskningens fynd (docs/driftsattning.md → Säkerhet)
// ---------------------------------------------------------------------------

type Fetch = ReturnType<typeof createFakeFetch>;

/** Vercel ger projektet en annan domän än <namn>.vercel.app (namnet var upptaget). */
function foreignDefaultDomain(state: FakeState): Fetch {
  const inner = createFakeFetch(state);
  return async (input, init) => {
    const response = await inner(input, init);
    const url = new URL(input);
    if (url.host === "api.vercel.com" && url.pathname === "/v13/deployments") {
      for (const domains of Object.values(state.vercel.domains)) {
        for (const d of domains) {
          if (d.name === "binderlab.vercel.app") d.name = "binderlab-thekinghim.vercel.app";
        }
      }
    }
    return response;
  };
}

function authWrites(state: FakeState, ref: string): string[] {
  return state.calls
    .filter((c) => c.method === "PATCH" && c.path === `/v1/projects/${ref}/config/auth`)
    .map((c) => JSON.stringify(c.body));
}

describe("adresserna i Supabase Auth", () => {
  it("skriver aldrig in en antagen *.vercel.app-adress, och sätter den riktiga efter driftsättningen", async () => {
    const state = initialState();
    const { outcome } = await run(state, [], { deps: { fetch: foreignDefaultDomain(state) } });
    const ref = prodRef(state);
    const auth = state.supabase.auth[ref]!;
    expect(auth.site_url).toBe("https://binderlab-thekinghim.vercel.app");
    expect(auth.uri_allow_list).toBe("https://binderlab-thekinghim.vercel.app/**");
    for (const body of authWrites(state, ref)) expect(body).not.toContain("binderlab.vercel.app");
    expect(envOf(state, "production").APP_URL!.value).toBe(
      "https://binderlab-thekinghim.vercel.app",
    );
    expect(outcome.appUrl).toBe("https://binderlab-thekinghim.vercel.app");
  });

  it("supabase.ts följt av vercel.ts sätter produktionens adresser", async () => {
    const state = initialState();
    const deps = { fetch: foreignDefaultDomain(state) };
    const first = await run(state, [], { phases: ["supabase"], deps });
    expect(first.output).toContain("sätts när Vercel gett projektet sin adress");
    const ref = prodRef(state);
    expect(state.supabase.auth[ref]!.site_url).toBe("http://localhost:3000");
    expect(state.supabase.auth[ref]!.uri_allow_list).toBe("");
    await run(state, [], { phases: ["vercel"], deps });
    expect(state.supabase.auth[ref]!.site_url).toBe("https://binderlab-thekinghim.vercel.app");
    expect(state.supabase.auth[ref]!.uri_allow_list).toBe(
      "https://binderlab-thekinghim.vercel.app/**",
    );
  });

  it("tar bort främmande *.vercel.app-poster och en främmande site_url i produktionen", async () => {
    const state = initialState();
    await run(state);
    const ref = prodRef(state);
    state.supabase.auth[ref]!.uri_allow_list =
      "https://binderlab.vercel.app/**,https://evil.vercel.app/**,https://*.vercel.app/**,https://app.exempel.se/**";
    // Domänen byter namn (projektet döptes om); site_url pekar då på en adress som inte längre är projektets.
    state.vercel.domains[state.vercel.projects[0]!.id]![0]!.name = "binderlab-ny.vercel.app";
    await run(state, [], { phases: ["vercel"] });
    expect(state.supabase.auth[ref]!.uri_allow_list).toBe(
      "https://app.exempel.se/**,https://binderlab-ny.vercel.app/**",
    );
    expect(state.supabase.auth[ref]!.site_url).toBe("https://binderlab-ny.vercel.app");
  });

  it("godtar inte en befintlig APP_URL vars värd inte är projektets", async () => {
    const state = initialState();
    await run(state);
    const project = state.vercel.projects[0]!;
    const row = state.vercel.envs[project.id]!.find(
      (e) => e.key === "APP_URL" && e.target.includes("production"),
    )!;
    row.value = "https://nagon-annan.vercel.app";
    await run(state);
    expect(envOf(state, "production").APP_URL!.value).toBe("https://binderlab.vercel.app");
    expect(String(state.supabase.auth[prodRef(state)]!.uri_allow_list)).not.toContain(
      "nagon-annan",
    );
  });
});

describe("produktionsprojektet i Supabase", () => {
  it("ett binderlab-prod i en annan organisation används inte (avbryter före alla ändringar)", async () => {
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
    await expect(run(state)).rejects.toThrow(
      /binderlab-prod finns i en annan organisation.*foreignprodxxxxxxxxx i nagon-annans-org.*--supabase-org/,
    );
    expect(mutatingCalls(state)).toEqual([]);
  });

  it("ett 504 på POST /v1/projects (projektet skapades ändå) ger ett projekt och rätt lösenord", async () => {
    const state = initialState();
    const inner = createFakeFetch(state);
    let failed = false;
    const fetch: Fetch = async (input, init) => {
      const response = await inner(input, init);
      const url = new URL(input);
      if (!failed && url.pathname === "/v1/projects" && init?.method === "POST") {
        failed = true;
        return new Response("Gateway Timeout", { status: 504 });
      }
      return response;
    };
    const { outcome, output } = await run(state, [], { deps: { fetch } });
    expect(outcome.ok).toBe(true);
    expect(state.supabase.projects.filter((p) => p.name === "binderlab-prod")).toHaveLength(1);
    expect(
      state.calls.filter((c) => c.method === "POST" && c.path === "/v1/projects"),
    ).toHaveLength(1);
    expect(output).toContain("skapades ändå");
    const ref = prodRef(state);
    const db = new URL(envOf(state, "production").DATABASE_URL!.value);
    expect(decodeURIComponent(db.password)).toBe(state.supabase.dbPasswords[ref]);
    expect(state.supabase.passwordVerifiers[ref]).toBeUndefined();
  });
});

describe("DATABASE_URL", () => {
  it("en känslig DATABASE_URL som delas mellan Production och Preview delas alltid upp", async () => {
    const state = initialState();
    await run(state, [], { deps: { devDbPassword: "DEVLOSEN_kant_eeeeeeeeeeeeeeeee" } });
    const project = state.vercel.projects[0]!;
    const devUrl = `postgresql://postgres.${DEV_REF}:x@aws-1-eu-north-1.pooler.supabase.com:6543/postgres`;
    state.vercel.envs[project.id] = [
      ...state.vercel.envs[project.id]!.filter((e) => e.key !== "DATABASE_URL"),
      {
        id: "env_9999",
        key: "DATABASE_URL",
        value: devUrl,
        type: "sensitive",
        target: ["production", "preview"],
      },
    ];
    const { outcome } = await run(state, [], {
      deps: { devDbPassword: "DEVLOSEN_kant_eeeeeeeeeeeeeeeee" },
    });
    const ref = prodRef(state);
    const rows = state.vercel.envs[project.id]!.filter((e) => e.key === "DATABASE_URL");
    expect(rows.map((r) => r.target)).toEqual([["preview"], ["production"]]);
    expect(rows.find((r) => r.target[0] === "production")!.value).toContain(`postgres.${ref}:`);
    expect(rows.find((r) => r.target[0] === "preview")!.value).toContain(`postgres.${DEV_REF}:`);
    // Produktionens lösenord var okänt i den här körningen: det byttes (SCRAM).
    expect(state.supabase.passwordVerifiers[ref]).toMatch(/^SCRAM-SHA-256\$/);
    expect(state.supabase.passwordVerifiers[DEV_REF]).toBeUndefined();
    expect(outcome.deployed).toBe(true);
  });

  it("genererar om en känslig DATABASE_URL när den bokförda taggen pekar på ett annat projekt", async () => {
    const state = initialState();
    await run(state);
    const ref = prodRef(state);
    const project = state.vercel.projects[0]!;
    const stateRow = state.vercel.envs[project.id]!.find(
      (e) => e.key === "BINDERLAB_DEPLOY_STATE" && e.target[0] === "production",
    )!;
    const parsed = JSON.parse(stateRow.value) as { tags: Record<string, string> };
    expect(parsed.tags.DATABASE_URL).toBe(`${ref}@aws-1-eu-north-1.pooler.supabase.com`);
    parsed.tags.DATABASE_URL = `${DEV_REF}@aws-1-eu-north-1.pooler.supabase.com`;
    stateRow.value = JSON.stringify(parsed);
    const { output } = await run(state);
    expect(output).toContain("DATABASE_URL (production) godtas inte (pekar på ett annat mål)");
    expect(state.supabase.passwordVerifiers[ref]).toMatch(/^SCRAM-SHA-256\$/);
    // Tredje körningen: taggen stämmer, inget byts.
    const verifier = state.supabase.passwordVerifiers[ref];
    await run(state);
    expect(state.supabase.passwordVerifiers[ref]).toBe(verifier);
  });

  it("--byt-dev-losenord byter utvecklingsprojektets lösenord med en SCRAM-verifierare", async () => {
    const state = initialState();
    const { output } = await run(state, ["--byt-dev-losenord"]);
    expect(state.supabase.passwordVerifiers[DEV_REF]).toMatch(/^SCRAM-SHA-256\$4096:/);
    const previewUrl = new URL(envOf(state, "preview").DATABASE_URL!.value);
    expect(previewUrl.username).toBe(`postgres.${DEV_REF}`);
    const alter = state.calls.find((c) => /alter role/.test(JSON.stringify(c.body)))!;
    expect(JSON.stringify(alter.body)).not.toContain(decodeURIComponent(previewUrl.password));
    expect(output).toContain("Uppdatera GitHub-hemligheten DATABASE_URL (development)");
    expect(output).not.toContain(decodeURIComponent(previewUrl.password));
  });

  it("SUPABASE_DEV_DB_PASSWORD ger Preview en DATABASE_URL utan att lösenordet byts", async () => {
    const state = initialState();
    const known = "DEVLOSEN_kant_ffffffffffffffffff";
    const { output } = await run(state, [], { deps: { devDbPassword: known } });
    expect(state.supabase.passwordVerifiers[DEV_REF]).toBeUndefined();
    expect(decodeURIComponent(new URL(envOf(state, "preview").DATABASE_URL!.value).password)).toBe(
      known,
    );
    expect(output).not.toContain(known);
  });
});

describe("driftsättningen", () => {
  function failingDeploys(state: FakeState): Fetch {
    const inner = createFakeFetch(state);
    let failId: string | undefined;
    return async (input, init) => {
      const url = new URL(input);
      const response = await inner(input, init);
      if (url.host === "api.vercel.com" && url.pathname === "/v13/deployments") {
        failId = ((await response.clone().json()) as { id: string }).id;
      }
      if (failId && url.pathname === `/v13/deployments/${failId}`) {
        state.vercel.deployments.find((x) => x.id === failId)!.readyState = "ERROR";
        return new Response(JSON.stringify({ id: failId, readyState: "ERROR" }), { status: 200 });
      }
      return response;
    };
  }

  it("driftsätter igen efter en misslyckad driftsättning, och sedan inte mer", async () => {
    const state = initialState();
    await run(state);
    const env = { RESEND_API_KEY: RESEND, MAIL_FROM: "a@b.se" };
    await expect(run(state, [], { env, deps: { fetch: failingDeploys(state) } })).rejects.toThrow(
      /ERROR/,
    );
    const count = () => state.calls.filter((c) => c.path === "/v13/deployments").length;
    const before = count();
    const { outcome, output } = await run(state, [], { env });
    expect(count()).toBe(before + 1);
    expect(outcome.deployed).toBe(true);
    expect(output).toContain("tidigare ändringar har inte nått en färdig version");
    const third = await run(state, [], { env });
    expect(third.outcome.deployed).toBe(false);
    expect(third.output).toContain("Produktionen är redan driftsatt");
  });

  it("--skip-deploy med ändrade variabler: nästa körning driftsätter", async () => {
    const state = initialState();
    await run(state);
    const env = { RESEND_API_KEY: RESEND, MAIL_FROM: "a@b.se" };
    expect((await run(state, ["--skip-deploy"], { env })).outcome.deployed).toBe(false);
    expect((await run(state, [], { env })).outcome.deployed).toBe(true);
  });
});

describe("Vercel-projektet", () => {
  it("avbryter om projekt i flera team är kopplade till repot (utan --vercel-team)", async () => {
    const state = initialState();
    await run(state);
    state.vercel.teams.push({ id: "team_annat", slug: "annat", billing: { plan: "pro" } });
    state.vercel.projects.push({
      ...state.vercel.projects[0]!,
      id: "prj_777",
      teamId: "team_annat",
    });
    await expect(run(state)).rejects.toThrow(
      /flera team.*binderlab i thekinghim.*annat.*--vercel-team/,
    );
    const { outcome } = await run(state, ["--vercel-team", TEAM.slug]);
    expect(outcome.ok).toBe(true);
  });
});

describe("ägaren", () => {
  it("ett 422 som inte är email_exists döljs inte", async () => {
    const state = initialState();
    await run(state);
    const inner = createFakeFetch(state);
    const fetch: Fetch = async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/auth/v1/admin/users" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: "validation_failed", msg: "Unable to validate email address" }),
          { status: 422 },
        );
      }
      return inner(input, init);
    };
    await expect(run(state, [OWNER], { phases: ["invite"], deps: { fetch } })).rejects.toThrow(
      /kunde inte skapas \(422 validation_failed: Unable to validate email address\)/,
    );
  });
});

describe("Awish-synken: Vault för pg_cron", () => {
  it("skriver appens adress och samma CRON_SECRET som Vercel till produktionens Vault", async () => {
    const state = initialState();
    const { outcome, output } = await run(state, ["--agare", OWNER]);
    expect(outcome.ok).toBe(true);
    const ref = prodRef(state);
    const vault = state.supabase.vault[ref]!;
    expect(vault.binderlab_app_url).toBe(outcome.appUrl);
    expect(vault.binderlab_cron_secret).toBe(envOf(state, "production").CRON_SECRET!.value);
    expect(vault.binderlab_cron_secret!.length).toBeGreaterThanOrEqual(16);
    // Hemligheten skrivs aldrig ut.
    expect(output).not.toContain(vault.binderlab_cron_secret!);
    expect(output).toContain("Awish-synken körs var tionde minut");
  });

  it("ett CRON_SECRET som redan finns i Vault används i Vercel (Vault är källan)", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    const ref = prodRef(state);
    state.supabase.vault[ref]!.binderlab_cron_secret = "BEFINTLIG_VAULT_HEMLIGHET_123456789";
    const { output } = await run(state, ["--agare", OWNER]);
    expect(envOf(state, "production").CRON_SECRET!.value).toBe(
      "BEFINTLIG_VAULT_HEMLIGHET_123456789",
    );
    expect(output).not.toContain("BEFINTLIG_VAULT_HEMLIGHET_123456789");
    // Preview har sitt eget värde.
    expect(envOf(state, "preview").CRON_SECRET!.value).not.toBe(
      "BEFINTLIG_VAULT_HEMLIGHET_123456789",
    );
  });

  it("idempotent: en tredje körning skriver inget till Vault", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    await run(state, ["--agare", OWNER]);
    const before = state.calls.length;
    await run(state, ["--agare", OWNER]);
    const writes = state.calls
      .slice(before)
      .filter((c) => /binderlab:vault-write/.test(JSON.stringify(c.body ?? "")));
    expect(writes).toEqual([]);
  });

  it("saknas pg_cron/pg_net blir det ett manuellt steg", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    state.supabase.awishCron = { [prodRef(state)]: false };
    const { output } = await run(state, ["--agare", OWNER]);
    expect(output).toMatch(/pg_cron-jobbet binderlab-awish-sync saknas/);
    // SQL:en att köra för hand skrivs ut (det går inte att köra om migreringen).
    expect(output).toContain("select cron.schedule('binderlab-awish-sync'");
    expect(output).not.toMatch(/kör migreringen .* igen/);
  });

  it("CRON_SECRET slumpas i databasen och står aldrig i SQL-texten", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    const ref = prodRef(state);
    const secret = state.supabase.vault[ref]!.binderlab_cron_secret!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const sqlText = state.calls
      .map((c) => JSON.stringify(c.body ?? ""))
      .filter((b) => /database\/query|query/.test(b))
      .join("\n");
    expect(sqlText).not.toContain(secret);
    expect(sqlText).toMatch(/binderlab:vault-generate/);
  });

  it("ett för kort CRON_SECRET i Vault ersätts med ett slumpat", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    const ref = prodRef(state);
    state.supabase.vault[ref]!.binderlab_cron_secret = "kort";
    await run(state, ["--agare", OWNER]);
    const secret = state.supabase.vault[ref]!.binderlab_cron_secret!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(envOf(state, "production").CRON_SECRET!.value).toBe(secret);
  });

  it("pg_cron påslaget men jobbet saknas: deploy schemalägger synken och rensningen", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    const ref = prodRef(state);
    state.supabase.awishCron = { [ref]: "nojob" };
    const { output } = await run(state, ["--agare", OWNER]);
    expect(state.supabase.cronScheduled?.[ref]).toEqual([
      "binderlab-awish-sync",
      "binderlab-cron-cleanup",
    ]);
    expect(output).toContain("Awish-synken körs var tionde minut");
    expect(output).not.toMatch(/pg_cron-jobbet binderlab-awish-sync saknas/);
  });

  it("dry-run schemalägger inget i pg_cron", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    const ref = prodRef(state);
    state.supabase.awishCron = { [ref]: "nojob" };
    await run(state, ["--agare", OWNER, "--dry-run"]);
    expect(state.supabase.cronScheduled?.[ref]).toBeUndefined();
  });

  it("dry-run skriver inget till Vault", async () => {
    const state = initialState();
    await run(state, ["--agare", OWNER]);
    const ref = prodRef(state);
    delete state.supabase.vault[ref]!.binderlab_cron_secret;
    const before = JSON.stringify(state.supabase.vault);
    await run(state, ["--agare", OWNER, "--dry-run"]);
    expect(JSON.stringify(state.supabase.vault)).toBe(before);
  });
});
