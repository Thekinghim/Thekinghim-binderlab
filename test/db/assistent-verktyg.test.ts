/**
 * Assistentens verktyg (src/server/assistant/tools) mot testdatabasen.
 *
 * - Talen är desamma som beräkningslagret ger för samma indata (verktygen räknar inget själva).
 * - Påfyllaren får bara lagerverktyg, och lagerverktygen returnerar inga belopp.
 * - Ekonomiverktygen nekas påfyllaren även om de anropas direkt (laddaren kastar).
 * - Namn och koder slås upp; tvetydiga namn ger ett verktygsfel med kandidater.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { keyMetrics, profitability } from "@/domain";
import { AuthorizationError } from "@/server/access";
import { toolContextFor } from "@/server/assistant/service";
import { ALL_TOOLS, toModelTool, toolsForRole, ToolInputError } from "@/server/assistant/tools";
import { keyMetricsTool, profitabilityTool } from "@/server/assistant/tools/economy";
import { forecastTool, purchasingTool } from "@/server/assistant/tools/purchasing";
import {
  coverageTool,
  lookupTool,
  salesTool,
  stockTool,
  todosTool,
} from "@/server/assistant/tools/stock";
import { loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";

import { seedAssistantFixture, viewerFor, type AssistantFixture } from "./assistent-fixture";
import { createMember } from "./helpers";

const NOW = new Date("2025-03-12T09:00:00Z");
const MARCH = { fran: "2025-03-01", till: "2025-03-31" };

/** Nycklar och texter som bara får förekomma i ekonomidata. */
const ECONOMY = /"[a-zA-Z]*(Ore|Bp)"\s*:|\bkr\b|intakt|vinst|marginal/i;

let fx: AssistantFixture;
let owner: Viewer;
let refiller: Viewer;
let reader: Viewer;

beforeAll(async () => {
  fx = await seedAssistantFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
});

describe("urval per roll", () => {
  it("påfyllaren får bara lagerverktyg", () => {
    expect(toolsForRole("refiller").map((t) => t.name)).toEqual([
      "salda_pack",
      "lager",
      "rackvidd",
      "att_gora",
      "hitta",
    ]);
  });

  it("ägare och admin får alla verktyg; läsaren alla utom Att göra", () => {
    expect(toolsForRole("owner")).toHaveLength(ALL_TOOLS.length);
    expect(toolsForRole("admin")).toHaveLength(ALL_TOOLS.length);
    expect(toolsForRole("viewer").map((t) => t.name)).not.toContain("att_gora");
    expect(toolsForRole("viewer").map((t) => t.name)).toContain("nyckeltal");
  });

  it("verktygsdefinitionerna är giltiga JSON Schema-objekt utan $schema", () => {
    for (const tool of ALL_TOOLS) {
      const def = toModelTool(tool);
      expect(def.name).toMatch(/^[a-z_]+$/);
      expect(def.input_schema.type).toBe("object");
      expect(def.input_schema).not.toHaveProperty("$schema");
      expect(def.description!.length).toBeGreaterThan(40);
    }
  });
});

