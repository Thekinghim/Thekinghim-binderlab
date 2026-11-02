/**
 * Vercel REST API (https://api.vercel.com): projektet kopplat till
 * GitHub-repot, miljövariabler, funktionsregion, driftsättning och kontroll.
 * Idempotent: läser först och ändrar bara det som skiljer sig. I dry-run
 * skickas bara GET.
 *
 * Endpoints som inte kunnat provas härifrån är märkta OSÄKER här och i
 * docs/driftsattning.md.
 */

import { ApiError, type ApiClient, type FetchLike, type Sleep } from "./http";
import type { Logger } from "./log";
import { fingerprint } from "./secrets";

export interface Ctx {
  api: ApiClient;
  log: Logger;
  dryRun: boolean;
  sleep: Sleep;
  fetch: FetchLike;
}

// ---------------------------------------------------------------------------
// Team och projekt
// ---------------------------------------------------------------------------

export interface Scope {
  /** undefined = personligt konto utan team. */
  teamId: string | undefined;
  slug: string;
  /** hobby, pro, enterprise (om API:t berättar). */
  plan?: string;
}

export interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  serverlessFunctionRegion?: string | null;
  link?: {
    type?: string;
    org?: string;
    repo?: string;
    repoId?: number;
    productionBranch?: string;
  } | null;
}

interface Team {
  id: string;
  slug: string;
  name?: string;
  billing?: { plan?: string } | null;
}

export function scopeQuery(scope: Scope): Record<string, string | undefined> {
  return { teamId: scope.teamId };
}

export async function listScopes(ctx: Ctx): Promise<Scope[]> {
  const scopes: Scope[] = [];
  const { status, data } = await ctx.api.get<{ teams?: Team[] }>("/v2/teams", {
    query: { limit: 100 },
    allow: [403],
  });
  if (status === 200) {
    for (const team of data.teams ?? []) {
      scopes.push({ teamId: team.id, slug: team.slug, plan: team.billing?.plan ?? undefined });
    }
  }
  // Personligt konto (äldre Hobby-konton utan team, eller token utan teamåtkomst).
  const user = await ctx.api.get<{ user?: { username?: string } }>("/v2/user", { allow: [403] });
  const username = user.data?.user?.username;
  if (username) scopes.push({ teamId: undefined, slug: username });
  return scopes;
}

export function isRepoLink(project: VercelProject, repo: { org: string; repo: string }): boolean {
  const link = project.link;
  return (
    link?.type === "github" &&
    (link.org ?? "").toLowerCase() === repo.org.toLowerCase() &&
    (link.repo ?? "").toLowerCase() === repo.repo.toLowerCase()
  );
}

export async function listProjects(ctx: Ctx, scope: Scope): Promise<VercelProject[]> {
  const all: VercelProject[] = [];
  let until: number | undefined;
  for (let page = 0; page < 20; page += 1) {
    const { data } = await ctx.api.get<{
      projects?: VercelProject[];
      pagination?: { next?: number | null };
    }>("/v10/projects", { query: { ...scopeQuery(scope), limit: 100, until } });
    all.push(...(data.projects ?? []));
    const next = data.pagination?.next;
    if (!next) break;
    until = next;
  }
  return all;
}

export interface ResolvedProject {
  scope: Scope;
  project: VercelProject | null;
  created: boolean;
}

/**
 * Hittar projektet som är kopplat till repot (i angivet team, annars i alla
 * team token ser), eller skapar det och kopplar repot.
 */
