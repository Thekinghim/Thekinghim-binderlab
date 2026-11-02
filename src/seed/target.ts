/**
 * Vilken databas seeden körs mot, och spärren mot fjärrdatabaser.
 *
 *   npm run db:seed                      # DATABASE_URL (binderlab_dev)
 *   npm run db:seed -- test              # DATABASE_URL_TEST (binderlab_test)
 *   npm run db:seed -- --url <url>       # valfri databas
 *   npm run db:seed -- --allow-remote …  # krävs för annat än 127.0.0.1/localhost
 *   npm run db:seed -- --write-csv <fil> # skriv bara Awish-CSV:n, ingen databas
 *
 * Mot en fjärrdatabas skapas inga användare (Supabase Auth äger dem; de måste
 * finnas), och standardlösenordet används aldrig.
 */

import { DEFAULT_DEV_SEED_PASSWORD } from "./catalog";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type SeedTarget =
  | { mode: "csv"; path: string }
  | {
      mode: "database";
      url: string;
      host: string;
      database: string;
      local: boolean;
      /** Lösenord för dev-användarna (bara lokalt). */
      password: string;
      manageUsers: boolean;
    };

export class SeedTargetError extends Error {
  override name = "SeedTargetError";
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) {
    return undefined;
  }
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    throw new SeedTargetError(`${flag} saknar värde.`);
  }
  return value;
}

export function isLocalDatabaseUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Tolkar argumenten och miljön. Kastar SeedTargetError vid fel eller spärr. */
export function resolveSeedTarget(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SeedTarget {
  const known = new Set(["dev", "test", "--url", "--allow-remote", "--write-csv"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const previous = argv[i - 1];
    if (!known.has(arg) && previous !== "--url" && previous !== "--write-csv") {
      throw new SeedTargetError(`Okänt argument: ${arg}`);
    }
  }

  const csvPath = valueAfter(argv, "--write-csv");
  if (csvPath !== undefined) {
    return { mode: "csv", path: csvPath };
  }

  const explicit = valueAfter(argv, "--url");
  const named = argv.includes("test") ? "test" : argv.includes("dev") ? "dev" : null;
  if (explicit !== undefined && named !== null) {
    throw new SeedTargetError("Ange antingen dev/test eller --url, inte båda.");
  }
  const variable = named === "test" ? "DATABASE_URL_TEST" : "DATABASE_URL";
  const url = explicit ?? env[variable];
  if (!url) {
    throw new SeedTargetError(`${variable} saknas (sätt den i .env.local eller använd --url).`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SeedTargetError("Ogiltig databas-URL.");
  }
  const local = isLocalDatabaseUrl(url);
  if (!local && !argv.includes("--allow-remote")) {
    throw new SeedTargetError(
      `Vägrar: ${parsed.hostname} är inte en lokal databas. Lägg till --allow-remote om det verkligen är meningen.`,
    );
  }

  const fromEnv = env.DEV_SEED_PASSWORD;
  let password: string;
  if (fromEnv !== undefined && fromEnv !== "") {
    password = fromEnv;
  } else if (local) {
    password = DEFAULT_DEV_SEED_PASSWORD;
  } else {
    // Fjärrdatabas: användarna skapas inte, så inget lösenord behövs.
    password = "";
  }

  return {
    mode: "database",
    url,
    host: parsed.host,
    database: parsed.pathname.replace(/^\//, ""),
    local,
    password,
    manageUsers: local,
  };
}
