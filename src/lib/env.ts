/**
 * Miljövariabler, validerade med zod.
 *
 * - `getServerEnv()`: allt servern behöver. Kastar `EnvError` med ett svenskt
 *   meddelande som räknar upp varje fel. Får bara anropas på servern.
 * - `getClientEnv()`: bara `NEXT_PUBLIC_*`. Varje variabel läses med sitt
 *   fullständiga namn (`process.env.NEXT_PUBLIC_X`) så att Next kan byta ut den
 *   vid bygget. Inga hemligheter får någonsin ligga i `NEXT_PUBLIC_*`.
 *
 * Filen importerar inte "server-only", eftersom klientdelen används i
 * webbläsaren. Serverdelen läser bara `process.env` när den anropas.
 *
 * Se .env.example och docs/miljoer.md.
 */

import { z } from "zod";

export const APP_ENVS = ["development", "preview", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const AUTH_PROVIDERS = ["supabase", "dev"] as const;
export type AuthProviderKind = (typeof AUTH_PROVIDERS)[number];

/** Värdar som räknas som lokala (dev-inloggningen kräver en sådan databas). */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class EnvError extends Error {
  readonly issues: readonly string[];

  constructor(scope: "server" | "klient", issues: readonly string[]) {
    super(
      [
        `Fel i miljövariablerna (${scope}):`,
        ...issues.map((issue) => `  - ${issue}`),
        "Se .env.example och docs/miljoer.md.",
      ].join("\n"),
    );
    this.name = "EnvError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Byggstenar
// ---------------------------------------------------------------------------

/** Tomma strängar (vanligt i .env-filer) räknas som att variabeln saknas. */
function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function optionalString() {
  return z.preprocess(blankToUndefined, z.string().trim().optional());
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function optionalUrl(protocols: readonly string[], label: string) {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .refine((value) => {
        const url = parseUrl(value);
        return url !== null && protocols.includes(url.protocol);
      }, `måste vara en ${label}`)
      .optional(),
  );
}

const httpUrl = () => optionalUrl(["http:", "https:"], "http(s)-adress");

export function isLocalDatabaseUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && LOCAL_HOSTS.has(parsed.hostname);
}

/**
 * Supabase-nycklar: publishable-nycklar (`sb_publishable_…`) får finnas i
 * webbläsaren, secret-nycklar (`sb_secret_…`) och äldre service_role-JWT:er
 * aldrig.
 */
export function looksLikeSecretSupabaseKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) {
    return true;
  }
  const parts = key.split(".");
  if (parts.length === 3 && parts[1]) {
    try {
      // atob finns både i Node och i webbläsaren (Buffer bara i Node).
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as unknown;
      return (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { role?: unknown }).role === "service_role"
      );
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const serverSchema = z.object({
  APP_ENV: z.enum(APP_ENVS, { error: "måste vara development, preview eller production" }),
  AUTH_PROVIDER: z.enum(AUTH_PROVIDERS, { error: "måste vara supabase eller dev" }),
  DATABASE_URL: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "saknas" })
      .trim()
      .refine((value) => {
        const url = parseUrl(value);
        return url !== null && (url.protocol === "postgres:" || url.protocol === "postgresql:");
      }, "måste vara en postgres://-adress"),
  ),
  SUPABASE_URL: httpUrl(),
  SUPABASE_PUBLISHABLE_KEY: optionalString(),
  SUPABASE_SECRET_KEY: optionalString(),
  SUPABASE_JWKS_URL: httpUrl(),
  DEV_AUTH_SECRET: optionalString(),
  SENTRY_DSN: httpUrl(),
  SENTRY_AUTH_TOKEN: optionalString(),
  APP_URL: httpUrl(),
  VERCEL_URL: optionalString(),
  VERCEL_BRANCH_URL: optionalString(),
});

type ParsedServerEnv = z.infer<typeof serverSchema>;

export interface ServerEnv {
  APP_ENV: AppEnv;
  AUTH_PROVIDER: AuthProviderKind;
  DATABASE_URL: string;
  /** Satt när AUTH_PROVIDER=supabase. */
  SUPABASE_URL: string | undefined;
  SUPABASE_PUBLISHABLE_KEY: string | undefined;
  SUPABASE_SECRET_KEY: string | undefined;
  /** Härleds från SUPABASE_URL om den inte anges. */
  SUPABASE_JWKS_URL: string | undefined;
  /** Satt när AUTH_PROVIDER=dev. */
  DEV_AUTH_SECRET: string | undefined;
  SENTRY_DSN: string | undefined;
  SENTRY_AUTH_TOKEN: string | undefined;
  /** Appens publika adress utan avslutande snedstreck (krävs i production). */
  APP_URL: string | undefined;
  VERCEL_URL: string | undefined;
  VERCEL_BRANCH_URL: string | undefined;
}

export type EnvSource = Record<string, string | undefined>;

/** Standardvärden som beror på andra variabler (före validering). */
function withDefaults(source: EnvSource): EnvSource {
  const appEnv =
    blankToUndefined(source.APP_ENV) ??
    (source.NODE_ENV === "production" ? undefined : "development");
  const authProvider =
    blankToUndefined(source.AUTH_PROVIDER) ??
    (appEnv === "development" ? "dev" : appEnv === undefined ? undefined : "supabase");
  return {
    ...source,
    APP_ENV: appEnv as string | undefined,
    AUTH_PROVIDER: authProvider as string | undefined,
  };
}

