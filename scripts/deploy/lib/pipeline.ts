/**
 * Hela driftsättningen i ordning. Används av all.ts (alla faser) och av
 * supabase.ts, vercel.ts och invite-owner.ts (en fas var). Alla beroenden
 * (fetch, väntan, generatorer, migreringsfiler) skickas in, så att testerna
 * kan köra hela kedjan mot ett mockat API.
 *
 * Ordning:
 *   1. Supabase: projekten (utveckling finns, produktion skapas), nycklar.
 *   2. Vercel: projektet kopplat till repot (läses för adress och team).
 *   3. Supabase: auth, JWT-nycklar, migreringar, buckets.
 *   4. Vercel: region, miljövariabler, driftsättning från main, kontroll.
 *   5. Ägaren (om --agare).
 */

import type { MigrationFile } from "../../../src/db/migrator";
import {
  DEV_PROJECT_REF,
  GITHUB_REPO,
  PASSTHROUGH_VARS,
  PROD_PROJECT_NAME,
  PROD_REGION,
  PRODUCTION_BRANCH,
  STORAGE_BUCKETS,
  SUPABASE_API,
  VERCEL_API,
  VERCEL_FUNCTION_REGION,
  VERCEL_PROJECT_NAME,
  type DeployOptions,
} from "./config";
import { createApiClient, type FetchLike, type Sleep } from "./http";
import { ensureOwnerUser, ownerNextSteps } from "./invite";
import type { Logger } from "./log";
import type { VapidKeys } from "./secrets";
import * as sb from "./supabase";
import * as vc from "./vercel";

export interface Deps {
  fetch: FetchLike;
  sleep: Sleep;
  log: Logger;
  readMigrations: () => Promise<MigrationFile[]>;
  generatePassword: () => string;
  generateCronSecret: () => string;
  generateVapidKeys: () => Promise<VapidKeys>;
  /** Lösenordet för utvecklingsprojektets databas, om det är känt. */
  devDbPassword?: string;
}

export interface Outcome {
  ok: boolean;
  appUrl?: string;
  prodRef?: string;
  devRef: string;
  deployed: boolean;
  manual: readonly string[];
}

interface Env {
  label: "utveckling" | "produktion";
  target: vc.Target;
  ref: string | undefined;
  project: sb.SupabaseProject | null;
  keys: sb.ApiKeys | null;
  /** Känt lösenord (bara nyskapat produktionsprojekt eller angivet). */
  dbPassword?: string;
}

export function previewRedirect(teamSlug: string): string {
  return `https://*-${teamSlug}.vercel.app/**`;
}

