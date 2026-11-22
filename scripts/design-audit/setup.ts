/**
 * Egen databas och egen dev-server för granskningen: db:reset, db:seed och db:seed-demo
 * i en lokal databas (standard binderlab_gransk_designaudit), en butiksanvändare för
 * portalen och `next dev` på en ledig port med en egen byggmapp (NEXT_DIST_DIR). Allt
 * städas bort efteråt (stop).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import postgres from "postgres";

import { hashPassword } from "../../src/server/auth/password";

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const DEFAULT_PASSWORD = process.env.DEV_SEED_PASSWORD || "binderlab-dev";
export const STORE_USER = "butik-granskning@binderlab.local";

export interface Role {
  key: string;
  label: string;
  email: string | null;
  /** Organisationens slug: dynamiska delar hämtas ur den. */
  orgSlug: string | null;
}

/** Rollerna ur seedarna (scripts/db/seed.ts, seed-demo.ts) och portalens butiksanvändare. */
export const ROLES: readonly Role[] = [
  {
    key: "agare-demo",
    label: "Ägare (demo@)",
    email: "demo@binderlab.local",
    orgSlug: "nordljus-demo",
  },
  { key: "agare", label: "Ägare (agare@)", email: "agare@binderlab.local", orgSlug: "binderlab" },
  {
    key: "pafyllare",
    label: "Påfyllare (demo-pafyllare@)",
    email: "demo-pafyllare@binderlab.local",
    orgSlug: "nordljus-demo",
  },
  { key: "butik", label: "Butiksportal", email: STORE_USER, orgSlug: "nordljus-demo" },
  { key: "utloggad", label: "Utloggad", email: null, orgSlug: null },
];

export function assertLocalDatabase(url: string): void {
  const u = new URL(url);
  if (!LOCAL.has(u.hostname)) throw new Error(`Databasen måste vara lokal (${u.hostname}).`);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^binderlab_gransk_[a-z0-9_]+$/.test(name)) {
    throw new Error(`Granskningens databas ska heta binderlab_gransk_* (fick ${name}).`);
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, log: (m: string) => void): void {
  log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} misslyckades:\n${res.stdout}\n${res.stderr}`);
  }
}

/** Återställer och seedar databasen och lägger till butiksanvändaren. */
export async function prepareDatabase(url: string, log: (m: string) => void): Promise<void> {
  assertLocalDatabase(url);
  const env = { ...process.env, DATABASE_URL: url };
  const tsx = path.resolve("node_modules/.bin/tsx");
  run(tsx, ["scripts/db/reset.ts", "dev"], env, log);
  run(tsx, ["scripts/db/seed.ts", "--url", url], env, log);
  run(tsx, ["scripts/db/seed-demo.ts", "--url", url], env, log);
  await addStoreUser(url);
}

/** Butiksanvändaren (roll store) i demons första butik, med seedens lösenord. */
async function addStoreUser(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const hash = await hashPassword(DEFAULT_PASSWORD);
    const [user] = await sql<{ id: string }[]>`
      insert into auth.users (email, encrypted_password, raw_user_meta_data)
      values (${STORE_USER}, ${hash}, ${sql.json({ full_name: "Butik Granskning" })})
      on conflict (email) do update set encrypted_password = excluded.encrypted_password
      returning id`;
    const [store] = await sql<{ id: string; organization_id: string }[]>`
      select s.id, s.organization_id from public.stores s
      join public.organizations o on o.id = s.organization_id
      where o.slug = 'nordljus-demo' and s.archived_at is null
      order by s.name limit 1`;
    if (!store) throw new Error("Demons butiker saknas.");
    await sql`
      insert into public.memberships (organization_id, user_id, role, store_id)
      values (${store.organization_id}::uuid, ${user!.id}::uuid, 'store', ${store.id}::uuid)
      on conflict do nothing`;
  } finally {
    await sql.end();
  }
}

export async function dropDatabase(url: string): Promise<void> {
  assertLocalDatabase(url);
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  u.pathname = "/postgres";
  const sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await sql.end();
  }
}

/** Värden för de dynamiska delarna, per organisation, ur databasen. */
export async function resolveParams(
  url: string,
  orgSlug: string,
  storeUser: boolean,
): Promise<Record<string, Record<string, string>>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`
      select id from public.organizations where slug = ${orgSlug}`;
    if (!org) return {};
    const one = async (q: Promise<{ v: string }[]>) => (await q)[0]?.v;
    const machine = await one(sql`
      select id::text as v from public.machines
      where organization_id = ${org.id}::uuid and archived_at is null order by code limit 1`);
    // Automatens sida har koden i adressen (ett id skickas vidare till koden).
    const machineCode = await one(sql`
      select lower(code) as v from public.machines
      where organization_id = ${org.id}::uuid and archived_at is null order by code limit 1`);
    const store = await one(sql`
      select id::text as v from public.stores
      where organization_id = ${org.id}::uuid and archived_at is null order by name limit 1`);
    const imp = await one(sql`
      select id::text as v from public.imports
      where organization_id = ${org.id}::uuid order by created_at desc limit 1`);
    const incident = await one(sql`
      select id::text as v from public.incidents
      where organization_id = ${org.id}::uuid order by created_at desc limit 1`);
    const report = await one(sql`
      select id::text as v from public.reports
      where organization_id = ${org.id}::uuid order by generated_at desc limit 1`);
    const mystery = await one(sql`
      select title_id::text as v from public.mystery_recipes
      where organization_id = ${org.id}::uuid order by created_at limit 1`);
    let portalReport: string | undefined;
    if (storeUser) {
      portalReport = await one(sql`
        select r.id::text as v from public.reports r
        join public.memberships m on m.store_id = r.store_id
        join auth.users u on u.id = m.user_id
        where u.email = ${STORE_USER} order by r.generated_at desc limit 1`);
    }
    const byPattern: Record<string, Record<string, string | undefined>> = {
      "/automater/[automat]": { automat: machineCode },
      "/butiker/[butik]": { butik: store },
      "/datakallor/importer/[id]": { id: imp },
      "/drift/automat/[id]": { id: machine },
      "/inkorg/[id]": { id: incident },
      "/vart-lager/mystery/[titelId]": { titelId: mystery },
      "/fyll-pa/[machineId]": { machineId: machine },
      "/fyll-pa/[machineId]/qr": { machineId: machine },
      "/rapport/[id]": { id: report },
      "/rapport/[id]/epost": { id: report },
      "/portal/rapporter/[id]": { id: portalReport },
      // Ingen giltig länk i seeden: sidan för ogiltig/utgången länk granskas.
      "/inbjudan/[token]": { token: "granskning-ogiltig-lank" },
      "/signera/[token]": { token: "granskning-ogiltig-lank" },
    };
    const out: Record<string, Record<string, string>> = {};
    for (const [pattern, values] of Object.entries(byPattern)) {
      const clean = Object.fromEntries(
        Object.entries(values).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
      if (Object.keys(clean).length === Object.keys(values).length) out[pattern] = clean;
    }
    return out;
  } finally {
    await sql.end();
  }
}

export async function freePort(start: number): Promise<number> {
  for (let port = start; port < start + 200; port += 1) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("Ingen ledig port.");
}

export interface DevServer {
  baseUrl: string;
  cronSecret: string;
  authSecret: string;
  /** Processen lever (next dev kan dödas när minnet tar slut). */
  alive(): boolean;
  stop(): Promise<void>;
}

async function waitFor(baseUrl: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`next dev avslutades (${child.exitCode}).`);
    try {
      const res = await fetch(new URL("/logga-in", baseUrl), { redirect: "manual" });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Servern ${baseUrl} svarar inte (${last}).`);
}