export async function resolveProject(
  ctx: Ctx,
  opts: { team: string | undefined; repo: { org: string; repo: string }; name: string },
): Promise<ResolvedProject> {
  let scopes = await listScopes(ctx);
  if (opts.team) {
    scopes = scopes.filter((s) => s.teamId === opts.team || s.slug === opts.team);
    if (scopes.length === 0) {
      throw new Error(`Vercel: teamet ${opts.team} syns inte för VERCEL_TOKEN.`);
    }
  }
  if (scopes.length === 0) throw new Error("Vercel: token ser inget team eller konto.");
  const repoName = `${opts.repo.org}/${opts.repo.repo}`;
  for (const scope of scopes) {
    const projects = await listProjects(ctx, scope);
    const linked = projects.filter((p) => isRepoLink(p, opts.repo));
    if (linked.length > 1) {
      const preferred = linked.find((p) => p.name === opts.name);
      if (!preferred) {
        throw new Error(
          `Vercel: flera projekt i ${scope.slug} är kopplade till ${repoName} (${linked.map((p) => p.name).join(", ")}). Ange vilket genom att ta bort kopplingen på de andra.`,
        );
      }
      ctx.log.ok(`Vercel-projektet ${preferred.name} (${scope.slug}) är kopplat till ${repoName}.`);
      return { scope, project: preferred, created: false };
    }
    if (linked[0]) {
      ctx.log.ok(`Vercel-projektet ${linked[0].name} (${scope.slug}) är kopplat till ${repoName}.`);
      return { scope, project: linked[0], created: false };
    }
  }
  // Inget kopplat projekt: skapa i det enda teamet (eller det angivna).
  const teams = scopes.filter((s) => s.teamId);
  const target = teams.length === 1 ? teams[0] : teams.length === 0 ? scopes[0] : undefined;
  if (!target) {
    throw new Error(
      `Vercel: inget projekt är kopplat till ${repoName}, och token ser flera team (${teams.map((t) => t.slug).join(", ")}). Ange --vercel-team <slug>.`,
    );
  }
  const sameName = (await listProjects(ctx, target)).find((p) => p.name === opts.name);
  if (sameName && sameName.link && !isRepoLink(sameName, opts.repo)) {
    throw new Error(
      `Vercel: projektet ${opts.name} i ${target.slug} är kopplat till ett annat repo (${sameName.link.org}/${sameName.link.repo}). Avbryter.`,
    );
  }
  if (ctx.dryRun) {
    ctx.log.plan(
      sameName
        ? `koppla Vercel-projektet ${opts.name} (${target.slug}) till ${repoName}`
        : `skapa Vercel-projektet ${opts.name} i ${target.slug} kopplat till ${repoName} (Next.js)`,
    );
    return { scope: target, project: sameName ?? null, created: !sameName };
  }
  try {
    if (sameName) {
      // OSÄKER: POST /v9/projects/{id}/link.
      const { data } = await ctx.api.request<VercelProject>(
        "POST",
        `/v9/projects/${sameName.id}/link`,
        {
          query: scopeQuery(target),
          body: { type: "github", repo: repoName, productionBranch: "main" },
        },
      );
      ctx.log.ok(`Kopplade ${opts.name} till ${repoName}.`);
      return { scope: target, project: { ...sameName, ...data }, created: false };
    }
    const { data } = await ctx.api.request<VercelProject>("POST", "/v11/projects", {
      query: scopeQuery(target),
      body: {
        name: opts.name,
        framework: "nextjs",
        gitRepository: { type: "github", repo: repoName },
      },
    });
    ctx.log.ok(`Skapade Vercel-projektet ${data.name} i ${target.slug}, kopplat till ${repoName}.`);
    return { scope: target, project: data, created: true };
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      throw new Error(
        `${error.message}\nVercel kunde inte koppla ${repoName}. Vercels GitHub-app måste ha åtkomst till repot: ` +
          `GitHub → Settings → Applications → Vercel → Repository access (eller vercel.com/new → Import). Kör sedan igen.`,
      );
    }
    throw error;
  }
}

export async function ensureFunctionRegion(
  ctx: Ctx,
  scope: Scope,
  project: VercelProject,
  region: string,
): Promise<boolean> {
  if (project.serverlessFunctionRegion === region) {
    ctx.log.ok(`Funktionsregion är ${region}.`);
    return false;
  }
  if (ctx.dryRun) {
    ctx.log.plan(
      `sätta funktionsregion ${region} (nu ${project.serverlessFunctionRegion ?? "standard"})`,
    );
    return true;
  }
  await ctx.api.request("PATCH", `/v9/projects/${project.id}`, {
    query: scopeQuery(scope),
    body: { serverlessFunctionRegion: region },
  });
  ctx.log.ok(`Funktionsregion satt till ${region} (vercel.json säger också ${region}).`);
  return true;
}