export async function runDeploy(options: DeployOptions, deps: Deps): Promise<Outcome> {
  const { log } = deps;
  const dryRun = options.dryRun;
  const phases = options.phases;
  const wantSupabase = phases.has("supabase");
  const wantVercel = phases.has("vercel");
  const wantInvite = phases.has("invite");

  if (!options.supabaseToken) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN saknas. Skapa en personlig token i Supabase → Account → Access Tokens och sätt den i sessionens miljö.",
    );
  }
  if (wantVercel && !options.vercelToken) {
    throw new Error("VERCEL_TOKEN saknas. Skapa en token i Vercel → Account Settings → Tokens.");
  }
  log.secret(options.supabaseToken);
  log.secret(options.vercelToken);
  for (const { key, sensitive } of PASSTHROUGH_VARS) {
    if (sensitive) log.secret(options.passthrough[key]);
  }
  log.secret(deps.devDbPassword);

  if (dryRun) log.info("DRY-RUN: inget ändras. Raderna med → visar vad som skulle göras.");

  const supabaseApi = createApiClient({
    service: "Supabase",
    baseUrl: SUPABASE_API,
    token: options.supabaseToken,
    fetch: deps.fetch,
    log,
    dryRun,
    sleep: deps.sleep,
  });
  const sctx: sb.Ctx = { api: supabaseApi, log, dryRun, sleep: deps.sleep, fetch: deps.fetch };

  // 1. Supabase-projekten ------------------------------------------------------
  log.step("Supabase: projekt");
  const projects = await sb.listProjects(sctx);
  const devProject = sb.findDevProject(projects, DEV_PROJECT_REF);
  log.ok(`Utvecklingsprojektet finns: ${devProject.name} (${DEV_PROJECT_REF}).`);
  const organization =
    options.supabaseOrg ?? devProject.organization_slug ?? devProject.organization_id;
  if (!organization) {
    throw new Error(
      "Supabase: utvecklingsprojektets organisation är okänd. Ange --supabase-org <id>.",
    );
  }
  const prodExists = projects.some((p) => p.name === PROD_PROJECT_NAME && p.status !== "REMOVED");
  if (!prodExists && !wantSupabase && !dryRun) {
    throw new Error(
      `Supabase: produktionsprojektet ${PROD_PROJECT_NAME} finns inte. Kör scripts/deploy/supabase.ts (eller all.ts) först.`,
    );
  }
  const prod = await sb.ensureProdProject(sctx, projects, {
    name: PROD_PROJECT_NAME,
    region: PROD_REGION,
    organization,
    password: deps.generatePassword,
  });
  const dev: Env = {
    label: "utveckling",
    target: "preview",
    ref: DEV_PROJECT_REF,
    project: await sb.waitForProject(sctx, DEV_PROJECT_REF),
    keys: null,
    dbPassword: deps.devDbPassword,
  };
  const prodRef = prod.project ? sb.projectRef(prod.project) : undefined;
  const prodEnv: Env = {
    label: "produktion",
    target: "production",
    ref: prodRef,
    project: prodRef ? await sb.waitForProject(sctx, prodRef) : null,
    keys: null,
    dbPassword: prod.dbPassword,
  };
  const envs = [dev, prodEnv];

  log.step("Supabase: API-nycklar");
  for (const env of envs) {
    if (!env.ref) {
      log.plan(`hämta nycklarna för ${PROD_PROJECT_NAME} när det skapats`);
      continue;
    }
    env.keys = await sb.ensureApiKeys(sctx, env.ref);
  }

  // 2. Vercel-projektet (läses även i supabase-fasen för adress och team) -------
  let vctx: vc.Ctx | undefined;
  let resolved: vc.ResolvedProject | undefined;
  let envEntries: vc.EnvEntry[] = [];
  let appUrl = options.appUrl;
  let appUrlAssumed = false;
  if (options.vercelToken) {
    log.step("Vercel: projekt");
    const vercelApi = createApiClient({
      service: "Vercel",
      baseUrl: VERCEL_API,
      token: options.vercelToken,
      fetch: deps.fetch,
      log,
      // Bara vercel-fasen får ändra något i Vercel.
      dryRun: dryRun || !wantVercel,
      sleep: deps.sleep,
    });
    vctx = {
      api: vercelApi,
      log,
      dryRun: dryRun || !wantVercel,
      sleep: deps.sleep,
      fetch: deps.fetch,
    };
    if (wantVercel) {
      resolved = await vc.resolveProject(vctx, {
        team: options.vercelTeam,
        repo: GITHUB_REPO,
        name: VERCEL_PROJECT_NAME,
      });
    } else {
      try {
        resolved = await vc.resolveProject(
          { ...vctx, log: quietPlans(log) },
          { team: options.vercelTeam, repo: GITHUB_REPO, name: VERCEL_PROJECT_NAME },
        );
      } catch (error) {
        log.warn(`Vercel-projektet kunde inte läsas: ${(error as Error).message}`);
      }
    }
    if (resolved?.scope.plan === "hobby") {
      log.warn(
        "Vercel-teamet har Hobby-planen. vercel.json kör larmjobbet var 10:e minut, vilket kräver Pro; " +
          "på Hobby avvisas driftsättningen. Uppgradera teamet till Pro (eller ändra schemat i vercel.json till en gång om dagen).",
      );
    }
    if (resolved?.project) {
      envEntries = await vc.listEnv(vctx, resolved.scope, resolved.project);
      if (!appUrl) {
        const domain = await vc.productionDomain(vctx, resolved.scope, resolved.project);
        if (domain && !domain.endsWith(".vercel.app")) {
          appUrl = `https://${domain}`;
        } else {
          const existing = await vc.readEnvValue(
            vctx,
            resolved.scope,
            resolved.project,
            envEntries,
            "APP_URL",
            "production",
          );
          if (existing && /^https:\/\/[^/]+$/.test(existing)) {
            appUrl = existing;
          } else {
            appUrl = `https://${domain ?? `${resolved.project.name}.vercel.app`}`;
            appUrlAssumed = !domain;
          }
        }
      }
    }
    if (!appUrl && resolved) {
      appUrl = `https://${VERCEL_PROJECT_NAME}.vercel.app`;
      appUrlAssumed = true;
    }
    if (appUrl)
      log.info(
        `Appens adress i produktion: ${appUrl}${appUrlAssumed ? " (antagen tills första driftsättningen)" : ""}.`,
      );
  }

  // 3. Supabase: auth, JWT, migreringar, buckets --------------------------------
  if (wantSupabase) {
    log.step("Supabase: inloggning");
    const smtp = sb.resendSmtp(options.passthrough);
    if (!smtp) {
      log.manual(
        "Egen SMTP för Supabase Auth saknas: Supabases inbyggda e-post skickar bara till organisationens medlemmar och några mejl i timmen. " +
          "Kör igen med RESEND_API_KEY och MAIL_FROM i miljön, så kopplas Resend in i båda projekten.",
      );
    }
    for (const env of envs) {
      if (!env.ref) {
        log.plan(
          `ställa in auth, JWT-nycklar, migreringar och buckets i ${PROD_PROJECT_NAME} när det skapats`,
        );
        continue;
      }
      const redirects: string[] = [];
      if (env.target === "production" && appUrl) redirects.push(`${appUrl}/**`);
      if (env.target === "preview" && resolved)
        redirects.push(previewRedirect(resolved.scope.slug));
      if (!appUrl) {
        log.manual(
          `${env.ref}: Site URL och Redirect URLs sattes inte (adressen är okänd). Kör med VERCEL_TOKEN eller --app-url.`,
        );
      }
      await sb.configureAuth(sctx, env.ref, {
        siteUrl: appUrl,
        siteUrlOnlyIfDefault: env.target === "preview",
        redirectUrls: redirects,
        smtp,
      });
      const jwt = await sb.ensureAsymmetricJwt(sctx, env.ref);
      if (!dryRun && jwt !== "manual") await sb.checkJwks(sctx, env.ref);
    }

    log.step("Supabase: migreringar");
    const migrations = await deps.readMigrations();
    log.info(`${migrations.length} migreringar i supabase/migrations.`);
    for (const env of envs) {
      if (!env.ref) {
        log.plan(
          `köra alla ${migrations.length} migreringar i ${PROD_PROJECT_NAME} när det skapats`,
        );
        continue;
      }
      log.info(`${env.label} (${env.ref}):`);
      await sb.runMigrations(sctx, env.ref, migrations);
    }

    log.step("Supabase: lagring");
    for (const env of envs) {
      if (!env.ref || !env.keys) {
        if (!env.ref)
          log.plan(`kontrollera buckets ${STORAGE_BUCKETS.join(", ")} i ${PROD_PROJECT_NAME}`);
        continue;
      }
      await sb.ensureBuckets(sctx, env.ref, env.keys.secret, STORAGE_BUCKETS);
    }
  }

  // 4. Vercel: region, variabler, driftsättning ---------------------------------
  let deployed = false;
  let siteOk = true;
  if (wantVercel && vctx && resolved) {
    const { scope } = resolved;
    const project = resolved.project;
    log.step("Vercel: inställningar");
    let regionChanged = false;
    if (project) {
      regionChanged = await vc.ensureFunctionRegion(vctx, scope, project, VERCEL_FUNCTION_REGION);
      if (project.link?.productionBranch && project.link.productionBranch !== PRODUCTION_BRANCH) {
        log.warn(
          `Vercel-projektets produktionsgren är ${project.link.productionBranch}, inte ${PRODUCTION_BRANCH}. Ändra under Settings → Git.`,
        );
      }
    } else {
      log.plan(`sätta funktionsregion ${VERCEL_FUNCTION_REGION} på det nya projektet`);
    }

    log.step("Vercel: miljövariabler");
    let envResult: vc.EnvSyncResult = { changes: [], productionChanged: false };
    if (project) {
      const desired: vc.DesiredVar[] = [];
      for (const env of envs) {
        desired.push(
          ...(await desiredVars(env, {
            sctx,
            deps,
            options,
            appUrl,
            has: (key) => vc.hasEnv(envEntries, key, env.target),
          })),
        );
      }
      envResult = await vc.syncEnv(vctx, scope, project, desired);
    } else {
      log.plan("sätta alla variabler för Production och Preview i det nya projektet");
    }

    log.step("Vercel: driftsättning");
    if (!project) {
      log.plan(
        `driftsätta ${PRODUCTION_BRANCH} till produktion och kontrollera ${appUrl ?? "adressen"}/logga-in`,
      );
    } else if (options.skipDeploy) {
      log.info("--skip-deploy: ingen driftsättning.");
    } else {
      const latest = await vc.latestReadyProduction(vctx, scope, project);
      const reasons = [
        options.forceDeploy && "--force-deploy",
        envResult.productionChanged && "variablerna ändrades",
        regionChanged && "regionen ändrades",
        resolved.created && "projektet är nytt",
        !latest && "ingen färdig produktionsversion finns",
      ].filter(Boolean);
      if (reasons.length === 0) {
        log.ok(
          `Produktionen är redan driftsatt med samma inställningar (${latest?.url ?? latest?.id}).`,
        );
      } else if (dryRun) {
        log.plan(`driftsätta ${PRODUCTION_BRANCH} till produktion (${reasons.join(", ")})`);
      } else {
        log.info(`Driftsätter: ${reasons.join(", ")}.`);
        const started = await vc.createProductionDeployment(
          vctx,
          scope,
          project,
          GITHUB_REPO,
          PRODUCTION_BRANCH,
        );
        await vc.waitForDeployment(vctx, scope, started.id);
        deployed = true;
        // Fick projektet en annan domän än den antagna? Rätta APP_URL och auth och driftsätt igen.
        if (appUrlAssumed && !options.appUrl) {
          const domain = await vc.productionDomain(vctx, scope, project);
          if (domain && `https://${domain}` !== appUrl) {
            log.warn(
              `Produktionsadressen blev https://${domain}, inte ${appUrl}. Rättar och driftsätter igen.`,
            );
            appUrl = `https://${domain}`;
            if (prodEnv.ref && wantSupabase) {
              await sb.configureAuth(sctx, prodEnv.ref, {
                siteUrl: appUrl,
                redirectUrls: [`${appUrl}/**`],
                smtp: null,
              });
            }
            envEntries = await vc.listEnv(vctx, scope, project);
            await vc.syncEnv(vctx, scope, project, [
              { key: "APP_URL", target: "production", sensitive: false, value: appUrl },
            ]);
            const again = await vc.createProductionDeployment(
              vctx,
              scope,
              project,
              GITHUB_REPO,
              PRODUCTION_BRANCH,
            );
            await vc.waitForDeployment(vctx, scope, again.id);
          }
        }
      }
      if (!dryRun && appUrl) {
        const check = await vc.checkSite(vctx, appUrl);
        siteOk = check.ok;
      }
    }
  }

  // 5. Ägaren --------------------------------------------------------------------
  if (wantInvite) {
    const inviteEnv = options.inviteTarget === "preview" ? dev : prodEnv;
    log.step("Ägaren");
    if (!options.ownerEmail) {
      log.info("Ingen ägare angavs (--agare <e-post>); hoppar över.");
    } else if (!inviteEnv.ref || !inviteEnv.keys) {
      log.plan(`skapa ägarens konto ${options.ownerEmail} i ${PROD_PROJECT_NAME} när det finns`);
    } else {
      log.info(`Ägaren läggs i ${inviteEnv.label}sprojektet (${inviteEnv.ref}).`);
      await ensureOwnerUser(
        { log, dryRun, fetch: deps.fetch, sleep: deps.sleep },
        {
          supabaseUrl: sb.projectUrl(inviteEnv.ref),
          secretKey: inviteEnv.keys.secret,
          email: options.ownerEmail,
        },
      );
      if (inviteEnv.target === "preview") {
        log.info(
          "Logga in på en förhandsversion (Vercel → Deployments → Preview) med samma e-post.",
        );
      } else {
        log.info("Så här gör ägaren sedan:");
        ownerNextSteps(appUrl ?? "https://<appens adress>", options.ownerEmail).forEach((line, i) =>
          log.info(`${i + 1}. ${line}`),
        );
      }
    }
  }

  if (wantVercel) remainingManual(log, options);
  return {
    ok: siteOk,
    appUrl,
    prodRef,
    devRef: DEV_PROJECT_REF,
    deployed,
    manual: log.manualSteps,
  };
}

