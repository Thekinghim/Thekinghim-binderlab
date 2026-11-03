/**
 * Supabase Management API (https://api.supabase.com/v1) och projektets egna
 * API:er (Auth admin, Storage). Varje funktion är idempotent: den läser
 * först och ändrar bara det som skiljer sig. I dry-run ändras ingenting;
 * stegen skriver i stället vad de skulle göra (`log.plan`).
 *
 * Endpoints som inte kunnat provas härifrån är märkta OSÄKER här och i
 * docs/driftsattning.md.
 */

import { createHash } from "node:crypto";

import type { MigrationFile } from "../../../src/db/migrator";
import {
  ApiError,
  createApiClient,
  isTransient,
  type ApiClient,
  type FetchLike,
  type Sleep,
} from "./http";
import type { Logger } from "./log";
import { scramSha256Verifier } from "./secrets";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export interface SupabaseProject {
  id: string;
  ref?: string;
  name: string;
  organization_id?: string;
  organization_slug?: string;
  region?: string;
  status?: string;
}

export function projectRef(project: SupabaseProject): string {
  return project.ref ?? project.id;
}

export function projectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}

export function jwksUrl(ref: string): string {
  return `${projectUrl(ref)}/auth/v1/.well-known/jwks.json`;
}

export interface ApiKeys {
  publishable: string;
  secret: string;
}

export interface Ctx {
  api: ApiClient;
  log: Logger;
  dryRun: boolean;
  sleep: Sleep;
  /** Rå fetch för projektets egna API:er (Auth, Storage, JWKS). */
  fetch: FetchLike;
  now?: () => number;
}

const READY = "ACTIVE_HEALTHY";
const FAILED = new Set(["INIT_FAILED", "REMOVED", "RESTORE_FAILED", "PAUSE_FAILED", "GOING_DOWN"]);

// ---------------------------------------------------------------------------
// Projekt
// ---------------------------------------------------------------------------

export async function listProjects(ctx: Ctx): Promise<SupabaseProject[]> {
  const { data } = await ctx.api.get<SupabaseProject[]>("/v1/projects");
  if (!Array.isArray(data)) {
    throw new Error("Supabase: /v1/projects svarade inte med en lista.");
  }
  return data;
}

export function findDevProject(projects: SupabaseProject[], ref: string): SupabaseProject {
  const found = projects.find((p) => projectRef(p) === ref);
  if (!found) {
    throw new Error(
      `Supabase: utvecklingsprojektet ${ref} finns inte bland projekten som SUPABASE_ACCESS_TOKEN ser ` +
        `(${projects.map((p) => projectRef(p)).join(", ") || "inga"}). Skapa token som en medlem i projektets organisation.`,
    );
  }
  return found;
}