describe("ekonomiverktyg (ägare)", () => {
  it("nyckeltal ger samma tal som keyMetrics på samma indata", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const out = await keyMetricsTool.run(ctx, keyMetricsTool.input.parse(MARCH));
    const input = await loadDomainInputFor(
      owner,
      { period: { start: "2025-03-01", end: "2025-03-12" } },
      NOW,
    );
    const expected = keyMetrics(input.current);
    const data = out.data as { period: { till: string }; nyckeltal: Record<string, unknown> };
    // Perioden kapas vid i dag.
    expect(data.period.till).toBe("2025-03-12");
    expect(data.nyckeltal.intaktOre).toBe(expected.revenueOre);
    expect(data.nyckeltal.vinstOre).toBe(expected.profitOre);
    expect(data.nyckeltal.order).toBe(7);
    expect(out.summary).toContain("7 order");
    expect(out.links[0]!.href).toBe("/lonsamhet?from=2025-03-01&to=2025-03-12");
  });

  it("lönsamhet per titel rankar på vinst och ger samma vinst som profitability", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const out = await profitabilityTool.run(
      ctx,
      profitabilityTool.input.parse({ ...MARCH, per: "titel" }),
    );
    const input = await loadDomainInputFor(
      owner,
      { period: { start: "2025-03-01", end: "2025-03-12" } },
      NOW,
    );
    const expected = profitability(input.current, "title");
    const rows = (out.data as { rader: Array<{ id: string; vinstOre: number; namn: string }> })
      .rader;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.vinstOre).toBeGreaterThanOrEqual(rows[1]!.vinstOre);
    for (const row of rows) {
      expect(row.vinstOre).toBe(expected.rows.find((r) => r.key === row.id)!.profitOre);
    }
    expect(rows.map((r) => r.namn).sort()).toEqual([
      "Pokémon 151 Booster",
      "Surging Sparks Booster",
    ]);
  });

  it("slår upp automat på kod och ger ett verktygsfel med kandidater för okända namn", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const out = await profitabilityTool.run(
      ctx,
      profitabilityTool.input.parse({ ...MARCH, per: "titel", automat: "bl-001" }),
    );
    expect(out.summary).toContain("Automat 1 (BL-001)");
    await expect(
      profitabilityTool.run(
        ctx,
        profitabilityTool.input.parse({ ...MARCH, per: "titel", automat: "BL-999" }),
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("nekar perioder som börjar efter i dag eller är baklänges", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    await expect(
      keyMetricsTool.run(
        ctx,
        keyMetricsTool.input.parse({ fran: "2025-04-01", till: "2025-04-30" }),
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      keyMetricsTool.run(
        ctx,
        keyMetricsTool.input.parse({ fran: "2025-03-10", till: "2025-03-01" }),
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
    expect(keyMetricsTool.input.safeParse({ fran: "2025-02-30", till: "2025-03-01" }).success).toBe(
      false,
    );
    expect(keyMetricsTool.input.safeParse({ ...MARCH, sql: "select 1" }).success).toBe(false);
  });

  it("läsaren får ekonomi men ingen Att göra-lista", async () => {
    const ctx = toolContextFor(reader, "viewer", NOW);
    const out = await keyMetricsTool.run(ctx, keyMetricsTool.input.parse(MARCH));
    expect((out.data as { nyckeltal: { order: number } }).nyckeltal.order).toBe(7);
  });

  it("inköpsförslag och prognos räknas via laddaren för Prognos & inköp", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const plan = await purchasingTool.run(ctx, purchasingTool.input.parse({ visa: "alla" }));
    expect(plan.links[0]!.href).toBe("/prognos");
    expect(Array.isArray((plan.data as { rader: unknown[] }).rader)).toBe(true);
    const forecast = await forecastTool.run(
      ctx,
      forecastTool.input.parse({ vecka: 1, per: "totalt" }),
    );
    expect(forecast.summary.length).toBeGreaterThan(10);
  });
});

describe("påfyllaren", () => {
  it("ekonomiverktygen nekas av laddaren även om de anropas direkt", async () => {
    const ctx = toolContextFor(refiller, "refiller", NOW);
    await expect(keyMetricsTool.run(ctx, keyMetricsTool.input.parse(MARCH))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      profitabilityTool.run(ctx, profitabilityTool.input.parse({ ...MARCH, per: "automat" })),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(purchasingTool.run(ctx, purchasingTool.input.parse({}))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("lagerverktygen svarar utan belopp", async () => {
    const ctx = toolContextFor(refiller, "refiller", NOW);
    const outputs = await Promise.all([
      stockTool.run(ctx, stockTool.input.parse({})),
      coverageTool.run(ctx, coverageTool.input.parse({ automat: "BL-001" })),
      salesTool.run(ctx, salesTool.input.parse({ ...MARCH, per: "titel" })),
      todosTool.run(ctx, todosTool.input.parse({})),
      lookupTool.run(ctx, lookupTool.input.parse({})),
    ]);
    for (const out of outputs) {
      expect(JSON.stringify({ d: out.data, f: out.figures, s: out.summary })).not.toMatch(ECONOMY);
    }
    const sales = outputs[2]!.data as {
      packTotalt: number;
      rader: Array<{ namn: string; pack: number }>;
    };
    expect(sales.packTotalt).toBe(7);
    expect(sales.rader).toEqual([
      expect.objectContaining({ namn: "Pokémon 151 Booster", pack: 4 }),
      expect.objectContaining({ namn: "Surging Sparks Booster", pack: 3 }),
    ]);
    const stock = outputs[0]!.data as {
      rader: Array<{ plats: string; titel: string; iLager: number }>;
    };
    expect(
      stock.rader.find((r) => r.plats === "Automat 1 (BL-001)" && r.titel === "Pokémon 151 Booster")
        ?.iLager,
    ).toBe(9);
    expect(outputs[2]!.links[0]!.href).toBe("/lager");
  });

  it("räckvidden räknas med försäljningstakten ur lagret", async () => {
    const ctx = toolContextFor(refiller, "refiller", NOW);
    const out = await coverageTool.run(
      ctx,
      coverageTool.input.parse({ automat: "BL-001", fonster: 14 }),
    );
    const rows = (
      out.data as {
        rader: Array<{
          titel: string;
          iLager: number;
          saldaIFonstret: number;
          dagarKvar: number | null;
        }>;
      }
    ).rader;
    const pokemon = rows.find((r) => r.titel === "Pokémon 151 Booster")!;
    // 3 sålda på 14 dagar, 9 kvar: golv(9 × 14 / 3) = 42 dagar (daysOfStockLeft).
    expect(pokemon.saldaIFonstret).toBe(3);
    expect(pokemon.iLager).toBe(9);
    expect(pokemon.dagarKvar).toBe(42);
  });
});