interface Domain {
  name: string;
  verified?: boolean;
  redirect?: string | null;
  gitBranch?: string | null;
}

/** Produktionsdomänen: en egen verifierad domän om det finns, annars *.vercel.app. */
export async function productionDomain(
  ctx: Ctx,
  scope: Scope,
  project: VercelProject,
): Promise<string | undefined> {
  const { status, data } = await ctx.api.get<{ domains?: Domain[] }>(
    `/v9/projects/${project.id}/domains`,
    { query: scopeQuery(scope), allow: [404] },
  );
  if (status !== 200) return undefined;
  const prod = (data.domains ?? []).filter(
    (d) => !d.redirect && !d.gitBranch && d.verified !== false,
  );
  const custom = prod.find((d) => !d.name.endsWith(".vercel.app"));
  return (custom ?? prod[0])?.name;
}

// ---------------------------------------------------------------------------
// Miljövariabler
// ---------------------------------------------------------------------------

export type Target = "production" | "preview";

export interface DesiredVar {
  key: string;
  target: Target;
  sensitive: boolean;
  /** Känt värde: sätts om det skiljer sig. */
  value?: string;
  /** Genererat värde: sätts bara om variabeln saknas. */
  generate?: () => Promise<string> | string;
  /**
   * För genererade värden: godtas det befintliga (läsbara) värdet? Annars
   * genereras ett nytt. Känsliga värden går inte att läsa och godtas alltid.
   */
  accept?: (current: string) => boolean;
}

export interface EnvEntry {
  id: string;
  key: string;
  value?: string;
  type?: string;
  target?: string[] | string;
  gitBranch?: string | null;
}

export const STATE_KEY = "BINDERLAB_DEPLOY_STATE";

function targetsOf(entry: EnvEntry): string[] {
  if (Array.isArray(entry.target)) return entry.target;
  return entry.target ? [entry.target] : [];
}

export interface EnvChange {
  key: string;
  target: Target;
  action: "skapad" | "uppdaterad" | "uppdelad" | "oförändrad" | "behållen";
}

export interface EnvSyncResult {
  changes: EnvChange[];
  /** Något ändrades i production (kräver ny driftsättning). */
  productionChanged: boolean;
}

export async function listEnv(ctx: Ctx, scope: Scope, project: VercelProject): Promise<EnvEntry[]> {
  const { data } = await ctx.api.get<{ envs?: EnvEntry[] }>(`/v10/projects/${project.id}/env`, {
    query: scopeQuery(scope),
  });
  return data.envs ?? [];
}

/** Värdet för en variabel i ett mål, om den finns och går att läsa. */
export async function readEnvValue(
  ctx: Ctx,
  scope: Scope,
  project: VercelProject,
  entries: readonly EnvEntry[],
  key: string,
  target: Target,
): Promise<string | undefined> {
  const entry = entries.find((e) => e.key === key && !e.gitBranch && targetsOf(e).includes(target));
  return entry ? readValue(ctx, scope, project, entry) : undefined;
}

export function hasEnv(entries: readonly EnvEntry[], key: string, target: Target): boolean {
  return entries.some((e) => e.key === key && !e.gitBranch && targetsOf(e).includes(target));
}

/** Dekrypterat värde för en icke-känslig variabel (känsliga går inte att läsa). */
async function readValue(
  ctx: Ctx,
  scope: Scope,
  project: VercelProject,
  entry: EnvEntry,
): Promise<string | undefined> {
  if (entry.type === "sensitive" || entry.type === "secret") return undefined;
  if (entry.type === "plain" && typeof entry.value === "string") return entry.value;
  const { status, data } = await ctx.api.get<{ value?: string; decrypted?: boolean }>(
    `/v1/projects/${project.id}/env/${entry.id}`,
    { query: scopeQuery(scope), allow: [403, 404] },
  );
  if (status !== 200 || typeof data.value !== "string") return undefined;
  if (data.decrypted === false) return undefined;
  // Värdet skrivs aldrig ut; det används bara för att jämföra.
  return data.value;
}