/** Organisationens id och slug som ett projekt bär (det ena eller båda). */
export function projectOrgIds(project: SupabaseProject): string[] {
  return [project.organization_id, project.organization_slug].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/**
 * Vilka organisations-id:n produktionsprojektet får ligga i: den angivna
 * (--supabase-org) eller utvecklingsprojektets. Är den angivna samma
 * organisation som utvecklingsprojektets räknas både id och slug.
 */
export function allowedOrgIds(dev: SupabaseProject, requested: string | undefined): string[] {
  const devIds = projectOrgIds(dev);
  if (!requested) return devIds;
  return devIds.includes(requested) ? devIds : [requested];
}

export interface ProdSelection {
  /** Projektet med rätt namn i rätt organisation. */
  match: SupabaseProject | undefined;
  /** Projekt med samma namn i en annan (eller okänd) organisation. */
  foreign: SupabaseProject[];
}

/**
 * Letar upp produktionsprojektet på namn OCH organisation. Ett projekt med
 * samma namn i en annan organisation som token råkar se används aldrig
 * (då skulle migreringar, nycklar och Vercel-variabler gå dit); det ger ett
 * fel. Finns flera med samma namn i rätt organisation avbryts det också.
 */
export function selectProdProject(
  projects: readonly SupabaseProject[],
  name: string,
  orgIds: readonly string[],
): ProdSelection {
  const named = projects.filter((p) => p.name === name && p.status !== "REMOVED");
  const mine = named.filter((p) => projectOrgIds(p).some((id) => orgIds.includes(id)));
  const foreign = named.filter((p) => !mine.includes(p));
  if (mine.length > 1) {
    throw new Error(
      `Supabase: flera projekt heter ${name} (${mine.map(projectRef).join(", ")}). Ta bort eller byt namn på de överflödiga.`,
    );
  }
  return { match: mine[0], foreign };
}

export function assertNoForeignProd(
  selection: ProdSelection,
  name: string,
  orgIds: readonly string[],
): void {
  if (selection.foreign.length === 0) return;
  const list = selection.foreign
    .map((p) => `${projectRef(p)} i ${projectOrgIds(p).join("/") || "okänd organisation"}`)
    .join(", ");
  throw new Error(
    `Supabase: ${name} finns i en annan organisation än den som ska användas (${orgIds.join("/") || "okänd"}): ${list}. ` +
      `Det används inte som produktion. Byt namn på det projektet, eller ange --supabase-org <organisation> om det är rätt organisation.`,
  );
}

export interface EnsureProdResult {
  project: SupabaseProject | null;
  created: boolean;
  /** Bara när projektet skapades nu (annars okänt). Skrivs aldrig ut. */
  dbPassword?: string;
}

/**
 * Hittar produktionsprojektet på namn i rätt organisation, eller skapar det i
 * regionen med ett genererat lösenord. Finns det i en annan organisation,
 * eller flera med samma namn, avbryts det.
 *
 * Skapandet görs aldrig om automatiskt (ett POST som får 5xx eller tappar
 * anslutningen kan ändå ha skapat projektet). I stället läses listan om; dyker
 * projektet upp används det, med lösenordet som just skickades.
 */
export async function ensureProdProject(
  ctx: Ctx,
  projects: SupabaseProject[],
  opts: {
    name: string;
    region: string;
    organization: string;
    orgIds: readonly string[];
    password: () => string;
    recoverPolls?: number;
    recoverIntervalMs?: number;
  },
): Promise<EnsureProdResult> {
  const selection = selectProdProject(projects, opts.name, opts.orgIds);
  assertNoForeignProd(selection, opts.name, opts.orgIds);
  const existing = selection.match;
  if (existing) {
    if (existing.region && existing.region !== opts.region) {
      ctx.log.warn(
        `Produktionsprojektet ${projectRef(existing)} ligger i ${existing.region}, inte ${opts.region}. Det används ändå.`,
      );
    }
    ctx.log.ok(`Produktionsprojektet finns: ${opts.name} (${projectRef(existing)}).`);
    return { project: existing, created: false };
  }
  if (ctx.dryRun) {
    ctx.log.plan(
      `skapa Supabase-projektet ${opts.name} i ${opts.region} (organisation ${opts.organization}) med ett genererat databaslösenord`,
    );
    return { project: null, created: false };
  }
  const password = ctx.log.secret(opts.password());
  const base = { name: opts.name, db_pass: password, region: opts.region };
  const create = async (orgField: "organization_id" | "organization_slug") => {
    try {
      return (
        await ctx.api.request<SupabaseProject>("POST", "/v1/projects", {
          body: { ...base, [orgField]: opts.organization },
        })
      ).data;
    } catch (error) {
      if (!isTransient(error)) throw error;
      // Kan ha skapats trots felet: läs om listan i stället för att skapa igen.
      const polls = opts.recoverPolls ?? 6;
      for (let i = 0; i < polls; i += 1) {
        await ctx.sleep(opts.recoverIntervalMs ?? 10_000);
        const again = selectProdProject(await listProjects(ctx), opts.name, opts.orgIds);
        if (again.match) {
          ctx.log.warn(
            `POST /v1/projects svarade med fel, men ${opts.name} (${projectRef(again.match)}) skapades ändå. Det används.`,
          );
          return again.match;
        }
      }
      throw new Error(
        `${(error as Error).message}\nProjektet syns inte i listan efter felet. Kontrollera i Supabase-panelen att inget ${opts.name} ` +
          `håller på att skapas innan du kör igen (annars kan det bli två).`,
      );
    }
  };
  let created: SupabaseProject;
  try {
    created = await create("organization_id");
  } catch (error) {
    // OSÄKER: nyare versioner av API:t vill ha organization_slug.
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      /slug/i.test(error.apiMessage)
    ) {
      created = await create("organization_slug");
    } else if (error instanceof ApiError && /limit|maximum|free/i.test(error.apiMessage)) {
      throw new Error(
        `${error.message}\nOrganisationen har troligen nått gränsen för antal gratisprojekt. Uppgradera planen eller pausa ett projekt i Supabase och kör igen.`,
      );
    } else {
      throw error;
    }
  }
  ctx.log.ok(`Skapade ${opts.name} (${projectRef(created)}) i ${opts.region}.`);
  return { project: created, created: true, dbPassword: password };
}

