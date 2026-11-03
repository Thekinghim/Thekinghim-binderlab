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
 *   4. Vercel: region, miljövariabler, driftsättning från main; sedan
 *      produktionens Site URL och Redirect URLs i Supabase; kontroll.
 *   5. Ägaren (om --agare).
 *
 * Appens adress skrivs bara in i Supabase Auth när den är säker: angiven
 * (--app-url) eller en domän som Vercel-projektet faktiskt har. En antagen
 * *.vercel.app-adress (före första driftsättningen) skrivs aldrig in, eftersom
 * namnet kan tillhöra någon annan; då skulle inloggningslänkarnas engångskod
 * kunna skickas dit. Främmande *.vercel.app-poster i produktionens
 * uri_allow_list (och en främmande site_url) tas bort.
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

/**
 * Förhandsversionernas adresser: <projekt>-<hash>-<team>.vercel.app och
 * <projekt>-git-<gren>-<team>.vercel.app. Projektnamnet först gör att en
 * annan Vercel-användares *-<team>.vercel.app inte matchar.
 */
export function previewRedirect(projectName: string, teamSlug: string): string {
  return `https://${projectName}-*-${teamSlug}.vercel.app/**`;
}

/** Det bredare mönstret som tidigare versioner av skriptet satte (tas bort). */
export function legacyPreviewRedirect(teamSlug: string): string {
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
  const orgIds = sb.allowedOrgIds(devProject, options.supabaseOrg);
  if (!organization || orgIds.length === 0) {
    throw new Error(
      "Supabase: utvecklingsprojektets organisation är okänd. Ange --supabase-org <id>.",
    );
  }
  const dev: Env = {
    label: "utveckling",
    target: "preview",
    ref: DEV_PROJECT_REF,
    project:
      options.prodRef === DEV_PROJECT_REF ? null : await sb.waitForProject(sctx, DEV_PROJECT_REF),
    keys: null,
    dbPassword: deps.devDbPassword,
  };
  let prodRef: string | undefined;
  let prodEnv: Env;
  let envs: Env[];
  if (options.prodRef) {
    // Ett befintligt projekt används som produktion; inget skapas och
    // förhandsversionerna (Preview) konfigureras inte.
    const match = projects.find((p) => sb.projectRef(p) === options.prodRef);
    if (!match) {
      throw new Error(`Supabase: projektet ${options.prodRef} (--prod-ref) syns inte för token.`);
    }
    prodRef = options.prodRef;
    log.ok(
      `Produktion: befintliga projektet ${match.name} (${prodRef}); Preview konfigureras inte.`,
    );
    prodEnv = {
      label: "produktion",
      target: "production",
      ref: prodRef,
      project: await sb.waitForProject(sctx, prodRef),
      keys: null,
      dbPassword: prodRef === DEV_PROJECT_REF ? deps.devDbPassword : undefined,
    };
    envs = [prodEnv];
  } else {
    // Bara ett binderlab-prod i rätt organisation räknas (annars avbryts det).
    const selection = sb.selectProdProject(projects, PROD_PROJECT_NAME, orgIds);
    sb.assertNoForeignProd(selection, PROD_PROJECT_NAME, orgIds);
    const prodExists = selection.match !== undefined;
    if (!prodExists && !wantSupabase && !dryRun) {
      throw new Error(
        `Supabase: produktionsprojektet ${PROD_PROJECT_NAME} finns inte. Kör scripts/deploy/supabase.ts (eller all.ts) först.`,
      );
    }
    const prod = await sb.ensureProdProject(sctx, projects, {
      name: PROD_PROJECT_NAME,
      region: PROD_REGION,
      organization,
      orgIds,
      password: deps.generatePassword,
    });
    prodRef = prod.project ? sb.projectRef(prod.project) : undefined;
    prodEnv = {
      label: "produktion",
      target: "production",
      ref: prodRef,
      project: prodRef ? await sb.waitForProject(sctx, prodRef) : null,
      keys: null,
      dbPassword: prod.dbPassword,
    };
    envs = [dev, prodEnv];
  }

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
  /** Antagen (inte bekräftad av Vercel): skrivs aldrig in i Supabase Auth. */
  let appUrlAssumed = false;
  /** Vercel-projektets egna värdar; undefined = okänt (ingen Vercel-åtkomst). */
  let ownHosts: string[] | undefined;
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
    if (resolved) ownHosts = [];
    if (resolved?.project) {
      envEntries = await vc.listEnv(vctx, resolved.scope, resolved.project);
      const domains = await vc.listDomains(vctx, resolved.scope, resolved.project);
      ownHosts = domains.map((d) => d.name.toLowerCase());
      if (!appUrl) {
        const domain = vc.pickProductionDomain(domains);
        if (domain && !domain.endsWith(".vercel.app")) {
          appUrl = `https://${domain}`;
        } else {
          // Befintlig APP_URL godtas bara om värden är en av projektets domäner.
          const existing = await vc.readEnvValue(
            vctx,
            resolved.scope,
            resolved.project,
            envEntries,
            "APP_URL",
            "production",
          );
          const host = existing
            ? /^https:\/\/([^/]+)$/.exec(existing)?.[1]?.toLowerCase()
            : undefined;
          if (existing && host && ownHosts.includes(host)) appUrl = existing;
          else if (domain) appUrl = `https://${domain}`;
        }
      }
    }
    if (!appUrl && resolved) {
      appUrl = `https://${resolved.project?.name ?? VERCEL_PROJECT_NAME}.vercel.app`;
      appUrlAssumed = true;
    }
    if (appUrl)
      log.info(
        `Appens adress i produktion: ${appUrl}${appUrlAssumed ? " (antagen tills första driftsättningen; skrivs inte in i Supabase förrän Vercel bekräftat den)" : ""}.`,
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
      const settings: sb.AuthSettings = { siteUrl: undefined, redirectUrls: [], smtp };
      if (env.target === "production") {
        Object.assign(settings, prodAuthUrls(appUrl, appUrlAssumed, ownHosts));
        if (appUrlAssumed) {
          log.info(
            `${env.ref}: Site URL och Redirect URLs sätts när Vercel gett projektet sin adress (efter första driftsättningen${wantVercel ? "" : ", i scripts/deploy/vercel.ts"}).`,
          );
        } else if (!appUrl) {
          log.manual(
            `${env.ref}: Site URL och Redirect URLs sattes inte (adressen är okänd). Kör med VERCEL_TOKEN eller --app-url.`,
          );
        }
      } else if (resolved) {
        // Utvecklingsprojektets site_url lämnas: appen skickar alltid redirect_to.
        settings.redirectUrls = [
          previewRedirect(resolved.project?.name ?? VERCEL_PROJECT_NAME, resolved.scope.slug),
        ];
        settings.dropRedirects = [legacyPreviewRedirect(resolved.scope.slug)];
      } else {
        log.manual(
          `${env.ref}: Redirect URLs för förhandsversionerna sattes inte (Vercel-teamet är okänt). Kör med VERCEL_TOKEN.`,
        );
      }
      await sb.configureAuth(sctx, env.ref, settings);
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
    let envResult: vc.EnvSyncResult = {
      changes: [],
      productionChanged: false,
      pendingBefore: false,
    };
    if (project) {
      // Produktionens CRON_SECRET finns också i Vault (pg_cron anropar /api/cron/awish med
      // den). Vault är källan: finns den där används samma värde i Vercel, annars skapas en
      // ny och skrivs först till Vault och sedan till Vercel.
      const prodCronSecret = prodEnv.ref
        ? await ensureVaultCronSecret(sctx, prodEnv.ref, deps)
        : undefined;
      const desired: vc.DesiredVar[] = [];
      for (const env of envs) {
        desired.push(
          ...(await desiredVars(env, {
            sctx,
            deps,
            options,
            appUrl,
            has: (key) => vc.hasEnv(envEntries, key, env.target),
            cronSecret: env.target === "production" ? prodCronSecret : undefined,
          })),
        );
      }
      envResult = await vc.syncEnv(vctx, scope, project, desired, { markPending: regionChanged });
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
        envResult.pendingBefore &&
          "tidigare ändringar har inte nått en färdig version (förra driftsättningen misslyckades eller hoppades över)",
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
        // Adressen var antagen: nu har Vercel gett projektet en domän.
        if (appUrlAssumed && !options.appUrl) {
          const domain = await vc.productionDomain(vctx, scope, project);
          if (domain) {
            if (`https://${domain}` !== appUrl) {
              log.warn(
                `Produktionsadressen blev https://${domain}, inte ${appUrl}. Rättar APP_URL och driftsätter igen.`,
              );
              appUrl = `https://${domain}`;
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
            appUrlAssumed = false;
          }
        }
        await vc.markProductionDeployed(vctx, scope, project);
      }
    }

    // Produktionens adresser i Supabase Auth: alltid här (även när bara
    // vercel.ts körs), och bara med en adress som Vercel bekräftat.
    if (project && prodEnv.ref) {
      log.step("Supabase: produktionens adresser");
      const domains = await vc.listDomains(vctx, scope, project);
      const hosts = domains.map((d) => d.name.toLowerCase());
      const domain = vc.pickProductionDomain(domains);
      if (appUrlAssumed && domain) {
        appUrl = `https://${domain}`;
        appUrlAssumed = false;
      }
      await sb.configureAuth(sctx, prodEnv.ref, {
        ...prodAuthUrls(appUrl, appUrlAssumed, hosts),
        smtp: null,
      });
      if (appUrlAssumed) {
        if (dryRun) {
          log.plan(
            `sätta Site URL och Redirect URLs i ${prodEnv.ref} när driftsättningen gett projektet sin adress`,
          );
        } else {
          log.manual(
            `${prodEnv.ref}: Site URL och Redirect URLs är inte satta (projektet har ingen produktionsdomän än). Kör scripts/deploy/vercel.ts igen efter en lyckad driftsättning.`,
          );
        }
      }
    } else if (!project && prodEnv.ref) {
      log.plan(`sätta Site URL och Redirect URLs i ${prodEnv.ref} efter första driftsättningen`);
    }

    // Awish-synken: pg_cron läser appens adress ur Vault (bara en adress som Vercel bekräftat).
    if (project && prodEnv.ref) {
      log.step("Supabase: Awish-synken (pg_cron)");
      if (appUrl && !appUrlAssumed) {
        await sb.upsertVaultSecret(sctx, prodEnv.ref, sb.VAULT_APP_URL, appUrl);
      } else {
        log.manual(
          `${prodEnv.ref}: ${sb.VAULT_APP_URL} sattes inte i Vault (adressen är inte bekräftad). Kör scripts/deploy/vercel.ts igen efter en lyckad driftsättning.`,
        );
      }
      if (!(await sb.hasAwishCronJob(sctx, prodEnv.ref))) {
        log.manual(
          `${prodEnv.ref}: pg_cron-jobbet ${sb.AWISH_CRON_JOB} saknas (pg_cron eller pg_net är inte påslaget). Slå på båda under Database → Extensions och kör migreringen 20261103090000_awish_api.sql igen, eller anropa /api/cron/awish från en annan schemaläggare var tionde minut.`,
        );
      } else {
        log.ok(`${prodEnv.ref}: Awish-synken körs var tionde minut (pg_cron).`);
      }
    }

    if (project && !options.skipDeploy && !dryRun && appUrl) {
      const check = await vc.checkSite(vctx, appUrl);
      siteOk = check.ok;
      if (!siteOk) {
        log.info(
          "Rätta felet ovan och kör samma kommando igen. Stämmer variablerna redan men en gammal version körs: lägg till --force-deploy.",
        );
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

/**
 * Produktionens adresser i Supabase Auth. En antagen adress skrivs aldrig in;
 * med kända värdar rensas främmande *.vercel.app-poster (och site_url).
 */
function prodAuthUrls(
  appUrl: string | undefined,
  assumed: boolean,
  ownHosts: readonly string[] | undefined,
): Pick<sb.AuthSettings, "siteUrl" | "redirectUrls" | "ownVercelHosts"> {
  const trusted = appUrl && !assumed ? appUrl : undefined;
  return {
    siteUrl: trusted,
    redirectUrls: trusted ? [`${trusted}/**`] : [],
    ownVercelHosts: ownHosts,
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
    /** Känt CRON_SECRET (produktionen, ur Vault). Annars genereras det om det saknas. */
    cronSecret?: string;
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
        {
          key: "SUPABASE_SECRET_KEY",
          target: t,
          sensitive: true,
          exclusive: true,
          value: env.keys.secret,
        },
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
    // Vart DATABASE_URL pekar (inget hemligt). Bokförs i BINDERLAB_DEPLOY_STATE,
    // så att en känslig adress mot fel projekt eller fel pooler aldrig behålls.
    const tag = `${ref}@${pooler.host}`;
    if (env.dbPassword) {
      out.push({
        key: "DATABASE_URL",
        target: t,
        sensitive: true,
        exclusive: true,
        tag,
        value: sb.databaseUrl(pooler, env.dbPassword),
      });
    } else {
      out.push({
        key: "DATABASE_URL",
        target: t,
        sensitive: true,
        exclusive: true,
        tag,
        accept,
        generate: async () => {
          // Lösenordet är okänt (projektet fanns redan): byt det och bygg adressen.
          if (env.target === "preview" && !c.options.rotateDevPassword) {
            c.sctx.log.manual(
              `DATABASE_URL för Preview (utvecklingsprojektet ${ref}) sattes inte: databaslösenordet är okänt för skriptet. ` +
                `Kör igen med SUPABASE_DEV_DB_PASSWORD=<lösenordet> i miljön, eller med --byt-dev-losenord för att byta det ` +
                `(då slutar GitHub-hemligheten för "Migrera databasen" och lokala .env-filer med det gamla lösenordet att fungera).`,
            );
            return undefined;
          }
          const password = c.sctx.log.secret(c.deps.generatePassword());
          c.sctx.log.warn(
            env.target === "preview"
              ? `Databaslösenordet i utvecklingsprojektet ${ref} byts (--byt-dev-losenord). Uppdatera GitHub-hemligheten DATABASE_URL (development) och lokala .env-filer.`
              : `Databaslösenordet i produktionsprojektet ${ref} byts (det gamla är okänt för skriptet). Används GitHub-hemligheten DATABASE_URL (production) måste den bytas.`,
          );
          await sb.setDatabasePassword(c.sctx, ref, password);
          return sb.databaseUrl(pooler, password);
        },
      });
    }
  }
  out.push(
    c.cronSecret
      ? { key: "CRON_SECRET", target: t, sensitive: true, value: c.cronSecret }
      : { key: "CRON_SECRET", target: t, sensitive: true, generate: c.deps.generateCronSecret },
  );

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

/**
 * CRON_SECRET för produktionen ur Vault (binderlab_cron_secret), eller ett nytt som
 * skrivs dit. Vercel-värdet sätts sedan till samma (känsliga variabler går inte att
 * läsa tillbaka ur Vercel, så Vault är det enda stället där värdet kan läsas).
 */
async function ensureVaultCronSecret(
  sctx: sb.Ctx,
  ref: string,
  deps: Deps,
): Promise<string | undefined> {
  sctx.log.step("Supabase: CRON_SECRET i Vault");
  const existing = await sb.readVaultSecret(sctx, ref, sb.VAULT_CRON_SECRET);
  if (existing && existing.length >= 16) {
    sctx.log.ok(`${ref}: ${sb.VAULT_CRON_SECRET} finns i Vault; samma värde används i Vercel.`);
    return existing;
  }
  const fresh = sctx.log.secret(deps.generateCronSecret());
  await sb.upsertVaultSecret(sctx, ref, sb.VAULT_CRON_SECRET, fresh);
  return sctx.dryRun ? undefined : fresh;
}
