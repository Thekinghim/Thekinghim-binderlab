/**
 * Fasta värden och inställningar för driftsättningen, plus tolkning av
 * argument och miljövariabler. Se docs/driftsattning.md.
 */

export const SUPABASE_API = "https://api.supabase.com";
export const VERCEL_API = "https://api.vercel.com";

/** Beställarens befintliga Supabase-projekt, används som utveckling (Vercel Preview). */
export const DEV_PROJECT_REF = "ukuuwokxbtwhqfnttzwr";
export const PROD_PROJECT_NAME = "binderlab-prod";
export const PROD_REGION = "eu-north-1";
export const GITHUB_REPO = { org: "Thekinghim", repo: "thekinghim-binderlab" } as const;
export const PRODUCTION_BRANCH = "main";
export const VERCEL_PROJECT_NAME = "binderlab";
export const VERCEL_FUNCTION_REGION = "arn1";
export const STORAGE_BUCKETS = ["imports", "reports", "contracts"] as const;

export type Phase = "supabase" | "vercel" | "invite";

export interface DeployOptions {
  dryRun: boolean;
  phases: ReadonlySet<Phase>;
  supabaseToken: string | undefined;
  vercelToken: string | undefined;
  /** Vercel-team (id eller slug); annars väljs teamet där projektet finns. */
  vercelTeam: string | undefined;
  /** Supabase-organisation för produktionsprojektet; standard: utvecklingsprojektets. */
  supabaseOrg: string | undefined;
  /** Befintligt Supabase-projekt som används som produktion (inget skapas, Preview hoppas över). */
  prodRef: string | undefined;
  /** Appens publika adress i produktion (annars Vercels domän). */
  appUrl: string | undefined;
  /** Ägarens e-post (bara om inbjudan ska göras). */
  ownerEmail: string | undefined;
  /** Vilket Supabase-projekt ägaren läggs i (standard production). */
  inviteTarget: "production" | "preview";
  /** Driftsätt även om inget ändrats. */
  forceDeploy: boolean;
  /** Hoppa över själva driftsättningen (bara variabler). */
  skipDeploy: boolean;
  /**
   * Får utvecklingsprojektets databaslösenord bytas när det är okänt
   * (--byt-dev-losenord)? Bryter GitHub-hemligheten och lokala .env-filer.
   */
  rotateDevPassword: boolean;
  /** Valfria värden som förs vidare till Vercel om de finns i sessionen. */
  passthrough: Record<string, string>;
}

/**
 * Valfria variabler som förs vidare till Vercel (Preview och Production) om
 * de finns i miljön där skriptet körs. Hemliga markeras `sensitive`.
 */
export const PASSTHROUGH_VARS: readonly { key: string; sensitive: boolean }[] = [
  { key: "RESEND_API_KEY", sensitive: true },
  { key: "MAIL_FROM", sensitive: false },
  { key: "MAIL_REPLY_TO", sensitive: false },
  { key: "ANTHROPIC_API_KEY", sensitive: true },
  { key: "ANTHROPIC_MODEL", sensitive: false },
  { key: "SENTRY_DSN", sensitive: false },
  { key: "NEXT_PUBLIC_SENTRY_DSN", sensitive: false },
  { key: "SENTRY_AUTH_TOKEN", sensitive: true },
  { key: "SENTRY_ORG", sensitive: false },
  { key: "SENTRY_PROJECT", sensitive: false },
  { key: "VAPID_SUBJECT", sensitive: false },
];

export const USAGE = `Användning:
  npx tsx scripts/deploy/all.ts [--dry-run] [--agare <e-post>] [--app-url <https://…>]
                                 [--vercel-team <id|slug>] [--supabase-org <id>]
                                 [--force-deploy] [--skip-deploy] [--byt-dev-losenord]
  npx tsx scripts/deploy/supabase.ts [--dry-run] [--app-url …]
  npx tsx scripts/deploy/vercel.ts [--dry-run] [--force-deploy] [--skip-deploy] [--byt-dev-losenord]
  npx tsx scripts/deploy/invite-owner.ts <e-post> [--dry-run] [--miljo production|preview]

Kräver SUPABASE_ACCESS_TOKEN och VERCEL_TOKEN i miljön. Se docs/driftsattning.md.`;

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`);
    this.name = "UsageError";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmail(value: string | undefined, what = "e-postadressen"): string {
  const email = value?.trim().toLowerCase();
  if (!email || !EMAIL.test(email)) {
    throw new UsageError(`Ogiltig ${what}: ${value ?? "(saknas)"}.`);
  }
  return email;
}

export function parseAppUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new UsageError(`--app-url är ingen adress: ${value}`);
  }
  if (url.protocol !== "https:" || url.pathname.replace(/\/+$/, "") !== "" || url.search) {
    throw new UsageError(
      `--app-url måste vara https://värd utan sökväg, t.ex. https://app.binderlab.se`,
    );
  }
  return url.origin;
}

export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

const VALUE_FLAGS = new Set([
  "--agare",
  "--app-url",
  "--vercel-team",
  "--supabase-org",
  "--miljo",
  "--prod-ref",
]);
const BOOLEAN_FLAGS = new Set([
  "--dry-run",
  "--force-deploy",
  "--skip-deploy",
  "--byt-dev-losenord",
  "--help",
  "-h",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--") continue;
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq !== -1 && arg.startsWith("--") ? arg.slice(eq + 1) : argv[i + 1];
      if (value === undefined || (eq === -1 && value.startsWith("--"))) {
        throw new UsageError(`${name} saknar värde.`);
      }
      values.set(name, value);
      if (eq === -1) i += 1;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags.add(arg === "-h" ? "--help" : arg);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Okänd flagga: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, values, positional };
}

function parseInviteTarget(value: string | undefined): "production" | "preview" {
  if (value === undefined || value === "production" || value === "produktion") return "production";
  if (value === "preview" || value === "utveckling") return "preview";
  throw new UsageError(`--miljo måste vara production eller preview, inte ${value}.`);
}

function blank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

export function buildOptions(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  phases: readonly Phase[],
): DeployOptions {
  const ownerArg = args.values.get("--agare") ?? args.positional[0];
  const passthrough: Record<string, string> = {};
  for (const { key } of PASSTHROUGH_VARS) {
    const value = blank(env[key]);
    if (value) passthrough[key] = value;
  }
  if (args.flags.has("--force-deploy") && args.flags.has("--skip-deploy")) {
    throw new UsageError("--force-deploy och --skip-deploy går inte att kombinera.");
  }
  return {
    dryRun: args.flags.has("--dry-run"),
    phases: new Set(phases),
    supabaseToken: blank(env.SUPABASE_ACCESS_TOKEN),
    vercelToken: blank(env.VERCEL_TOKEN),
    vercelTeam: blank(args.values.get("--vercel-team")) ?? blank(env.VERCEL_TEAM_ID),
    supabaseOrg: blank(args.values.get("--supabase-org")) ?? blank(env.SUPABASE_ORG_ID),
    prodRef: blank(args.values.get("--prod-ref")) ?? blank(env.SUPABASE_PROD_REF),
    appUrl: parseAppUrl(args.values.get("--app-url") ?? env.BINDERLAB_APP_URL),
    ownerEmail: ownerArg === undefined ? undefined : parseEmail(ownerArg, "e-post för ägaren"),
    inviteTarget: parseInviteTarget(args.values.get("--miljo")),
    forceDeploy: args.flags.has("--force-deploy"),
    skipDeploy: args.flags.has("--skip-deploy"),
    rotateDevPassword: args.flags.has("--byt-dev-losenord"),
    passthrough,
  };
}