/** Väntar tills projektet är ACTIVE_HEALTHY och tjänsterna svarar. Väcker ett pausat projekt. */
export async function waitForProject(
  ctx: Ctx,
  ref: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<SupabaseProject> {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const intervalMs = opts.intervalMs ?? 10_000;
  let waited = 0;
  let restored = false;
  let lastStatus = "";
  for (;;) {
    const { data } = await ctx.api.get<SupabaseProject>(`/v1/projects/${ref}`);
    const status = data.status ?? "UNKNOWN";
    if (status === READY) break;
    if (FAILED.has(status)) {
      throw new Error(`Supabase: projektet ${ref} har status ${status}. Se Supabase-panelen.`);
    }
    if (status === "INACTIVE" && !restored) {
      if (ctx.dryRun) {
        ctx.log.plan(`väcka det pausade projektet ${ref} (POST /v1/projects/${ref}/restore)`);
        return data;
      }
      // OSÄKER: restore-endpointen för pausade gratisprojekt.
      await ctx.api.request("POST", `/v1/projects/${ref}/restore`, { body: {} });
      ctx.log.info(`Projektet ${ref} var pausat; återställning startad.`);
      restored = true;
    }
    if (ctx.dryRun) {
      ctx.log.info(`Projektet ${ref} har status ${status} (dry-run väntar inte).`);
      return data;
    }
    if (status !== lastStatus) {
      ctx.log.info(`Väntar på ${ref}: ${status} …`);
      lastStatus = status;
    }
    if (waited >= timeoutMs) {
      throw new Error(
        `Supabase: ${ref} blev inte klart inom ${Math.round(timeoutMs / 60_000)} minuter (status ${status}).`,
      );
    }
    await ctx.sleep(intervalMs);
    waited += intervalMs;
  }
  // Tjänsterna kan komma upp en stund efter att projektet blivit ACTIVE_HEALTHY.
  for (let i = 0; i < 30; i += 1) {
    const { status, data } = await ctx.api.get<
      { name: string; healthy?: boolean; status?: string }[]
    >(`/v1/projects/${ref}/health?services=auth&services=db&services=rest&services=storage`, {
      allow: [400, 404],
    });
    if (status !== 200 || !Array.isArray(data)) break;
    const sick = data.filter((s) => s.healthy === false);
    if (sick.length === 0) break;
    if (ctx.dryRun) break;
    if (i === 0) ctx.log.info(`Väntar på tjänsterna: ${sick.map((s) => s.name).join(", ")} …`);
    await ctx.sleep(intervalMs);
  }
  const { data } = await ctx.api.get<SupabaseProject>(`/v1/projects/${ref}`);
  ctx.log.ok(`Projektet ${ref} är klart.`);
  return data;
}

// ---------------------------------------------------------------------------
// API-nycklar
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id?: string;
  name?: string;
  type?: string | null;
  api_key?: string | null;
}

function isMasked(value: string): boolean {
  return /[•*·]/.test(value) || value.length < 20;
}

/**
 * Hämtar publishable- och secret-nyckeln (`sb_publishable_…`, `sb_secret_…`).
 * Saknas någon skapas den. Returnerar null i dry-run om något skulle skapas.
 */
export async function ensureApiKeys(ctx: Ctx, ref: string): Promise<ApiKeys | null> {
  const read = async () =>
    (await ctx.api.get<ApiKeyRow[]>(`/v1/projects/${ref}/api-keys`, { query: { reveal: true } }))
      .data;
  let rows = await read();
  if (!Array.isArray(rows))
    throw new Error(`Supabase: api-keys för ${ref} svarade inte med en lista.`);
  const pick = (type: "publishable" | "secret") =>
    rows.find((r) => r.type === type && r.name === "binderlab" && r.api_key) ??
    rows.find((r) => r.type === type && r.name === "default" && r.api_key) ??
    rows.find((r) => r.type === type && r.api_key);
  const missing = (["publishable", "secret"] as const).filter((t) => !pick(t));
  if (missing.length > 0) {
    if (ctx.dryRun) {
      ctx.log.plan(`skapa ${missing.join(" och ")}-nyckel i ${ref}`);
      return null;
    }
    for (const type of missing) {
      await ctx.api.request("POST", `/v1/projects/${ref}/api-keys`, {
        body:
          type === "secret"
            ? {
                type,
                name: "binderlab",
                description: "Binderlab (Vercel, servern)",
                secret_jwt_template: { role: "service_role" },
              }
            : { type, name: "binderlab", description: "Binderlab (webbläsaren)" },
      });
      ctx.log.ok(`Skapade ${type}-nyckel i ${ref}.`);
    }
    rows = await read();
  }
  const publishable = pick("publishable")?.api_key;
  const secret = pick("secret")?.api_key;
  if (!publishable || !secret) {
    throw new Error(`Supabase: kunde inte läsa publishable/secret-nyckeln för ${ref}.`);
  }
  ctx.log.secret(secret);
  if (isMasked(secret) || !secret.startsWith("sb_secret_")) {
    throw new Error(
      `Supabase: secret-nyckeln för ${ref} kom maskerad. Token saknar troligen rätt att visa nycklar (kräver ägare/admin).`,
    );
  }
  if (!publishable.startsWith("sb_publishable_")) {
    throw new Error(`Supabase: publishable-nyckeln för ${ref} har oväntat format.`);
  }
  ctx.log.ok(`API-nycklar hämtade för ${ref} (publishable och secret).`);
  return { publishable, secret };
}

