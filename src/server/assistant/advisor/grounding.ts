/**
 * Rådgivarens svar: schemat för verktyget spara_forslag, tolkning och kontroll.
 *
 * Ett förslag sparas bara om
 * - det följer schemat (fält, längder, säkerhet),
 * - varje tal i rubrik, motivering och åtgärd finns i underlaget (verifyNumbers, samma
 *   kontroll som assistentens svar), och
 * - den uppskattade effekten är rimlig: inte negativ och högst vinsten för 30 dagar.
 * Effekten är en uppskattning och behöver inte stå i underlaget.
 *
 * Ren modul (testas i grounding.test.ts).
 */

import { z } from "zod";

import { parseSwedishNumber, verifyNumbers } from "../verify";

export const ADVISOR_TOOL_NAME = "spara_forslag";
export const MAX_SUGGESTIONS = 5;

const CONFIDENCE = { hog: "high", medel: "medium", lag: "low" } as const;

/** Verktyget som modellen ska anropa en gång med förslagen (strikt schema). */
export const ADVISOR_TOOL = {
  name: ADVISOR_TOOL_NAME,
  description:
    "Spara dagens förslag. Anropa exakt en gång med 1–5 förslag, viktigast först. Inga förslag utan stöd i underlaget.",
  strict: true,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["forslag"],
    properties: {
      forslag: {
        type: "array",
        description: "1–5 förslag, viktigast först.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["titel", "varfor", "atgard", "effekt_kr_per_manad", "sakerhet"],
          properties: {
            titel: { type: "string", description: "Högst 8 ord, utan tal." },
            varfor: {
              type: "string",
              description: "En mening med talen från underlaget, skrivna exakt som där.",
            },
            atgard: { type: "string", description: "En mening: vad ska göras, var och när." },
            effekt_kr_per_manad: {
              type: "integer",
              description: "Uppskattad effekt på vinsten i kronor per månad (heltal, 0 om okänt).",
            },
            sakerhet: { type: "string", enum: ["hog", "medel", "lag"] },
          },
        },
      },
    },
  },
};

const rawSuggestion = z.object({
  titel: z.string(),
  varfor: z.string(),
  atgard: z.string(),
  effekt_kr_per_manad: z.number(),
  sakerhet: z.enum(["hog", "medel", "lag"]),
});
const rawInput = z.object({ forslag: z.array(z.unknown()) });

export interface Suggestion {
  readonly rank: number;
  readonly title: string;
  readonly why: string;
  readonly action: string;
  readonly effectSekMonth: number;
  readonly confidence: "high" | "medium" | "low";
}

export interface Rejection {
  readonly title: string;
  readonly reason: string;
}

export interface CheckedSuggestions {
  readonly accepted: Suggestion[];
  readonly rejected: Rejection[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const words = (s: string) => s.split(" ").filter(Boolean).length;

/**
 * Tolkar verktygets indata och kontrollerar varje förslag mot underlaget.
 * `maxEffectSek`: övre gräns för effekten (vinsten för 30 dagar i kronor).
 */
export function checkSuggestions(
  input: unknown,
  snapshot: unknown,
  options: { maxEffectSek: number },
): CheckedSuggestions {
  const parsed = rawInput.safeParse(input);
  if (!parsed.success) {
    return { accepted: [], rejected: [{ title: "(svaret)", reason: "fel format" }] };
  }
  const accepted: Suggestion[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();

  for (const item of parsed.data.forslag) {
    const r = rawSuggestion.safeParse(item);
    if (!r.success) {
      rejected.push({ title: "(okänt)", reason: "fel format" });
      continue;
    }
    const title = clean(r.data.titel);
    const why = clean(r.data.varfor);
    const action = clean(r.data.atgard);
    const reject = (reason: string) => rejected.push({ title: title.slice(0, 80), reason });

    if (accepted.length >= MAX_SUGGESTIONS) {
      reject("fler än fem");
      continue;
    }
    if (!title || !why || !action) {
      reject("tomt fält");
      continue;
    }
    if (words(title) > 8 || title.length > 80) {
      reject("rubriken är längre än 8 ord");
      continue;
    }
    if (why.length > 400 || action.length > 300) {
      reject("för lång text");
      continue;
    }
    const effect = r.data.effekt_kr_per_manad;
    if (!Number.isInteger(effect) || effect < 0) {
      reject("effekten är inte ett heltal ≥ 0");
      continue;
    }
    if (effect > Math.max(0, Math.round(options.maxEffectSek))) {
      reject("effekten är större än månadens vinst");
      continue;
    }
    const check = verifyNumbers(`${title}\n${why}\n${action}`, [snapshot]);
    if (check.unverified.length > 0) {
      reject(`tal utanför underlaget: ${check.unverified.slice(0, 5).join(", ")}`);
      continue;
    }
    if (check.checked === 0) {
      reject("motiveringen saknar tal");
      continue;
    }
    const key = title.toLowerCase();
    if (seen.has(key)) {
      reject("dubblett");
      continue;
    }
    seen.add(key);
    accepted.push({
      rank: accepted.length + 1,
      title,
      why,
      action,
      effectSekMonth: effect,
      confidence: CONFIDENCE[r.data.sakerhet],
    });
  }
  return { accepted, rejected };
}

/** Kronor ur underlagets "12 480 kr" (0 om den saknas). */
export function revenueSek(formatted: string): number {
  const token = formatted.replace(/\s*kr$/, "");
  return parseSwedishNumber(token) ?? 0;
}