function formatIssues(error: z.ZodError, source: EnvSource): string[] {
  return error.issues.map((issue) => {
    const key = String(issue.path[0] ?? "");
    const missing = blankToUndefined(source[key]) === undefined;
    return `${key}: ${missing ? "saknas" : issue.message}`;
  });
}

function crossFieldIssues(env: ParsedServerEnv): string[] {
  const issues: string[] = [];

  if (env.AUTH_PROVIDER === "dev") {
    if (env.APP_ENV !== "development") {
      issues.push("AUTH_PROVIDER: dev är bara tillåtet när APP_ENV=development");
    }
    if (!isLocalDatabaseUrl(env.DATABASE_URL)) {
      issues.push(
        "DATABASE_URL: dev-inloggningen kräver en lokal databas (localhost eller 127.0.0.1)",
      );
    }
    if (!env.DEV_AUTH_SECRET) {
      issues.push(
        "DEV_AUTH_SECRET: saknas (krävs när AUTH_PROVIDER=dev; skapa med `openssl rand -base64 48`)",
      );
    } else if (env.DEV_AUTH_SECRET.length < 32) {
      issues.push("DEV_AUTH_SECRET: måste vara minst 32 tecken");
    }
  }

  if (env.AUTH_PROVIDER === "supabase") {
    if (!env.SUPABASE_URL) {
      issues.push("SUPABASE_URL: saknas (krävs när AUTH_PROVIDER=supabase)");
    }
    if (!env.SUPABASE_PUBLISHABLE_KEY) {
      issues.push("SUPABASE_PUBLISHABLE_KEY: saknas (krävs när AUTH_PROVIDER=supabase)");
    } else if (looksLikeSecretSupabaseKey(env.SUPABASE_PUBLISHABLE_KEY)) {
      issues.push("SUPABASE_PUBLISHABLE_KEY: är en hemlig nyckel; använd publishable-nyckeln");
    }
    if (!env.SUPABASE_SECRET_KEY && env.APP_ENV !== "development") {
      issues.push(
        "SUPABASE_SECRET_KEY: saknas (krävs för inbjudningsmejl i preview och production)",
      );
    }
  }

  if (env.APP_ENV === "production") {
    if (!env.APP_URL) {
      issues.push("APP_URL: saknas (krävs i production, används i länkar i mejl)");
    } else if (!env.APP_URL.startsWith("https://")) {
      issues.push("APP_URL: måste börja med https:// i production");
    }
  }

  return issues;
}

/** Validerar serverns miljövariabler. Kastar `EnvError` med alla fel. */
export function parseServerEnv(source: EnvSource = process.env): ServerEnv {
  const input = withDefaults(source);
  const parsed = serverSchema.safeParse(input);
  if (!parsed.success) {
    throw new EnvError("server", formatIssues(parsed.error, input));
  }
  const env = parsed.data;
  const issues = crossFieldIssues(env);
  if (issues.length > 0) {
    throw new EnvError("server", issues);
  }
  const supabaseUrl = env.SUPABASE_URL?.replace(/\/+$/, "");
  return {
    APP_ENV: env.APP_ENV,
    AUTH_PROVIDER: env.AUTH_PROVIDER,
    DATABASE_URL: env.DATABASE_URL,
    SUPABASE_URL: supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    SUPABASE_JWKS_URL:
      env.SUPABASE_JWKS_URL ??
      (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined),
    DEV_AUTH_SECRET: env.DEV_AUTH_SECRET,
    SENTRY_DSN: env.SENTRY_DSN,
    SENTRY_AUTH_TOKEN: env.SENTRY_AUTH_TOKEN,
    APP_URL: env.APP_URL?.replace(/\/+$/, ""),
    VERCEL_URL: env.VERCEL_URL,
    VERCEL_BRANCH_URL: env.VERCEL_BRANCH_URL,
  };
}

let cachedServerEnv: { source: EnvSource; env: ServerEnv } | undefined;

/** Serverns miljö, validerad en gång per process. */
export function getServerEnv(): ServerEnv {
  if (cachedServerEnv && cachedServerEnv.source === process.env) {
    return cachedServerEnv.env;
  }
  const env = parseServerEnv(process.env);
  cachedServerEnv = { source: process.env, env };
  return env;
}

/** Bara för tester: glömmer den cachade servermiljön. */
export function resetServerEnvCache(): void {
  cachedServerEnv = undefined;
}

// ---------------------------------------------------------------------------
// Klient (NEXT_PUBLIC_*)
// ---------------------------------------------------------------------------

const clientSchema = z.object({
  NEXT_PUBLIC_APP_ENV: z.preprocess(
    blankToUndefined,
    z
      .enum(APP_ENVS, { error: "måste vara development, preview eller production" })
      .default("development"),
  ),
  NEXT_PUBLIC_SUPABASE_URL: httpUrl(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalString(),
  NEXT_PUBLIC_SENTRY_DSN: httpUrl(),
});

export type ClientEnv = z.infer<typeof clientSchema>;

/** Validerar klientens variabler. Kastar `EnvError`. */
export function parseClientEnv(source: EnvSource): ClientEnv {
  const parsed = clientSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError("klient", formatIssues(parsed.error, source));
  }
  const key = parsed.data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (key && looksLikeSecretSupabaseKey(key)) {
    throw new EnvError("klient", [
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: är en hemlig nyckel och får aldrig ligga i NEXT_PUBLIC_*",
    ]);
  }
  return parsed.data;
}

/** Klientens miljö. Säker att anropa både i webbläsaren och på servern. */
export function getClientEnv(): ClientEnv {
  return parseClientEnv({
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });
}