/**
 * `next dev` mot databasen med dev-inloggning. tsconfig.json återställs efteråt om Next
 * lägger till byggmappens typer i den.
 */
export async function startDevServer(options: {
  databaseUrl: string;
  port: number;
  distDir: string;
  logFile: string;
  log: (m: string) => void;
  /** Samma hemligheter vid omstart, så att inloggningarna gäller. */
  secrets?: { auth: string; cron: string };
}): Promise<DevServer> {
  const tsconfig = readFileSync("tsconfig.json", "utf8");
  const nextEnvExisted = existsSync("next-env.d.ts");
  const dataExisted = existsSync(".data");
  const secret = options.secrets?.auth ?? randomBytes(32).toString("hex");
  const cronSecret = options.secrets?.cron ?? `granskning-${randomBytes(16).toString("hex")}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    APP_ENV: "development",
    AUTH_PROVIDER: "dev",
    DATABASE_URL: options.databaseUrl,
    DEV_AUTH_SECRET: secret,
    CRON_SECRET: cronSecret,
    MAIL_PROVIDER: "outbox",
    NEXT_DIST_DIR: options.distDir,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const baseUrl = `http://localhost:${options.port}`;
  options.log(`Startar next dev på ${baseUrl} (byggmapp ${options.distDir}).`);
  const { openSync, closeSync } = await import("node:fs");
  const fd = openSync(options.logFile, "a");
  const child = spawn(
    process.execPath,
    [path.resolve("node_modules/next/dist/bin/next"), "dev", "-p", String(options.port)],
    { env, stdio: ["ignore", fd, fd], detached: true },
  );
  closeSync(fd);
  const groupAlive = () => {
    try {
      process.kill(-child.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  const stop = async () => {
    // Hela processgruppen (next dev startar egna arbetsprocesser), också om huvudprocessen
    // redan är död. Filerna städas först när ingen av dem kan skriva längre.
    if (child.pid && groupAlive()) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // redan borta
      }
      for (let i = 0; i < 100 && groupAlive(); i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (groupAlive()) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // redan borta
        }
        for (let i = 0; i < 50 && groupAlive(); i += 1) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    if (readFileSync("tsconfig.json", "utf8") !== tsconfig)
      writeFileSync("tsconfig.json", tsconfig);
    if (!nextEnvExisted) rmSync("next-env.d.ts", { force: true });
    // Utkorgen och lokala filer (.data) som servern skapade.
    if (!dataExisted) rmSync(".data", { recursive: true, force: true });
  };
  try {
    await waitFor(baseUrl, child, 300_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    baseUrl,
    cronSecret,
    authSecret: secret,
    alive: () => child.exitCode === null && child.signalCode === null,
    stop,
  };
}

/** Månadens rapportutkast (som Vercel cron), så att rapportsidorna har en riktig rapport. */
export async function createReportDrafts(
  baseUrl: string,
  cronSecret: string,
  log: (m: string) => void,
): Promise<void> {
  const res = await fetch(new URL("/api/cron/rapporter", baseUrl), {
    headers: { authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(600_000),
  });
  log(`Rapportutkast: HTTP ${res.status}`);
}