// ---------------------------------------------------------------------------
// Databasen: pooler och lösenord
// ---------------------------------------------------------------------------

export interface Pooler {
  host: string;
  user: string;
  database: string;
}

/** Poolerns adress (Supavisor). Faller tillbaka på det kända mönstret. */
export async function getPooler(
  ctx: Ctx,
  ref: string,
  region: string | undefined,
): Promise<Pooler> {
  const { status, data } = await ctx.api.get<
    { database_type?: string; db_host?: string; db_user?: string; db_name?: string }[]
  >(`/v1/projects/${ref}/config/database/pooler`, { allow: [404] });
  const primary = Array.isArray(data)
    ? (data.find((p) => p.database_type === "PRIMARY") ?? data[0])
    : undefined;
  if (status === 200 && primary?.db_host) {
    const user =
      primary.db_user && primary.db_user.includes(".") ? primary.db_user : `postgres.${ref}`;
    return { host: primary.db_host, user, database: primary.db_name || "postgres" };
  }
  const fallback = `aws-0-${region ?? "eu-north-1"}.pooler.supabase.com`;
  ctx.log.warn(`Hittade inte poolerns adress för ${ref}; använder ${fallback}.`);
  return { host: fallback, user: `postgres.${ref}`, database: "postgres" };
}

/** DATABASE_URL för Vercel: poolern i transaktionsläge (port 6543). */
export function databaseUrl(pooler: Pooler, password: string): string {
  return `postgresql://${pooler.user}:${encodeURIComponent(password)}@${pooler.host}:6543/${pooler.database}`;
}

/** Kör SQL via Management API. Returnerar raderna från sista satsen. */
export async function runQuery<T = Record<string, unknown>>(
  ctx: Ctx,
  ref: string,
  query: string,
): Promise<T[]> {
  const { data } = await ctx.api.request<T[] | { result?: T[] }>(
    "POST",
    `/v1/projects/${ref}/database/query`,
    // Tål att göras om: migreringarna skyddas av kontrollen "redan körd",
    // bokföringen och lösenordsbytet ger samma resultat två gånger.
    { body: { query }, idempotent: true, timeoutMs: 10 * 60_000 },
  );
  if (Array.isArray(data)) {
    // Ett svar per sats (som postgres.js ger) eller bara sista satsens rader.
    if (data.length > 0 && data.every((r) => Array.isArray(r))) {
      return data[data.length - 1] as unknown as T[];
    }
    return data;
  }
  if (data && typeof data === "object" && Array.isArray((data as { result?: T[] }).result)) {
    return (data as { result: T[] }).result;
  }
  return [];
}

/**
 * Byter lösenordet för rollen postgres. Skickar bara en SCRAM-verifierare,
 * så att klartexten aldrig finns i SQL:en eller i Postgres loggar.
 * OSÄKER: att Supavisor tar det nya lösenordet direkt (det gör den enligt
 * dokumentationen eftersom den läser pg_authid via auth_query).
 */
export async function setDatabasePassword(ctx: Ctx, ref: string, password: string): Promise<void> {
  ctx.log.secret(password);
  if (ctx.dryRun) {
    ctx.log.plan(`byta databaslösenordet för postgres i ${ref} (okänt sedan tidigare)`);
    return;
  }
  // Management API:t byter lösenordet som superanvändare; `alter role` som
  // postgres nekas i nyare projekt ("Only superusers can alter privileged roles").
  const viaApi = await ctx.api.request("PATCH", `/v1/projects/${ref}/database/password`, {
    body: { password },
    allow: [404, 405],
  });
  if (viaApi.status >= 200 && viaApi.status < 300) {
    ctx.log.ok(`Nytt databaslösenord satt i ${ref} (via Management API).`);
    return;
  }
  const verifier = scramSha256Verifier(password);
  await runQuery(ctx, ref, `alter role postgres with password '${verifier}';`);
  ctx.log.ok(
    `Nytt databaslösenord satt i ${ref} (skickades som SCRAM-verifierare, aldrig i klartext).`,
  );
}

