/**
 * Lokal källa för marknadspriser, för utveckling och test. Läser en JSON-fil (standard
 * .data/market-prices.json, gitignorerad) som utvecklaren själv fyller i:
 *
 *   {
 *     "prices": [
 *       { "title": "Surging Sparks", "productName": "Surging Sparks Booster Pack",
 *         "kind": "booster-pack", "currency": "SEK", "priceMinor": 5490,
 *         "priceType": "lowest", "observedOn": "2026-11-01", "url": null }
 *     ]
 *   }
 *
 * Titeln matchas mot panelens titelnamn utan hänsyn till skiftläge och mellanslag.
 * Panelen märker priserna "Lokal testkälla" så att de aldrig kan tas för riktiga priser.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { isIsoDate, type IsoDate } from "@/domain";

import type { MarketPricePoint, MarketPriceQuery, MarketPriceSource } from "./types";

export function defaultLocalFile(): string {
  return path.resolve(process.cwd(), ".data", "market-prices.json");
}

const pointSchema = z.object({
  title: z.string().trim().min(1),
  productName: z.string().trim().min(1),
  kind: z.enum(["booster-pack", "booster-box", "elite-trainer-box", "other"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceMinor: z.number().int().min(0),
  priceType: z.string().trim().min(1).default("lowest"),
  observedOn: z.string().refine(isIsoDate, "observedOn ska vara ÅÅÅÅ-MM-DD."),
  url: z.string().url().nullable().default(null),
});

const fileSchema = z.object({ prices: z.array(pointSchema) });

/** Normaliserat titelnamn: gemener, enkla mellanslag. */
export function normalizeTitle(name: string): string {
  return name.trim().toLocaleLowerCase("sv-SE").replace(/\s+/g, " ");
}

/** Tolkar filens innehåll. Kastar ett svenskt fel om formatet är fel. */
export function parseLocalPrices(text: string): z.infer<typeof fileSchema> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Filen med lokala marknadspriser är inte giltig JSON.");
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Filen med lokala marknadspriser har fel format: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
    );
  }
  return parsed.data;
}

export class LocalMarketPriceSource implements MarketPriceSource {
  readonly id = "local" as const;
  readonly name = "Lokal testkälla";
  readonly localOnly = true;

  constructor(private readonly file: string = defaultLocalFile()) {}

  async fetchPrices(
    queries: readonly MarketPriceQuery[],
  ): Promise<ReadonlyMap<string, readonly MarketPricePoint[]>> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return new Map();
    }
    const data = parseLocalPrices(text);
    const byName = new Map<string, MarketPricePoint[]>();
    for (const p of data.prices) {
      const key = normalizeTitle(p.title);
      const point: MarketPricePoint = {
        source: "local",
        productName: p.productName,
        kind: p.kind,
        currency: p.currency,
        priceMinor: p.priceMinor,
        priceType: p.priceType,
        observedOn: p.observedOn as IsoDate,
        url: p.url,
      };
      const list = byName.get(key);
      if (list) list.push(point);
      else byName.set(key, [point]);
    }
    const out = new Map<string, readonly MarketPricePoint[]>();
    for (const q of queries) {
      const list = byName.get(normalizeTitle(q.titleName));
      if (list && list.length > 0) {
        out.set(
          q.titleId,
          [...list].sort((a, b) => (a.observedOn < b.observedOn ? -1 : 1)),
        );
      }
    }
    return out;
  }
}