interface State {
  v: 1;
  fp: Record<string, string>;
}

function parseState(value: string | undefined): State {
  if (!value) return { v: 1, fp: {} };
  try {
    const parsed = JSON.parse(value) as Partial<State>;
    return { v: 1, fp: typeof parsed.fp === "object" && parsed.fp ? parsed.fp : {} };
  } catch {
    return { v: 1, fp: {} };
  }
}

/**
 * Synkar variablerna. Regler:
 * - Ett känt värde jämförs med det som finns (dekrypterat, eller via
 *   fingeravtrycket i BINDERLAB_DEPLOY_STATE för känsliga) och sätts bara om
 *   det skiljer sig.
 * - Ett genererat värde (CRON_SECRET, lösenord, VAPID) sätts bara om
 *   variabeln saknas, så att en ny körning inte byter fungerande hemligheter.
 * - En variabel som delas mellan flera miljöer med fel värde delas upp.
 * - Variabler som skriptet inte hanterar rörs aldrig.
 */
export async function syncEnv(
  ctx: Ctx,
  scope: Scope,
  project: VercelProject,
  desired: readonly DesiredVar[],
): Promise<EnvSyncResult> {
  const entries = (await listEnv(ctx, scope, project)).filter((e) => !e.gitBranch);
  const changes: EnvChange[] = [];
  const query = scopeQuery(scope);
  const statesByTarget = new Map<Target, { entry: EnvEntry | undefined; state: State }>();
  for (const target of ["production", "preview"] as const) {
    const entry = entries.find(
      (e) => e.key === STATE_KEY && targetsOf(e).length === 1 && targetsOf(e)[0] === target,
    );
    const raw = entry ? await readValue(ctx, scope, project, entry) : undefined;
    statesByTarget.set(target, { entry, state: parseState(raw) });
  }
  const nextFp = new Map<Target, Record<string, string>>([
    ["production", { ...statesByTarget.get("production")!.state.fp }],
    ["preview", { ...statesByTarget.get("preview")!.state.fp }],
  ]);
  /** Mål som ska tas bort från delade variabler, per variabel-id. */
  const removeTargets = new Map<string, Set<string>>();
  const creates: { d: DesiredVar; value: string }[] = [];
  const updates: { d: DesiredVar; entry: EnvEntry; value: string }[] = [];

  for (const d of desired) {
    const covering = entries.find((e) => e.key === d.key && targetsOf(e).includes(d.target));
    if (d.value !== undefined) ctx.log.secret(d.sensitive ? d.value : undefined);
    if (!covering) {
      const value = d.value ?? (await d.generate?.());
      if (value === undefined) continue;
      if (d.sensitive) ctx.log.secret(value);
      creates.push({ d, value });
      continue;
    }
    const fpMap = nextFp.get(d.target)!;
    const current = await readValue(ctx, scope, project, covering);
    if (d.value === undefined) {
      if (current === undefined || !d.accept || d.accept(current)) {
        changes.push({ key: d.key, target: d.target, action: "behållen" });
        continue;
      }
      const value = await d.generate?.();
      if (value === undefined) continue;
      if (d.sensitive) ctx.log.secret(value);
      if (targetsOf(covering).length === 1) {
        updates.push({ d, entry: covering, value });
      } else {
        const set = removeTargets.get(covering.id) ?? new Set<string>();
        set.add(d.target);
        removeTargets.set(covering.id, set);
        creates.push({ d, value });
      }
      continue;
    }
    const same =
      current !== undefined ? current === d.value : fpMap[d.key] === fingerprint(d.value);
    if (same) {
      if (d.sensitive) fpMap[d.key] = fingerprint(d.value);
      changes.push({ key: d.key, target: d.target, action: "oförändrad" });
      continue;
    }
    if (targetsOf(covering).length === 1) {
      updates.push({ d, entry: covering, value: d.value });
    } else {
      const set = removeTargets.get(covering.id) ?? new Set<string>();
      set.add(d.target);
      removeTargets.set(covering.id, set);
      creates.push({ d, value: d.value });
    }
  }

  const typeOf = (d: DesiredVar) => (d.sensitive ? "sensitive" : "encrypted");
  const record = (d: DesiredVar, value: string) => {
    if (d.sensitive) nextFp.get(d.target)![d.key] = fingerprint(value);
  };

  for (const [id, remove] of removeTargets) {
    const entry = entries.find((e) => e.id === id)!;
    const rest = targetsOf(entry).filter((t) => !remove.has(t));
    for (const t of remove)
      changes.push({ key: entry.key, target: t as Target, action: "uppdelad" });
    if (ctx.dryRun) {
      ctx.log.plan(
        `dela upp ${entry.key} (${targetsOf(entry).join("+")}) så att ${[...remove].join("+")} får eget värde`,
      );
      continue;
    }
    if (rest.length === 0) {
      await ctx.api.request("DELETE", `/v9/projects/${project.id}/env/${id}`, { query });
    } else {
      // OSÄKER: PATCH med bara target (värdet lämnas orört).
      await ctx.api.request("PATCH", `/v9/projects/${project.id}/env/${id}`, {
        query,
        body: { target: rest },
      });
    }
  }
  for (const { d, entry, value } of updates) {
    changes.push({ key: d.key, target: d.target, action: "uppdaterad" });
    record(d, value);
    if (ctx.dryRun) {
      ctx.log.plan(`uppdatera ${d.key} (${d.target})`);
      continue;
    }
    await ctx.api.request("PATCH", `/v9/projects/${project.id}/env/${entry.id}`, {
      query,
      // Typen behålls (Vercel byter inte alltid typ på en befintlig variabel).
      body: { value, target: [d.target] },
    });
  }
  for (const { d, value } of creates) {
    if (!changes.some((c) => c.key === d.key && c.target === d.target && c.action === "uppdelad")) {
      changes.push({ key: d.key, target: d.target, action: "skapad" });
    }
    record(d, value);
    if (ctx.dryRun) {
      ctx.log.plan(
        `sätta ${d.key} (${d.target})${d.value === undefined ? " med ett genererat värde" : ""}`,
      );
      continue;
    }
    await ctx.api.request("POST", `/v10/projects/${project.id}/env`, {
      query,
      body: { key: d.key, value, type: typeOf(d), target: [d.target] },
    });
  }

  const changedTargets = new Set(
    changes
      .filter((c) => c.action !== "oförändrad" && c.action !== "behållen")
      .map((c) => c.target),
  );
  // Fingeravtrycken för känsliga värden (inga värden, bara sha256-prefix).
  for (const target of ["production", "preview"] as const) {
    const before = statesByTarget.get(target)!;
    const fp = nextFp.get(target)!;
    if (JSON.stringify(before.state.fp) === JSON.stringify(fp) && before.entry) continue;
    if (Object.keys(fp).length === 0 && !before.entry) continue;
    const value = JSON.stringify({ v: 1, fp } satisfies State);
    if (ctx.dryRun) continue;
    if (before.entry) {
      await ctx.api.request("PATCH", `/v9/projects/${project.id}/env/${before.entry.id}`, {
        query,
        body: { value, type: "encrypted", target: [target] },
      });
    } else {
      await ctx.api.request("POST", `/v10/projects/${project.id}/env`, {
        query,
        body: { key: STATE_KEY, value, type: "encrypted", target: [target] },
      });
    }
  }

  for (const target of ["production", "preview"] as const) {
    const mine = changes.filter((c) => c.target === target);
    const changed = mine.filter((c) => c.action !== "oförändrad" && c.action !== "behållen");
    ctx.log.ok(
      `${target}: ${changed.length} ${ctx.dryRun ? "att ändra" : "ändrade"} (${changed.map((c) => c.key).join(", ") || "inga"}), ${mine.length - changed.length} redan rätt.`,
    );
  }
  return { changes, productionChanged: changedTargets.has("production") };
}