// ---------------------------------------------------------------------------
// Auth-konfiguration
// ---------------------------------------------------------------------------

export const INVITE_SUBJECT = "Du är inbjuden till Binderlab";
export const MAGIC_LINK_SUBJECT = "Din inloggningslänk till Binderlab";

function mailTemplate(
  heading: string,
  text: string,
  button: string,
  type: "invite" | "magiclink",
): string {
  const href = `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${type}`;
  return [
    `<h2>${heading}</h2>`,
    `<p>${text}</p>`,
    `<p><a href="${href}">${button}</a></p>`,
    `<p>Länken gäller en gång och en kort tid. Har du inte bett om den kan du bortse från mejlet.</p>`,
  ].join("\n");
}

export const INVITE_TEMPLATE = mailTemplate(
  "Du är inbjuden till Binderlab",
  "Du har bjudits in till Binderlab, kontrollpanelen för varuautomaterna. Tryck på knappen för att ta emot inbjudan.",
  "Ta emot inbjudan",
  "invite",
);

export const MAGIC_LINK_TEMPLATE = mailTemplate(
  "Logga in i Binderlab",
  "Tryck på knappen för att logga in. Öppna länken i samma webbläsare som du begärde den i.",
  "Logga in",
  "magiclink",
);

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  adminEmail: string;
  senderName: string;
}

/** Resend som SMTP för Supabase Auth, om RESEND_API_KEY och MAIL_FROM finns. */
export function resendSmtp(passthrough: Record<string, string>): SmtpSettings | null {
  const key = passthrough.RESEND_API_KEY;
  const from = passthrough.MAIL_FROM;
  if (!key || !from) return null;
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(from);
  const address = (match?.[2] ?? from).trim();
  const name = (match?.[1] ?? "").trim() || "Binderlab";
  return {
    host: "smtp.resend.com",
    port: 465,
    user: "resend",
    pass: key,
    adminEmail: address,
    senderName: name,
  };
}

export const DEFAULT_SITE_URL = "http://localhost:3000";

export interface AuthSettings {
  /** site_url. undefined = rör inte (utöver rensningen nedan). */
  siteUrl: string | undefined;
  /** Adresser som läggs till i uri_allow_list (andra befintliga behålls, utom nedan). */
  redirectUrls: readonly string[];
  /** Exakta poster som tas bort ur uri_allow_list (t.ex. äldre mönster skriptet satt). */
  dropRedirects?: readonly string[];
  /**
   * Produktionens egna *.vercel.app-värdar (alla domäner Vercel-projektet har).
   * När den är satt tas varje post i uri_allow_list vars värd slutar på
   * .vercel.app och inte är en av dessa bort (även jokertecken), och en
   * site_url på en sådan främmande värd återställs. Annars kan en domän som
   * någon annan äger få inloggningslänkarnas engångskod.
   */
  ownVercelHosts?: readonly string[];
  smtp: SmtpSettings | null;
}

