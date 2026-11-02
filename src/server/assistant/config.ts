/**
 * Assistentens inställningar ur miljövariablerna (se .env.example och docs/miljoer.md,
 * avsnittet "Assistent").
 *
 *   ASSISTANT_PROVIDER  anthropic (standard) | local
 *   ANTHROPIC_API_KEY   nyckeln till Claude API (krävs för anthropic)
 *   ANTHROPIC_MODEL     claude-opus-5-5 (standard) | claude-sonnet-5-5
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
/** Namnet som den lokala testmodellen loggas med. */
export const LOCAL_MODEL_NAME = "lokal-testmodell";

export type AssistantConfig =
  | {
      readonly status: "ready";
      readonly provider: "anthropic";
      readonly model: AssistantModel;
      readonly apiKey: string;
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

  const model = read(env, "ANTHROPIC_MODEL") ?? DEFAULT_ASSISTANT_MODEL;
  if (!isAssistantModel(model)) {
    return {
      status: "invalid",
      variable: "ANTHROPIC_MODEL",
      message: `ANTHROPIC_MODEL måste vara ${ASSISTANT_MODELS.join(" eller ")}, inte "${model.slice(0, 60)}".`,
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
  return { status: "ready", provider: "anthropic", model, apiKey };
}

/** Inställningarna för den här processen. */
export function getAssistantConfig(): AssistantConfig {
  return assistantConfigFrom(process.env);
}
