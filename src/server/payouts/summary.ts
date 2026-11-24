/**
 * Två–tre meningar om en utbetalning från Nayax ("Nayax betalade 48 210 kr för 3–9 nov.
 * …"). Fakta räknas här ur uträkningen; texten skrivs av en mall, eller av Claude när AI är
 * påslaget. Varje tal i AI-texten kontrolleras mot fakta (src/server/assistant/verify.ts);
 * ett tal som inte finns där ger mallens text i stället. Sammanfattningen blockerar aldrig
 * sidan: den görs efter att utbetalningen sparats och annars av det dagliga jobbet.
 *
 * Bara fakta skickas till modellen (belopp, period, butiksnamn, partnerns andel totalt),
 * aldrig inköpspriser per titel.
 */

import Anthropic from "@anthropic-ai/sdk";

import { verifyNumbers } from "@/server/assistant/verify";
import { krText } from "@/reports/text";

export interface SummaryFacts {
  readonly beloppKr: number;
  readonly period: string;
  readonly butiker: readonly { readonly namn: string; readonly kr: number }[];
  readonly partner: {
    readonly namn: string;
    readonly kr: number;
    readonly inkopKr: number;
    readonly vinstKr: number;
  } | null;
  readonly momsKr: number;
  readonly kvarKr: number;
  readonly skillnadKr: number;
}

const kr = (ore: number) => Math.round(ore / 100);
const t = (v: number) => krText(v * 100, "never");

/** Mallens text (används utan AI och när AI-texten inte klarar kontrollen). */
export function templateSummary(f: SummaryFacts): string {
  const parts = [`Nayax betalade ${t(f.beloppKr)} för ${f.period}.`];
  const top = [...f.butiker].sort((a, b) => b.kr - a.kr)[0];
  if (top && top.kr > 0) {
    parts.push(
      f.butiker.length > 1
        ? `Mest till butikerna gick till ${top.namn} (${t(top.kr)}).`
        : `${top.namn} får ${t(top.kr)}.`,
    );
  }
  const rest = [
    f.partner ? `${f.partner.namn} får ${t(f.partner.kr)}` : null,
    f.momsKr > 0 ? `${t(f.momsKr)} sparas till moms` : null,
    f.kvarKr >= 0 ? `${t(f.kvarKr)} blir kvar till dig` : `du behöver lägga till ${t(-f.kvarKr)}`,
  ].filter(Boolean);
  parts.push(`${capital(joinSv(rest as string[]))}.`);
  if (Math.abs(f.skillnadKr) >= 5) {
    parts.push(
      f.skillnadKr < 0
        ? `Det är ${t(-f.skillnadKr)} mindre än vår försäljning säger.`
        : `Det är ${t(f.skillnadKr)} mer än vår försäljning säger.`,
    );
  }
  return parts.join(" ");
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function joinSv(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} och ${items[items.length - 1]}`;
}

/** Fakta ur uträkningens rader. */
export function summaryFacts(input: {
  readonly amountOre: number;
  readonly periodText: string;
  readonly diffOre: number;
  readonly lines: readonly {
    readonly kind: string;
    readonly name: string;
    readonly amountOre: number;
    readonly partner: { readonly reimbOre: number; readonly profitShareOre: number } | null;
  }[];
}): SummaryFacts {
  const partner = input.lines.find((l) => l.kind === "partner");
  return {
    beloppKr: kr(input.amountOre),
    period: input.periodText,
    butiker: input.lines
      .filter((l) => l.kind === "store" || l.kind === "store_owner")
      .map((l) => ({ namn: l.name, kr: kr(l.amountOre) })),
    partner: partner
      ? {
          namn: partner.name,
          kr: kr(partner.amountOre),
          inkopKr: kr(partner.partner?.reimbOre ?? 0),
          vinstKr: kr(partner.partner?.profitShareOre ?? 0),
        }
      : null,
    momsKr: kr(input.lines.find((l) => l.kind === "vat_reserve")?.amountOre ?? 0),
    kvarKr: kr(input.lines.find((l) => l.kind === "owner")?.amountOre ?? 0),
    skillnadKr: kr(input.diffOre),
  };
}

/** Godkänd AI-text: högst 400 tecken, högst tre meningar och alla tal finns i fakta. */
export function acceptSummary(text: string, facts: SummaryFacts): boolean {
  const clean = text.trim();
  if (clean.length < 10 || clean.length > 400) return false;
  if ((clean.match(/[.!?](\s|$)/g) ?? []).length > 3) return false;
  return verifyNumbers(clean, [facts]).unverified.length === 0;
}

export interface SummaryWriter {
  readonly model: string;
  write(facts: SummaryFacts): Promise<{
    text: string | null;
    model: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
  }>;
}

const TOOL = {
  name: "spara_sammanfattning",
  description: "Spara sammanfattningen (2–3 korta meningar på enkel svenska).",
  input_schema: {
    type: "object" as const,
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

export function createAnthropicSummaryWriter(options: {
  apiKey: string;
  model: string;
  client?: Anthropic;
}): SummaryWriter {
  const client =
    options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 1, timeout: 30_000 });
  return {
    model: options.model,
    async write(facts) {
      const message = await client.beta.messages.create({
        model: options.model,
        max_tokens: 400,
        output_config: { effort: "low" },
        system: [
          {
            type: "text",
            text: "Du skriver 2–3 korta meningar på enkel svenska om en utbetalning från Nayax till ägaren av varuautomater. Använd bara talen i fakta, skrivna som i fakta (hela kronor, t.ex. 48 210 kr). Inga facktermer. Anropa verktyget spara_sammanfattning.",
          },
        ],
        tools: [TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: `Fakta:\n${JSON.stringify(facts)}` }],
      });
      const call = message.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === TOOL.name,
      );
      const text = (call?.input as { text?: unknown } | undefined)?.text;
      return {
        text: typeof text === "string" ? text : null,
        model: message.model || options.model,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
