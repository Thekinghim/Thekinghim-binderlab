/**
 * Utskrift för driftsättningsskripten.
 *
 * Allt som skrivs går genom `redact()`: varje hemlighet som registrerats med
 * `secret()` (tokens, nycklar, lösenord, databasadresser) ersätts med
 * `[hemlig]` innan raden lämnar processen. Skripten skriver aldrig loggfiler;
 * allt går till stdout/stderr (eller till `sink` i testerna).
 */

export type LogLevel = "step" | "info" | "ok" | "warn" | "plan" | "error" | "manual";

export interface LogSink {
  (level: LogLevel, line: string): void;
}

export interface Logger {
  /** Registrerar ett hemligt värde så att det aldrig skrivs ut. Returnerar värdet. */
  secret<T extends string | undefined>(value: T): T;
  redact(text: string): string;
  step(title: string): void;
  info(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
  /** Dry-run: vad som skulle göras. */
  plan(message: string): void;
  error(message: string): void;
  /** Något som beställaren måste göra för hand. Samlas i sammanfattningen. */
  manual(message: string): void;
  readonly manualSteps: readonly string[];
  readonly warnings: readonly string[];
}

const PREFIX: Record<LogLevel, string> = {
  step: "\n==",
  info: "  ·",
  ok: "  ✓",
  warn: "  ! VARNING:",
  plan: "  → skulle:",
  error: "  ✗ FEL:",
  manual: "  ☐ MANUELLT:",
};

/** Mönster som alltid maskeras, även om värdet inte registrerats. */
const ALWAYS_REDACT: readonly (readonly [RegExp, string])[] = [
  [/sb_secret_[A-Za-z0-9_-]+/g, "[hemlig]"],
  [/sbp_[A-Za-z0-9_]{20,}/g, "[hemlig]"],
  // Lösenord i postgres-adresser: postgres(ql)://användare:lösen@värd
  [/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/g, "$1[hemlig]@"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[hemlig]"],
];

export function defaultSink(level: LogLevel, line: string): void {
  if (level === "error" || level === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export function createLogger(sink: LogSink = defaultSink): Logger {
  const secrets = new Set<string>();
  const manualSteps: string[] = [];
  const warnings: string[] = [];

  function redact(text: string): string {
    let out = text;
    // Längsta först, så att en hemlighet som innehåller en annan maskeras helt.
    for (const value of [...secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(value).join("[hemlig]");
      const encoded = encodeURIComponent(value);
      if (encoded !== value) out = out.split(encoded).join("[hemlig]");
    }
    for (const [pattern, replacement] of ALWAYS_REDACT) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  function emit(level: LogLevel, message: string): void {
    const text = redact(message);
    const line = level === "step" ? `${PREFIX.step} ${text}` : `${PREFIX[level]} ${text}`;
    sink(level, line);
  }

  return {
    secret<T extends string | undefined>(value: T): T {
      // Korta värden (t.ex. "3") maskeras inte; de är inga hemligheter och
      // skulle göra utskriften oläslig.
      if (typeof value === "string" && value.length >= 8) secrets.add(value);
      return value;
    },
    redact,
    step: (title) => emit("step", title),
    info: (m) => emit("info", m),
    ok: (m) => emit("ok", m),
    warn: (m) => {
      warnings.push(redact(m));
      emit("warn", m);
    },
    plan: (m) => emit("plan", m),
    error: (m) => emit("error", m),
    manual: (m) => {
      manualSteps.push(redact(m));
      emit("manual", m);
    },
    get manualSteps() {
      return manualSteps;
    },
    get warnings() {
      return warnings;
    },
  };
}