/** Samma logger men utan plan-rader (för läsningar i faser som inte ändrar Vercel). */
function quietPlans(log: Logger): Logger {
  return { ...log, plan: () => {}, ok: () => {}, secret: log.secret, redact: log.redact } as Logger;
}

async function desiredVars(
  env: Env,
  c: {
    sctx: sb.Ctx;
    deps: Deps;
    options: DeployOptions;
    appUrl: string | undefined;
    has: (key: string) => boolean;
  },
): Promise<vc.DesiredVar[]> {
  const t = env.target;
  const appEnv = t === "production" ? "production" : "preview";
  const out: vc.DesiredVar[] = [
    { key: "APP_ENV", target: t, sensitive: false, value: appEnv },
    { key: "NEXT_PUBLIC_APP_ENV", target: t, sensitive: false, value: appEnv },
    { key: "AUTH_PROVIDER", target: t, sensitive: false, value: "supabase" },
    { key: "DATABASE_POOL_MAX", target: t, sensitive: false, value: "3" },
  ];
  if (t === "production" && c.appUrl) {
    out.push({ key: "APP_URL", target: t, sensitive: false, value: c.appUrl });
  }
  if (env.ref) {
    const url = sb.projectUrl(env.ref);
    out.push(
      { key: "SUPABASE_URL", target: t, sensitive: false, value: url },
      { key: "NEXT_PUBLIC_SUPABASE_URL", target: t, sensitive: false, value: url },
      { key: "SUPABASE_JWKS_URL", target: t, sensitive: false, value: sb.jwksUrl(env.ref) },
    );
    if (env.keys) {
      out.push(
        {
          key: "SUPABASE_PUBLISHABLE_KEY",
          target: t,
          sensitive: false,
          value: env.keys.publishable,
        },
        {
          key: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
          target: t,
          sensitive: false,
          value: env.keys.publishable,
        },
        { key: "SUPABASE_SECRET_KEY", target: t, sensitive: true, value: env.keys.secret },
      );
    }
    const ref = env.ref;
    const pooler = await sb.getPooler(c.sctx, ref, env.project?.region);
    const accept = (current: string) => {
      try {
        const u = new URL(current);
        return u.port === "6543" && decodeURIComponent(u.username).endsWith(`.${ref}`);
      } catch {
        return false;
      }
    };
    if (env.dbPassword) {
      out.push({
        key: "DATABASE_URL",
        target: t,
        sensitive: true,
        value: sb.databaseUrl(pooler, env.dbPassword),
      });
    } else {
      out.push({
        key: "DATABASE_URL",
        target: t,
        sensitive: true,
        accept,
        generate: async () => {
          // Lösenordet är okänt (projektet fanns redan): byt det och bygg adressen.
          const password = c.sctx.log.secret(c.deps.generatePassword());
          if (env.target === "preview") {
            c.sctx.log.warn(
              `Databaslösenordet i utvecklingsprojektet ${ref} byts (det var okänt). Ange SUPABASE_DEV_DB_PASSWORD för att behålla det.`,
            );
          }
          await sb.setDatabasePassword(c.sctx, ref, password);
          return sb.databaseUrl(pooler, password);
        },
      });
    }
  }
  out.push({ key: "CRON_SECRET", target: t, sensitive: true, generate: c.deps.generateCronSecret });

  // Valfria värden från sessionens miljö.
  for (const { key, sensitive } of PASSTHROUGH_VARS) {
    const value = c.options.passthrough[key];
    if (value) out.push({ key, target: t, sensitive, value });
  }
  if (c.options.passthrough.RESEND_API_KEY && c.options.passthrough.MAIL_FROM) {
    out.push({ key: "MAIL_PROVIDER", target: t, sensitive: false, value: "resend" });
  }

  // Web Push: nycklarna skapas en gång (båda eller ingen), kontaktadressen krävs.
  const subject =
    c.options.passthrough.VAPID_SUBJECT ??
    (c.options.ownerEmail ? `mailto:${c.options.ownerEmail}` : undefined);
  if (subject) {
    if (!c.options.passthrough.VAPID_SUBJECT) {
      out.push({ key: "VAPID_SUBJECT", target: t, sensitive: false, value: subject });
    }
    out.push({ key: "PUSH_PROVIDER", target: t, sensitive: false, value: "webpush" });
    if (c.has("VAPID_PUBLIC_KEY") && c.has("VAPID_PRIVATE_KEY")) {
      out.push(
        { key: "VAPID_PUBLIC_KEY", target: t, sensitive: false },
        { key: "VAPID_PRIVATE_KEY", target: t, sensitive: true },
      );
    } else {
      const keys = await c.deps.generateVapidKeys();
      c.sctx.log.secret(keys.privateKey);
      out.push(
        { key: "VAPID_PUBLIC_KEY", target: t, sensitive: false, value: keys.publicKey },
        { key: "VAPID_PRIVATE_KEY", target: t, sensitive: true, value: keys.privateKey },
      );
    }
  } else if (t === "production") {
    c.sctx.log.manual(
      "Push (Web Push) är av: ange VAPID_SUBJECT (t.ex. mailto:drift@binderlab.se) eller --agare, så skapas VAPID-nycklarna.",
    );
  }
  return out;
}

function remainingManual(log: Logger, options: DeployOptions): void {
  const p = options.passthrough;
  if (!p.RESEND_API_KEY || !p.MAIL_FROM) {
    log.manual(
      "Rapport- och larmmejl: verifiera avsändardomänen i Resend och kör igen med RESEND_API_KEY och MAIL_FROM (annars hamnar mejlen i serverns utkorg).",
    );
  }
  if (!p.SENTRY_DSN)
    log.manual("Sentry: kör igen med SENTRY_DSN och NEXT_PUBLIC_SENTRY_DSN (valfritt).");
  if (!p.ANTHROPIC_API_KEY) {
    log.manual(
      "Assistenten: kör igen med ANTHROPIC_API_KEY (valfritt; läs docs/operations.md om biträden först).",
    );
  }
}