function hostOf(entry: string): string | undefined {
  return /^https?:\/\/([^/?#]+)/i.exec(entry.trim())?.[1]?.toLowerCase();
}

/** Är adressen (eller mönstret) på en *.vercel.app-värd som inte är projektets? */
export function isForeignVercelEntry(entry: string, ownHosts: readonly string[]): boolean {
  const host = hostOf(entry);
  if (!host || !host.endsWith(".vercel.app")) return false;
  return host.includes("*") || !ownHosts.map((h) => h.toLowerCase()).includes(host);
}

export function desiredAuthConfig(
  current: Record<string, unknown>,
  settings: AuthSettings,
): Record<string, unknown> {
  const existing = typeof current.uri_allow_list === "string" ? current.uri_allow_list : "";
  const own = settings.ownVercelHosts;
  const drop = new Set(settings.dropRedirects ?? []);
  const list = existing
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((entry) => !drop.has(entry))
    .filter(
      (entry) => settings.redirectUrls.includes(entry) || !own || !isForeignVercelEntry(entry, own),
    );
  for (const url of settings.redirectUrls) if (!list.includes(url)) list.push(url);
  const desired: Record<string, unknown> = {
    disable_signup: true,
    mailer_autoconfirm: false,
    external_email_enabled: true,
    uri_allow_list: list.join(","),
  };
  // Supabase Free tillåter inte egna mallar med den inbyggda e-posten. Utan
  // SMTP används standardmallen; appen tar då emot `?code=` (PKCE) i
  // /logga-in/bekrafta.
  if (settings.smtp) {
    desired.mailer_subjects_invite = INVITE_SUBJECT;
    desired.mailer_templates_invite_content = INVITE_TEMPLATE;
    desired.mailer_subjects_magic_link = MAGIC_LINK_SUBJECT;
    desired.mailer_templates_magic_link_content = MAGIC_LINK_TEMPLATE;
  }
  const currentSite = typeof current.site_url === "string" ? current.site_url : "";
  if (settings.siteUrl) {
    desired.site_url = settings.siteUrl;
  } else if (own && currentSite && isForeignVercelEntry(currentSite, own)) {
    // En främmande site_url får inte ligga kvar: den är standardadressen i mejlens länkar.
    desired.site_url = DEFAULT_SITE_URL;
  }
  if (settings.smtp) {
    desired.smtp_host = settings.smtp.host;
    desired.smtp_port = String(settings.smtp.port);
    desired.smtp_user = settings.smtp.user;
    desired.smtp_pass = settings.smtp.pass;
    desired.smtp_admin_email = settings.smtp.adminEmail;
    desired.smtp_sender_name = settings.smtp.senderName;
  }
  return desired;
}

/** Fälten som skiljer sig (smtp_pass jämförs inte, API:t visar det inte). */
export function authConfigDiff(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    const now = current[key];
    if (key === "smtp_pass") {
      if (
        current.smtp_host !== desired.smtp_host ||
        current.smtp_user !== desired.smtp_user ||
        !now
      ) {
        patch[key] = value;
      }
      continue;
    }
    if (key === "smtp_port" ? String(now ?? "") !== String(value) : now !== value) {
      patch[key] = value;
    }
  }
  if (patch.smtp_host !== undefined || patch.smtp_user !== undefined)
    patch.smtp_pass = desired.smtp_pass;
  return patch;
}

export async function configureAuth(
  ctx: Ctx,
  ref: string,
  settings: AuthSettings,
): Promise<boolean> {
  if (settings.smtp) ctx.log.secret(settings.smtp.pass);
  const { data: current } = await ctx.api.get<Record<string, unknown>>(
    `/v1/projects/${ref}/config/auth`,
  );
  const patch = authConfigDiff(current ?? {}, desiredAuthConfig(current ?? {}, settings));
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    ctx.log.ok(`Auth-inställningarna i ${ref} är redan rätt.`);
    return false;
  }
  if (ctx.dryRun) {
    ctx.log.plan(`ändra auth i ${ref}: ${keys.join(", ")}`);
    return true;
  }
  await ctx.api.request("PATCH", `/v1/projects/${ref}/config/auth`, { body: patch });
  ctx.log.ok(`Auth i ${ref} uppdaterad: ${keys.join(", ")}.`);
  return true;
}

// ---------------------------------------------------------------------------
// JWT-signeringsnycklar (asymmetriska)
// ---------------------------------------------------------------------------

interface SigningKey {
  id: string;
  algorithm?: string;
  status?: string;
}

const ASYMMETRIC = new Set(["ES256", "RS256", "EdDSA"]);

/**
 * Ser till att projektet signerar åtkomsttoken med en asymmetrisk nyckel
 * (ES256), så att JWKS kan verifiera dem. OSÄKER: signing-keys-endpointsen.
 * Returnerar "manual" om API:t inte stöder det; då skrivs vad som ska göras.
 */
