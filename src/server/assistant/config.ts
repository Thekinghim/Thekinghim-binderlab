/**
 * Assistentens inställningar ur miljövariablerna (se .env.example och docs/miljoer.md,
 * avsnittet "Assistent").
 *
 *   ASSISTANT_PROVIDER  anthropic (standard) | local
 *   ANTHROPIC_API_KEY   nyckeln till Claude API (krävs för anthropic)
 *   ANTHROPIC_MODEL_CHAT   modellen för frågorna: claude-opus-5-5 (standard) | claude-sonnet-5-5
 *                          (ANTHROPIC_MODEL gäller som äldre namn när _CHAT saknas)
 *   ANTHROPIC_EFFORT_CHAT  hur noga modellen tänker: low | medium | high (standard)
 *
 * `local` är en lokal testmodell utan AI (src/server/assistant/local-model.ts) som bara
 * får användas i development och i tester: den kör samma verktyg mot riktig data men
 * väljer verktyg med enkla nyckelord och skriver svaret med en mall.
 *
 * Ren funktion av en miljö (testas utan process.env).
 */

export const ASSISTANT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"] as const;
export type AssistantModel = (typeof ASSISTANT_MODELS)[number];
export const DEFAULT_ASSISTANT_MODEL: AssistantModel = "claude-opus-5-5";
/**
 * Insatsen (output_config.effort). Hög som standard: frågorna kräver ofta flera verktyg och
 * jämförelser. Tänkandet är adaptivt (det enda läget på Opus 5.5); insatsen styr djupet.
 */
export const ASSISTANT_EFFORTS = ["low", "medium", "high"] as const;
export type AssistantEffort = (typeof ASSISTANT_EFFORTS)[number];
export const DEFAULT_ASSISTANT_EFFORT: AssistantEffort = "high";
/** Namnet som den lokala testmodellen loggas med. */
export const LOCAL_MODEL_NAME = "lokal-testmodell";

export type AssistantConfig =
  | {
      readonly status: "ready";
      readonly provider: "anthropic";
      readonly model: AssistantModel;
      readonly apiKey: string;
      readonly effort: AssistantEffort;
    }
  | {
      readonly status: "ready";
      readonly provider: "local";
      readonly model: typeof LOCAL_MODEL_NAME;
    }
  | {
      readonly status: "not-configured";
      /** En mening om vad som saknas. */
      readonly message: string;
      /** Miljövariabler som behöver sättas. */
      readonly missing: readonly string[];
    }
  | {
      readonly status: "invalid";
      readonly message: string;
      readonly variable: string;
    };

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function isAssistantModel(value: string): value is AssistantModel {
  return (ASSISTANT_MODELS as readonly string[]).includes(value);
}

/** Läser inställningarna. Kastar aldrig: fel blir status "invalid". */
export function assistantConfigFrom(env: Env): AssistantConfig {
  const provider = read(env, "ASSISTANT_PROVIDER") ?? "anthropic";
  const appEnv = read(env, "APP_ENV") ?? "development";

  if (provider === "local") {
    const allowed =
      env.NODE_ENV === "test" || (appEnv === "development" && env.NODE_ENV !== "production");
    if (!allowed) {
      return {
        status: "invalid",
        variable: "ASSISTANT_PROVIDER",
        message: "ASSISTANT_PROVIDER=local får bara användas lokalt (APP_ENV=development).",
      };
    }
    return { status: "ready", provider: "local", model: LOCAL_MODEL_NAME };
  }

  if (provider !== "anthropic") {
    return {
      status: "invalid",
      variable: "ASSISTANT_PROVIDER",
      message: `ASSISTANT_PROVIDER måste vara anthropic eller local, inte "${provider.slice(0, 40)}".`,
    };
  }

  const modelVariable = read(env, "ANTHROPIC_MODEL_CHAT")
    ? "ANTHROPIC_MODEL_CHAT"
    : "ANTHROPIC_MODEL";
  const model = read(env, modelVariable) ?? DEFAULT_ASSISTANT_MODEL;
  if (!isAssistantModel(model)) {
    return {
      status: "invalid",
      variable: modelVariable,
      message: `${modelVariable} måste vara ${ASSISTANT_MODELS.join(" eller ")}, inte "${model.slice(0, 60)}".`,
    };
  }
  const effort = read(env, "ANTHROPIC_EFFORT_CHAT") ?? DEFAULT_ASSISTANT_EFFORT;
  if (!(ASSISTANT_EFFORTS as readonly string[]).includes(effort)) {
    return {
      status: "invalid",
      variable: "ANTHROPIC_EFFORT_CHAT",
      message: `ANTHROPIC_EFFORT_CHAT måste vara ${ASSISTANT_EFFORTS.join(", ")}, inte "${effort.slice(0, 20)}".`,
    };
  }

  const apiKey = read(env, "ANTHROPIC_API_KEY");
  if (!apiKey) {
    return {
      status: "not-configured",
      message: "Assistenten kräver ANTHROPIC_API_KEY.",
      missing: ["ANTHROPIC_API_KEY"],
    };
  }
  return {
    status: "ready",
    provider: "anthropic",
    model,
    apiKey,
    effort: effort as AssistantEffort,
  };
}

/** Inställningarna för den här processen. */
export function getAssistantConfig(): AssistantConfig {
  return assistantConfigFrom(process.env);
}