// ---------------------------------------------------------------------------
// Driftsättning och kontroll
// ---------------------------------------------------------------------------

export interface Deployment {
  id: string;
  url?: string;
  readyState?: string;
  state?: string;
  alias?: string[];
  errorMessage?: string;
  inspectorUrl?: string;
}

export async function latestReadyProduction(
  ctx: Ctx,
  scope: Scope,
  project: VercelProject,
): Promise<Deployment | undefined> {
  const { data } = await ctx.api.get<{ deployments?: (Deployment & { uid?: string })[] }>(
    "/v6/deployments",
    {
      query: {
        ...scopeQuery(scope),
        projectId: project.id,
        target: "production",
        state: "READY",
        limit: 1,
      },
    },
  );
  const d = data.deployments?.[0];
  return d ? { ...d, id: d.id ?? d.uid ?? "" } : undefined;
}

export async function createProductionDeployment(
  ctx: Ctx,
  scope: Scope,
  project: VercelProject,
  repo: { org: string; repo: string },
  branch: string,
): Promise<Deployment> {
  const gitSource = project.link?.repoId
    ? { type: "github", repoId: project.link.repoId, ref: branch }
    : { type: "github", org: repo.org, repo: repo.repo, ref: branch };
  const { data } = await ctx.api.request<Deployment>("POST", "/v13/deployments", {
    query: scopeQuery(scope),
    body: { name: project.name, project: project.id, target: "production", gitSource },
  });
  ctx.log.ok(`Driftsättning startad från ${branch} (${data.id}).`);
  return data;
}

