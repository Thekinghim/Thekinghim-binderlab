/**
 * Designgranskning: hittar rester av den gamla designen på varje sida (typsnitt, VERSALER
 * med spärrning, gamla klasser och variabler) och vanliga layoutfel (sidledes scroll på
 * telefon, avklippt text, tomma ytor, små packbilder, konsol- och HTTP-fel).
 *
 *   npm run design:audit                                   # egen server och databas
 *   npm run design:audit -- --routes lonsamhet,/automater*  # bara vissa sidor
 *   npm run design:audit -- --base-url http://localhost:3200 --out /tmp/granskning
 *
 * Flaggor:
 *   --base-url <url>   granska en körande server (seedens användare och lösenord)
 *   --routes <lista>   mönster, kommaseparerade: "/lonsamhet" exakt, "automater" del,
 *                      "/portal*" prefix
 *   --roles <lista>    agare-demo, agare, pafyllare, butik, utloggad (standard alla)
 *   --out <mapp>       report.md, report.json och shots/ (standard .design-audit)
 *   --db <url>         databasen för den egna servern
 *                      (standard postgres://postgres@127.0.0.1:54322/binderlab_gransk_designaudit)
 *   --port <n>         första porten att prova för den egna servern (standard 3290)
 *   --dist-dir <mapp>  byggmappen för den egna servern (standard .next-gransk)
 *   --concurrency <n>  sidor samtidigt (standard 2)
 *   --restart-every <n> starta om den egna servern och webbläsaren efter n jobb (standard 30)
 *   --keep             låt databasen och byggmappen ligga kvar
 *   --skip-seed        återanvänd databasen som den är (med --keep från en tidigare körning)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { auditJob, discoverByLink, jobUrl, login, type AuditJob, type PageAudit } from "./audit";
import { launchBrowser, type StorageState } from "./playwright";
import { buildRouteReports, renderMarkdown, SourceIndex, totals } from "./report";
import { discoverRoutes, routeFilter } from "./routes";
import {
  createReportDrafts,
  dropDatabase,
  freePort,
  prepareDatabase,
  resolveParams,
  ROLES,
  startDevServer,
  type DevServer,
} from "./setup";

export interface Args {
  baseUrl?: string;
  routes?: string;
  roles?: string;
  out: string;
  db: string;
  port: number;
  distDir: string;
  concurrency: number;
  keep: boolean;
  skipSeed: boolean;
  restartEvery: number;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    out: ".design-audit",
    db: "postgres://postgres@127.0.0.1:54322/binderlab_gransk_designaudit",
    port: 3290,
    distDir: ".next-gransk",
    concurrency: 2,
    keep: false,
    skipSeed: false,
    restartEvery: 30,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    const [flag, inline] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} saknar värde.`);
      return v;
    };
    switch (flag) {
      case "--base-url":
        args.baseUrl = value().replace(/\/$/, "");
        break;
      case "--routes":
        args.routes = value();
        break;
      case "--roles":
        args.roles = value();
        break;
      case "--out":
        args.out = value();
        break;
      case "--db":
        args.db = value();
        break;
      case "--port":
        args.port = Number(value());
        break;
      case "--dist-dir":
        args.distDir = value();
        break;
      case "--concurrency":
        args.concurrency = Math.max(1, Number(value()));
        break;
      case "--restart-every":
        args.restartEvery = Math.max(1, Number(value()));
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--skip-seed":
        args.skipSeed = true;
        break;
      default:
        throw new Error(`Okänd flagga ${raw}. Se scripts/design-audit/index.ts.`);
    }
  }
  return args;
}

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = new Date();
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const outDir = path.resolve(args.out);
  rmSync(path.join(outDir, "shots"), { recursive: true, force: true });
  mkdirSync(path.join(outDir, "shots"), { recursive: true });

  const routes = discoverRoutes(process.cwd()).filter((r) => routeFilter(args.routes)(r.pattern));
  const allPatterns = discoverRoutes(process.cwd()).map((r) => r.pattern);
  const wanted = args.roles ? new Set(args.roles.split(",").map((s) => s.trim())) : null;
  const roles = ROLES.filter((r) => !wanted || wanted.has(r.key));
  log(`${routes.length} sidor, ${roles.length} roller.`);

  // Seedarna och servern lägger filer i .data (importfiler, utkorg): bort efteråt om mappen
  // inte fanns före körningen.
  const dataExisted = existsSync(".data");
  let server: DevServer | null = null;
  let serverOptions: Parameters<typeof startDevServer>[0] | null = null;
  const ownServer = !args.baseUrl;
  const cleanup = async () => {
    if (server) await server.stop();
    server = null;
    if (ownServer && !args.keep) {
      rmSync(args.distDir, { recursive: true, force: true });
      await dropDatabase(args.db).catch((e) => log(`Kunde inte ta bort databasen: ${e}`));
      if (!dataExisted) rmSync(".data", { recursive: true, force: true });
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(130));
    });
  }

  try {
    let baseUrl = args.baseUrl ?? "";
    if (ownServer) {
      if (!args.skipSeed) {
        log(`Seedar ${new URL(args.db).pathname.slice(1)} (db:reset, db:seed, db:seed-demo).`);
        await prepareDatabase(args.db, log);
      }
      serverOptions = {
        databaseUrl: args.db,
        port: await freePort(args.port),
        distDir: args.distDir,
        logFile: path.join(outDir, "server.log"),
        log,
      };
      rmSync(serverOptions.logFile, { force: true });
      server = await startDevServer(serverOptions);
      baseUrl = server.baseUrl;
      if (!args.skipSeed) await createReportDrafts(baseUrl, server.cronSecret, log);
    }

    let browser = await launchBrowser();
    const audits: PageAudit[] = [];
    try {
      const jobs: AuditJob[] = [];
      for (const role of roles) {
        const state: StorageState | null = await login(browser, baseUrl, role, log);
        if (!state) continue;
        const params =
          ownServer && role.orgSlug
            ? await resolveParams(args.db, role.orgSlug, role.key === "butik")
            : {};
        for (const route of routes) {
          let url = jobUrl(route, params);
          if (!url && route.params.length > 0 && role.email) {
            url = await discoverByLink(browser, baseUrl, state, route, allPatterns);
          }
          jobs.push({ route, role, state, url });
        }
      }
      log(`${jobs.length} jobb (roll × sida), ${args.concurrency} samtidigt.`);
      let done = 0;
      const shots = new Set<string>();
      // next dev växer i minnet för varje sida som kompileras: den egna servern och
      // webbläsaren startas om efter varje omgång (byggmappens cache gör det snabbt).
      for (let start = 0; start < jobs.length; start += args.restartEvery) {
        if (start > 0) {
          await browser.close();
          if (server) {
            const secrets = { auth: server.authSecret, cron: server.cronSecret };
            await server.stop();
            // Turbopacks cache i byggmappen växer med flera GB: börja om (disken är liten).
            rmSync(args.distDir, { recursive: true, force: true });
            server = await startDevServer({ ...serverOptions!, secrets });
          }
          browser = await launchBrowser();
        }
        let scaler = await browser.newContext({
          baseURL: "about:blank",
          viewport: { width: 800, height: 600 },
        });
        // Webbläsaren kan krascha när minnet tar slut (flera servrar på samma maskin): starta
        // en ny och gör jobbet en gång till.
        let relaunching: Promise<void> | null = null;
        const revive = async () => {
          if (browser.isConnected()) return;
          relaunching ??= (async () => {
            log("Webbläsaren kraschade: startar en ny.");
            await browser.close().catch(() => {});
            browser = await launchBrowser();
            scaler = await browser.newContext({
              baseURL: "about:blank",
              viewport: { width: 800, height: 600 },
            });
          })().finally(() => {
            relaunching = null;
          });
          await relaunching;
        };
        // Servern kan också dödas: en ny med samma hemligheter (inloggningarna gäller).
        let restarting: Promise<void> | null = null;
        const reviveServer = async () => {
          if (!server || server.alive()) return;
          restarting ??= (async () => {
            log("Servern dog: startar en ny.");
            const secrets = { auth: server!.authSecret, cron: server!.cronSecret };
            await server!.stop();
            rmSync(args.distDir, { recursive: true, force: true });
            server = await startDevServer({ ...serverOptions!, secrets });
          })().finally(() => {
            restarting = null;
          });
          await restarting;
        };
        const chunk = jobs.slice(start, start + args.restartEvery);
        const results = await pool(chunk, args.concurrency, async (job) => {
          const run = () =>
            auditJob(job, {
              browser,
              scaler,
              baseUrl,
              allPatterns,
              outDir,
              shots,
              maxPerKey: 3,
              log,
            });
          let r: PageAudit[];
          try {
            r = await run();
          } catch {
            await revive();
            r = await run().catch((error: unknown) => [
              {
                pattern: job.route.pattern,
                file: job.route.file,
                url: job.url,
                role: job.role.key,
                viewport: "desktop" as const,
                status: "failed" as const,
                note: error instanceof Error ? error.message.split("\n")[0] : String(error),
                findings: [],
              },
            ]);
          }
          if (r.some((a) => a.status === "failed")) {
            const serverDown = server !== null && !server.alive();
            if (serverDown || !browser.isConnected()) {
              await reviveServer();
              await revive();
              r = await run().catch(() => r);
            }
          }
          done += 1;
          const first = r[r.length - 1]!;
          const n = r.reduce((s, a) => s + a.findings.length, 0);
          log(
            `${String(done).padStart(4)}/${jobs.length} ${job.role.key.padEnd(10)} ${job.route.pattern} ${first.status}${first.note ? ` ${first.note}` : ""}${first.status === "audited" ? ` (${n} fynd, ${r.map((a) => a.ms).join("+")} ms)` : ""}`,
          );
          return r;
        });
        for (const r of results) audits.push(...r);
      }
    } finally {
      await browser.close();
    }

    const index = new SourceIndex(process.cwd());
    const reports = buildRouteReports(audits, index);
    const t = totals(reports, audits.filter((a) => a.status === "audited").length);
    let commit = "okänd";
    try {
      commit = execSync("git rev-parse --short=12 HEAD", { encoding: "utf8" }).trim();
    } catch {
      // ingen git
    }
    const meta = {
      baseUrl,
      commit,
      startedAt: started.toISOString(),
      roles: roles.map((r) => r.key),
    };
    writeFileSync(
      path.join(outDir, "report.json"),
      `${JSON.stringify({ meta, totals: t, routes: reports, pages: audits.map(({ findings: _f, ...a }) => a) }, null, 2)}\n`,
    );
    writeFileSync(path.join(outDir, "report.md"), renderMarkdown(reports, t, meta));
    log(
      `Klart: ${t.routesChecked}/${t.routesTotal} sidor granskade, ${t.routesWithFindings} med fynd. ${path.join(outDir, "report.md")}`,
    );
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && /design-audit[\\/]index\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
}
