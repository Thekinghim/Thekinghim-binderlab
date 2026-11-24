/**
 * AI läser en utbetalningsrapport som inte går att läsa på vanligt sätt (skannad PDF, foto
 * av skärmen, konstig layout). Claude får BARA filen, ingen data om butiker, partner eller
 * priser, och ska anropa verktyget extract_payout med det rapporten säger.
 *
 * Svaret blir alltid ett utkast: inget sparas i payouts förrän ägaren tryckt "Stämmer,
 * spara". AI:n delar aldrig pengar; det gör bara src/domain/payout-split.ts.
 *
 * Skydd: ingen körning för demoorganisationerna i produktion (isDemoBlocked), när månadens
 * AI-budget är slut (budgetState, samma tak som rådgivaren), efter 20 lästa rapporter per
 * organisation och dygn, eller för filer över 10 MB. Varje körning loggas i ai_runs
 * (purpose 'payout_read', trigger 'upload') med tokens och kostnad.
 *
 * Svaret kontrolleras: schemat (zod), belopp med högst två decimaler, datum som finns, och
 * brutto − avgift − återbetalningar = belopp inom 1 kr (annars en varning i utkastet).
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db/client";
import {
  advisorConfigFrom,
  budgetState,
  DEFAULT_ADVISOR_MODEL,
  isDemoBlocked,
} from "@/server/assistant/advisor/service";
import { budgetFrom, costOre, type TokenUsage } from "@/server/assistant/advisor/pricing";

import {
  checkSums,
  MAX_TRANSACTIONS,
  parseLooseDate,
  type ExtractedPayout,
  type ExtractWarning,
} from "./import-parse";

type Env = Readonly<Record<string, string | undefined>>;

export const AI_READS_PER_DAY = 20;
export const AI_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const EXTRACT_TOOL_NAME = "extract_payout";

const kr = z.number().finite().gte(-100_000_000).lte(100_000_000).nullable().optional();
const date = z.string().max(40).nullable().optional();

export const extractToolInputSchema = z.object({
  paid_on: date,
  amount_kr: kr,
  fees_kr: kr,
  gross_kr: kr,
  refunds_kr: kr,
  period_from: date,
  period_to: date,
  currency: z.string().max(10).nullable().optional(),
  transactions: z
    .array(
      z.object({
        id: z.string().max(100).nullable().optional(),
        date: date,
        amount_kr: z.number().finite(),
        device_serial: z.string().max(100).nullable().optional(),
      }),
    )
    .max(MAX_TRANSACTIONS)
    .optional(),
  devices: z
    .array(
      z.object({
        serial: z.string().min(1).max(100),
        amount_kr: z.number().finite(),
        fee_kr: z.number().finite().nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  quotes: z.array(z.string().max(300)).max(20).optional(),
});

export const EXTRACT_TOOL = {
  name: EXTRACT_TOOL_NAME,
  description:
    "Spara det rapporten säger om utbetalningen från Nayax. Belopp i kronor (SEK) som tal med punkt som decimaltecken. Datum som ÅÅÅÅ-MM-DD. Utelämna det som inte står i rapporten; gissa aldrig.",
  input_schema: {
    type: "object" as const,
    properties: {
      paid_on: { type: "string", description: "Dagen pengarna betalades ut." },
      amount_kr: { type: "number", description: "Utbetalt belopp (netto) i kronor." },
      fees_kr: { type: "number", description: "Nayax avgifter i kronor (positivt tal)." },
      gross_kr: { type: "number", description: "Försäljning före avgifter (brutto) i kronor." },
      refunds_kr: { type: "number", description: "Återbetalningar i kronor (positivt tal)." },
      period_from: { type: "string", description: "Första försäljningsdagen som ingår." },
      period_to: { type: "string", description: "Sista försäljningsdagen som ingår." },
      currency: { type: "string" },
      transactions: {
        type: "array",
        maxItems: MAX_TRANSACTIONS,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            date: { type: "string" },
            amount_kr: { type: "number" },
            device_serial: { type: "string" },
          },
          required: ["amount_kr"],
        },
      },
      devices: {
        type: "array",
        items: {
          type: "object",
          properties: {
            serial: { type: "string" },
            amount_kr: { type: "number" },
            fee_kr: { type: "number" },
          },
          required: ["serial", "amount_kr"],
        },
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      quotes: {
        type: "array",
        items: { type: "string" },
        description: "Korta citat ur rapporten där beloppen och datumen står.",
      },
    },
    required: ["confidence"],
  },
};

const INSTRUCTIONS = `Du läser en utbetalningsrapport från Nayax (kortbetalningar i varuautomater) åt ägaren.
Anropa verktyget ${EXTRACT_TOOL_NAME} en gång med det som STÅR i rapporten. Hitta aldrig på belopp eller datum.
Belopp i kronor som tal (1234.56). Avgifter och återbetalningar som positiva tal. Datum som ÅÅÅÅ-MM-DD.
Står transaktioner per köp, ta med dem (högst ${MAX_TRANSACTIONS}). Står automater eller serienummer, ta med dem i devices.
Sätt confidence till low om bilden är suddig eller siffrorna är svåra att läsa.`;

export type ReaderInput =
  | { readonly kind: "pdf"; readonly base64: string }
  | {
      readonly kind: "image";
      readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      readonly base64: string;
    }
  | { readonly kind: "text"; readonly text: string };

export interface ReaderResponse {
  readonly toolInput: unknown;
  readonly model: string;
  readonly usage: TokenUsage;
}

export interface PayoutReaderModel {
  readonly model: string;
  read(input: ReaderInput): Promise<ReaderResponse>;
}

/** Modellen för att läsa rapporter: AI_PAYOUT_MODEL, annars samma standard som rådgivaren. */
export function payoutModelFrom(env: Env): { apiKey: string; model: string } | null {
  const config = advisorConfigFrom({
    ...env,
    AI_ADVISOR_MODEL: env.AI_PAYOUT_MODEL?.trim() || DEFAULT_ADVISOR_MODEL,
  });
  return config.status === "ready" ? { apiKey: config.apiKey, model: config.model } : null;
}