export async function waitForDeployment(
  ctx: Ctx,
  scope: Scope,
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Deployment> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const intervalMs = opts.intervalMs ?? 10_000;
  let waited = 0;
  let last = "";
  for (;;) {
    const { data } = await ctx.api.get<Deployment>(`/v13/deployments/${id}`, {
      query: scopeQuery(scope),
    });
    const state = data.readyState ?? data.state ?? "UNKNOWN";
    if (state === "READY") {
      ctx.log.ok(`Driftsättningen är klar (${data.url ?? id}).`);
      return data;
    }
    if (state === "ERROR" || state === "CANCELED") {
      throw new Error(
        `Vercel: driftsättningen ${id} slutade med ${state}${data.errorMessage ? `: ${data.errorMessage}` : ""}. ` +
          `Bygget syns i ${data.inspectorUrl ?? "Vercel → Deployments"}.`,
      );
    }
    if (state !== last) {
      ctx.log.info(`Driftsättningen: ${state} …`);
      last = state;
    }
    if (waited >= timeoutMs) {
      throw new Error(
        `Vercel: driftsättningen ${id} blev inte klar inom ${Math.round(timeoutMs / 60_000)} minuter.`,
      );
    }
    await ctx.sleep(intervalMs);
    waited += intervalMs;
  }
}

export interface SiteCheck {
  ok: boolean;
  status: number;
  /** Variabelnamn som sidan säger saknas (bara namn, inga värden). */
  missing: string[];
}

/** Hämtar /logga-in och kontrollerar 200 och att sidan inte säger "inte konfigurerat". */
export async function checkSite(
  ctx: Ctx,
  appUrl: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<SiteCheck> {
  const attempts = opts.attempts ?? 6;
  let last: SiteCheck = { ok: false, status: 0, missing: [] };
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await ctx.fetch(`${appUrl}/logga-in`, { redirect: "manual" });
      const html = await response.text();
      const notConfigured = /inte konfigurerat/i.test(html);
      const missing = notConfigured
        ? [...html.matchAll(/<li[^>]*>([A-Z][A-Z0-9_]+):/g)].map((m) => m[1] as string)
        : [];
      last = { ok: response.status === 200 && !notConfigured, status: response.status, missing };
      if (last.ok) break;
    } catch {
      last = { ok: false, status: 0, missing: [] };
    }
    if (i < attempts - 1) await ctx.sleep(opts.intervalMs ?? 10_000);
  }
  if (last.ok) ctx.log.ok(`${appUrl}/logga-in svarar 200 och är konfigurerad.`);
  else if (last.missing.length > 0) {
    ctx.log.error(`${appUrl}/logga-in säger "inte konfigurerat": ${last.missing.join(", ")}.`);
  } else {
    ctx.log.error(`${appUrl}/logga-in svarade ${last.status || "inte"}.`);
  }
  return last;
}