export async function ensureAsymmetricJwt(
  ctx: Ctx,
  ref: string,
): Promise<"ok" | "changed" | "manual"> {
  const manual = (why: string) => {
    ctx.log.manual(
      `${ref}: ${why} Gör i Supabase → Project Settings → JWT Keys: "Migrate JWT secret", skapa en ES256-nyckel och "Rotate keys" så att den blir "In use".`,
    );
    return "manual" as const;
  };
  const list = async () => {
    const { status, data } = await ctx.api.get<SigningKey[] | { keys?: SigningKey[] }>(
      `/v1/projects/${ref}/config/auth/signing-keys`,
      { allow: [400, 403, 404] },
    );
    if (status !== 200) return null;
    return Array.isArray(data) ? data : (data?.keys ?? []);
  };
  let keys = await list();
  if (keys === null) return manual("API:t för signeringsnycklar svarade inte.");
  const inUse = keys.find((k) => k.status === "in_use");
  if (inUse && ASYMMETRIC.has(inUse.algorithm ?? "")) {
    ctx.log.ok(`${ref} signerar redan med ${inUse.algorithm}.`);
    return "ok";
  }
  if (ctx.dryRun) {
    ctx.log.plan(
      `byta ${ref} till en ES256-signeringsnyckel (nu: ${inUse?.algorithm ?? "äldre JWT-hemlighet"})`,
    );
    return "changed";
  }
  try {
    if (keys.length === 0) {
      // Den äldre HS256-hemligheten flyttas in som nyckel innan en ny kan roteras in.
      await ctx.api.request("POST", `/v1/projects/${ref}/config/auth/signing-keys/legacy`, {
        body: {},
      });
      keys = (await list()) ?? [];
    }
    let standby = keys.find((k) => k.status === "standby" && ASYMMETRIC.has(k.algorithm ?? ""));
    if (!standby) {
      const { data } = await ctx.api.request<SigningKey>(
        "POST",
        `/v1/projects/${ref}/config/auth/signing-keys`,
        { body: { algorithm: "ES256", status: "standby" } },
      );
      standby = data;
    }
    if (!standby?.id) return manual("Ny signeringsnyckel kunde inte skapas.");
    await ctx.api.request("PATCH", `/v1/projects/${ref}/config/auth/signing-keys/${standby.id}`, {
      body: { status: "in_use" },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      return manual(`API:t nekade bytet (${error.status}: ${error.apiMessage}).`);
    }
    throw error;
  }
  ctx.log.ok(`${ref} signerar nu med ES256 (gamla token gäller tills de går ut).`);
  return "changed";
}

/** Kontrollerar att JWKS har minst en asymmetrisk nyckel. */
export async function checkJwks(ctx: Ctx, ref: string): Promise<boolean> {
  try {
    const response = await ctx.fetch(jwksUrl(ref), { headers: { accept: "application/json" } });
    const body = (await response.json().catch(() => ({}))) as { keys?: { kty?: string }[] };
    const ok =
      response.ok &&
      (body.keys ?? []).some((k) => k.kty === "EC" || k.kty === "RSA" || k.kty === "OKP");
    if (ok) ctx.log.ok(`JWKS för ${ref} har en asymmetrisk nyckel.`);
    else
      ctx.log.warn(
        `JWKS för ${ref} saknar asymmetrisk nyckel; inloggningen fungerar inte förrän den finns.`,
      );
    return ok;
  } catch {
    ctx.log.warn(`JWKS för ${ref} kunde inte hämtas (${jwksUrl(ref)}).`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Migreringar
// ---------------------------------------------------------------------------

/** Samma nyckel som src/db/migrator.ts (pg_advisory_lock). */
export const MIGRATION_LOCK_KEY = 7_342_001;
const ALREADY_APPLIED = "binderlab: migreringen är redan körd";

export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

/** En dollar-quote-tagg som inte förekommer i texten. */
export function dollarTag(text: string): string {
  for (let i = 0; ; i += 1) {
    const tag = `$bl_mig${i === 0 ? "" : i}$`;
    if (!text.includes(tag)) return tag;
  }
}

export const BOOKKEEPING_SQL = `create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);
select version, md5(coalesce(statements[1], '')) as hash, coalesce(array_length(statements, 1), 0) as n
  from supabase_migrations.schema_migrations order by version;`;

/**
 * En migrering som en enda fråga. Flera satser i samma fråga körs av
 * Postgres som EN transaktion (enkla frågeprotokollet), så filen och
 * bokföringen går igenom tillsammans eller inte alls; ett fel lämnar inget
 * halvfärdigt. Låset och kontrollen gör att två samtidiga körningar inte
 * kör samma fil två gånger.
 */
export function migrationQuery(m: MigrationFile): string {
  if (!/^\d{14}$/.test(m.version) || !/^[a-z0-9_]+$/.test(m.name)) {
    throw new Error(`Ogiltigt migreringsnamn: ${m.file}`);
  }
  const tag = dollarTag(m.sql);
  return [
    `select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY}::bigint);`,
    `do $bl_chk$ begin if exists (select 1 from supabase_migrations.schema_migrations where version = '${m.version}') then raise exception '${ALREADY_APPLIED}'; end if; end $bl_chk$;`,
    m.sql,
    ";",
    `insert into supabase_migrations.schema_migrations (version, name, statements) values ('${m.version}', '${m.name}', array[${tag}${m.sql}${tag}]);`,
  ].join("\n");
}

export interface MigrationResult {
  applied: string[];
  skipped: number;
  changed: string[];
}

export async function runMigrations(
  ctx: Ctx,
  ref: string,
  migrations: readonly MigrationFile[],
): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], skipped: 0, changed: [] };
  let done = new Map<string, string>();
  if (ctx.dryRun) {
    // Läs utan att skapa något: finns inte tabellen räknas alla som nya.
    const exists = await runQueryReadOnly<{ t: string | null }>(
      ctx,
      ref,
      "select to_regclass('supabase_migrations.schema_migrations')::text as t;",
    );
    if (exists[0]?.t) {
      const rows = await runQueryReadOnly<{ version: string; hash: string }>(
        ctx,
        ref,
        "select version, md5(coalesce(statements[1], '')) as hash from supabase_migrations.schema_migrations;",
      );
      done = new Map(rows.map((r) => [r.version, r.hash]));
    }
  } else {
    const rows = await runQuery<{ version: string; hash: string }>(ctx, ref, BOOKKEEPING_SQL);
    done = new Map(rows.map((r) => [r.version, r.hash]));
  }
  for (const m of migrations) {
    const hash = done.get(m.version);
    if (hash !== undefined) {
      result.skipped += 1;
      if (hash !== md5(m.sql) && hash !== md5("")) {
        result.changed.push(m.file);
        ctx.log.warn(
          `${m.file} har ändrats sedan den kördes i ${ref}. Skriv en ny migrering i stället.`,
        );
      }
      continue;
    }
    if (ctx.dryRun) {
      ctx.log.plan(`köra ${m.file} i ${ref}`);
      result.applied.push(m.version);
      continue;
    }
    try {
      await runQuery(ctx, ref, migrationQuery(m));
    } catch (error) {
      if (error instanceof ApiError && error.apiMessage.includes(ALREADY_APPLIED)) {
        result.skipped += 1;
        ctx.log.info(`${m.file} kördes samtidigt av någon annan; hoppar över.`);
        continue;
      }
      if (
        error instanceof ApiError &&
        /multiple commands|prepared statement/i.test(error.apiMessage)
      ) {
        throw new Error(
          `${error.message}\nManagement API:t tog inte emot flera satser i en fråga. Kör i stället migreringarna med "npm run db:migrate -- --url <session-pooler-adress>".`,
        );
      }
      if (error instanceof ApiError) {
        throw new Error(
          `Migreringen ${m.file} misslyckades i ${ref} och rullades tillbaka: ${error.apiMessage}`,
        );
      }
      throw error;
    }
    result.applied.push(m.version);
    ctx.log.ok(`Körde ${m.file}`);
  }
  if (!ctx.dryRun && result.applied.length > 0) {
    const rows = await runQuery<{ version: string }>(
      ctx,
      ref,
      "select version from supabase_migrations.schema_migrations;",
    );
    const recorded = new Set(rows.map((r) => r.version));
    const lost = result.applied.filter((v) => !recorded.has(v));
    if (lost.length > 0) {
      throw new Error(
        `Supabase: migreringarna ${lost.join(", ")} bokfördes inte i ${ref}. Avbryter.`,
      );
    }
  }
  ctx.log.ok(
    `${ref}: ${result.applied.length} ${ctx.dryRun ? "att köra" : "körda"}, ${result.skipped} redan körda.`,
  );
  return result;
}

/** Läsfråga i dry-run (POST, men ändrar inget; transaktionen är read only). */
async function runQueryReadOnly<T>(ctx: Ctx, ref: string, query: string): Promise<T[]> {
  const { data } = await ctx.api.request<T[]>("POST", `/v1/projects/${ref}/database/query`, {
    body: { query: `set transaction read only; ${query}` },
    readOnly: true,
    idempotent: true,
  });
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function ensureBuckets(
  ctx: Ctx,
  ref: string,
  secretKey: string,
  names: readonly string[],
): Promise<string[]> {
  const storage = createApiClient({
    service: "Supabase Storage",
    baseUrl: `${projectUrl(ref)}/storage/v1`,
    token: secretKey,
    headers: { apikey: secretKey },
    fetch: ctx.fetch,
    log: ctx.log,
    dryRun: ctx.dryRun,
    sleep: ctx.sleep,
  });
  const { data } = await storage.get<{ id: string; public?: boolean }[]>("/bucket");
  const existing = new Map((Array.isArray(data) ? data : []).map((b) => [b.id, b]));
  const created: string[] = [];
  for (const name of names) {
    const bucket = existing.get(name);
    if (bucket) {
      if (bucket.public) ctx.log.warn(`Bucket ${name} i ${ref} är publik; den ska vara privat.`);
      continue;
    }
    if (ctx.dryRun) {
      ctx.log.plan(`skapa den privata bucketen ${name} i ${ref}`);
      created.push(name);
      continue;
    }
    await storage.request("POST", "/bucket", {
      body: { id: name, name, public: false },
      allow: [409],
    });
    created.push(name);
    ctx.log.ok(`Skapade bucket ${name} i ${ref}.`);
  }
  if (created.length === 0) ctx.log.ok(`Buckets i ${ref}: ${names.join(", ")} finns.`);
  return created;
}