export function createAnthropicPayoutReader(options: {
  apiKey: string;
  model: string;
  client?: Anthropic;
}): PayoutReaderModel {
  const client =
    options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 1, timeout: 60_000 });
  return {
    model: options.model,
    async read(input) {
      const content: Anthropic.Beta.BetaContentBlockParam[] =
        input.kind === "pdf"
          ? [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: input.base64 },
              },
            ]
          : input.kind === "image"
            ? [
                {
                  type: "image",
                  source: { type: "base64", media_type: input.mediaType, data: input.base64 },
                },
              ]
            : [
                {
                  type: "text",
                  text: `Rapporten som text (CSV/Excel):\n\n${input.text.slice(0, 200_000)}`,
                },
              ];
      content.push({ type: "text", text: "Läs utbetalningen ur rapporten." });
      const message = await client.beta.messages.create({
        model: options.model,
        max_tokens: 8000,
        output_config: { effort: "low" },
        system: [{ type: "text", text: INSTRUCTIONS }],
        tools: [EXTRACT_TOOL],
        // "auto": modellen avvisar tvingade verktygsanrop (se brief/model.ts).
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content }],
      });
      const call = message.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock =>
          b.type === "tool_use" && b.name === EXTRACT_TOOL_NAME,
      );
      return {
        toolInput: message.stop_reason === "max_tokens" ? null : (call?.input ?? null),
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

/** Kronor (tal från modellen) till öre: högst två decimaler, annars null. */
export function krToOre(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const ore = Math.round(v * 100);
  if (Math.abs(v * 100 - ore) > 1e-6 * Math.max(1, Math.abs(v * 100))) return null;
  return ore;
}

export type AiReadResult =
  | {
      readonly ok: true;
      readonly extracted: ExtractedPayout;
      readonly warnings: ExtractWarning[];
      readonly runId: string;
    }
  | {
      readonly ok: false;
      readonly reason: "off" | "demo" | "budget" | "rate" | "too_large" | "invalid" | "error";
      readonly message: string;
      readonly runId?: string;
    };

/** Tolkar verktygsanropet till ett utkast (rent, testat utan modell). */
export function extractedFromTool(
  input: unknown,
): { ok: true; extracted: ExtractedPayout; warnings: ExtractWarning[] } | { ok: false } {
  const parsed = extractToolInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  const t = parsed.data;
  if (t.currency && !/^(sek|kr)$/i.test(t.currency.trim())) return { ok: false };
  const ai: string[] = [];
  const mark = <T>(name: string, v: T | null): T | null => {
    if (v !== null) ai.push(name);
    return v;
  };
  const abs = (v: number | null) => (v === null ? null : Math.abs(v));
  const extracted: ExtractedPayout = {
    paidOn: mark("paidOn", parseLooseDate(t.paid_on ?? null)),
    amountOre: mark("amountOre", krToOre(t.amount_kr)),
    feesOre: mark("feesOre", abs(krToOre(t.fees_kr))),
    grossOre: mark("grossOre", krToOre(t.gross_kr)),
    refundsOre: mark("refundsOre", abs(krToOre(t.refunds_kr))),
    periodFrom: mark("periodFrom", parseLooseDate(t.period_from ?? null)),
    periodTo: mark("periodTo", parseLooseDate(t.period_to ?? null)),
    transactions: (t.transactions ?? []).flatMap((x) => {
      const ore = krToOre(x.amount_kr);
      return ore === null
        ? []
        : [
            {
              id: x.id?.trim() || null,
              date: parseLooseDate(x.date ?? null),
              amountOre: ore,
              deviceSerial: x.device_serial?.trim() || null,
            },
          ];
    }),
    devices: (t.devices ?? []).flatMap((d) => {
      const ore = krToOre(d.amount_kr);
      return ore === null ? [] : [{ serial: d.serial.trim(), amountOre: ore }];
    }),
    aiFields: ai,
    confidence: t.confidence ?? "low",
  };
  const warnings: ExtractWarning[] = [];
  if (extracted.amountOre === null) warnings.push({ code: "NO_AMOUNT" });
  checkSums(extracted, warnings);
  return { ok: true, extracted, warnings };
}

async function rateLimited(db: Db, orgId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const [row] = Array.from(
    await db.execute(sql`
      select count(*)::int as n from public.ai_runs
      where organization_id = ${orgId}::uuid and purpose = 'payout_read'
        and created_at >= ${since}::timestamptz`),
  ) as { n: number }[];
  return (row?.n ?? 0) >= AI_READS_PER_DAY;
}

/** Läser rapporten med AI (se filhuvudet). `db` = systemets databas (ai_runs skrivs av servern). */
export async function readPayoutWithAi(args: {
  readonly db: Db;
  readonly organizationId: string;
  readonly organizationSlug: string | null;
  readonly userId: string | null;
  readonly input: ReaderInput;
  readonly byteLength: number;
  readonly env?: Env;
  readonly now?: Date;
  readonly reader?: PayoutReaderModel;
}): Promise<AiReadResult> {
  const env = args.env ?? process.env;
  const now = args.now ?? new Date();
  if (args.byteLength > AI_MAX_FILE_BYTES) {
    return { ok: false, reason: "too_large", message: "Filen är för stor (högst 10 MB)." };
  }
  if (isDemoBlocked(args.organizationSlug, env)) {
    return {
      ok: false,
      reason: "demo",
      message: "I demon läser AI inte rapporter. Fyll i för hand.",
    };
  }
  const config = args.reader ? null : payoutModelFrom(env);
  if (!args.reader && !config) {
    return { ok: false, reason: "off", message: "AI är inte påslaget. Fyll i för hand." };
  }
  const budget = await budgetState(args.db, now, env);
  if (budget.exceeded) {
    return { ok: false, reason: "budget", message: "AI-budgeten är slut, fyll i för hand." };
  }
  if (await rateLimited(args.db, args.organizationId, now)) {
    return {
      ok: false,
      reason: "rate",
      message: `AI har läst ${AI_READS_PER_DAY} rapporter i dag. Fyll i för hand eller försök i morgon.`,
    };
  }
  const reader = args.reader ?? createAnthropicPayoutReader(config!);
  const [run] = Array.from(
    await args.db.execute(sql`
      insert into public.ai_runs (organization_id, trigger, purpose, status, model, created_by)
      values (${args.organizationId}::uuid, 'upload', 'payout_read', 'running', ${reader.model.slice(0, 100)}, ${args.userId}::uuid)
      returning id`),
  ) as { id: string }[];
  const runId = run!.id;
  const { usdSek } = budgetFrom(env);
  const started = Date.now();
  const finish = async (
    status: "ok" | "error",
    usage: TokenUsage | null,
    model: string,
    error?: string,
  ) => {
    const u = usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await args.db.execute(sql`
      update public.ai_runs set status = ${status}, model = ${model.slice(0, 100)},
        input_tokens = ${u.inputTokens}, output_tokens = ${u.outputTokens},
        cache_read_tokens = ${u.cacheReadTokens}, cache_write_tokens = ${u.cacheWriteTokens},
        cost_ore = ${costOre(model, u, usdSek)}, error = ${error?.slice(0, 2000) ?? null},
        duration_ms = ${Math.max(0, Date.now() - started)}
      where id = ${runId}::uuid`);
  };
  let response: ReaderResponse;
  try {
    response = await reader.read(args.input);
  } catch (error) {
    await finish(
      "error",
      null,
      reader.model,
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: false,
      reason: "error",
      message: "AI kunde inte läsa rapporten. Fyll i för hand.",
      runId,
    };
  }
  const result = extractedFromTool(response.toolInput);
  if (!result.ok) {
    await finish("error", response.usage, response.model, "Ogiltigt svar från modellen.");
    return {
      ok: false,
      reason: "invalid",
      message: "AI kunde inte läsa rapporten. Fyll i för hand.",
      runId,
    };
  }
  await finish("ok", response.usage, response.model);
  return { ok: true, extracted: result.extracted, warnings: result.warnings, runId };
}
