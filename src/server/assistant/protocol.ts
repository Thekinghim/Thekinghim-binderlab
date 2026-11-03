/**
 * Strömmen från /assistent/fraga till webbläsaren: en JSON-händelse per rad (NDJSON).
 * Bara typer, så att klientkomponenten kan importera dem utan serverkod.
 *
 *   start → (text | tool_call | tool_result)* → done
 *   … eller error när något stoppar svaret.
 */

/** En siffra i underlaget, som den visas ("Intäkt", "7 964 kr"). */
export interface ToolFigure {
  readonly label: string;
  readonly value: string;
}

/** En länk till sidan där underlaget finns (med period och filter i URL:en). */
export interface ToolLink {
  readonly label: string;
  readonly href: string;
}

/** Ett verktygsanrop som det visas i underlaget och sparas i loggen. */
export interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  /** Svensk etikett, t.ex. "Lönsamhet per automat". */
  readonly label: string;
  /** Parametrarna som modellen skickade (efter validering). */
  readonly input: Record<string, unknown>;
  readonly ok: boolean;
  /** En mening om resultatet, eller felet. */
  readonly summary: string;
  readonly figures: readonly ToolFigure[];
  readonly links: readonly ToolLink[];
  /** Knappar som assistenten föreslår (foresla_knapp). Bara navigering. */
  readonly actions?: readonly ToolLink[];
  /** Hämtat i förväg som sidans sammanfattning (inte ett anrop från modellen). */
  readonly prefetched?: boolean;
  /** Resultatet som modellen fick (JSON). */
  readonly result: unknown;
  readonly durationMs: number;
}

export type AssistantStatus = "answered" | "unverified" | "refused" | "limit" | "error";

export interface Verification {
  readonly checked: number;
  readonly unverified: readonly string[];
}

export interface AssistantUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** Tokens som skrevs till cachen (räknas i månadens kostnad). Saknas i äldre loggar. */
  readonly cacheWriteTokens?: number;
  readonly turns: number;
}

export type AssistantEvent =
  | {
      readonly type: "start";
      readonly conversationId: string;
      readonly provider: "anthropic" | "local";
      readonly model: string;
      /** Verktygen som rollen fick (namn och etikett). */
      readonly tools: ReadonlyArray<{ readonly name: string; readonly label: string }>;
    }
  | { readonly type: "text"; readonly text: string }
  /** Modellen började ett nytt varv efter verktygsresultat: tidigare text var ett mellansteg. */
  | { readonly type: "turn"; readonly turn: number }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly label: string;
      readonly input: Record<string, unknown>;
    }
  | { readonly type: "tool_result"; readonly call: ToolCallRecord }
  | {
      readonly type: "done";
      readonly logId: string | null;
      readonly status: AssistantStatus;
      readonly answer: string;
      readonly verification: Verification;
      readonly usage: AssistantUsage;
      readonly durationMs: number;
      /** Knappar som användaren kan klicka på (bara navigering, ingen data ändras). */
      readonly actions?: readonly ToolLink[];
      /** Andel av månadens AI-budget kvar (0–1), bara när mindre än 20 % är kvar. */
      readonly budgetLeft?: number | null;
    }
  | {
      readonly type: "error";
      readonly code:
        "not-configured" | "forbidden" | "invalid" | "upstream" | "internal" | "budget";
      readonly message: string;
      readonly logId?: string | null;
    };

/** Begränsningar för frågan (kontrolleras både i webbläsaren och på servern). */
export const QUESTION_MAX_LENGTH = 2000;
