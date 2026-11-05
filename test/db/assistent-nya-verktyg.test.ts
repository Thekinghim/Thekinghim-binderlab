/**
 * Assistentens nya verktyg mot den lilla fixturen (mars 2025): samma tal som
 * beräkningslagret, rollerna (påfyllaren nekas ekonomi av laddaren och får aldrig belopp)
 * och knapparna (bara navigering, bara sidor rollen ser).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { currentPriceEconomics } from "@/app/(app)/inkopspriser/_lib/price-economics";
import { keyMetrics, profitability } from "@/domain";
import { AuthorizationError } from "@/server/access";
import { toolContextFor } from "@/server/assistant/service";
import { ToolInputError } from "@/server/assistant/tools";
import { actionsTool } from "@/server/assistant/tools/actions";
import {
  bookkeepingTool,
  changeTool,
  contractsTool,
  lostSalesTool,
  machineStatusTool,
  ourStockTool,
  patternTool,
  pricesTool,
  storeShareTool,
  syncTool,
  visitPlanTool,
} from "@/server/assistant/tools/business";
import { loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";

import { seedAssistantFixture, viewerFor, type AssistantFixture } from "./assistent-fixture";
import { createMember } from "./helpers";

const NOW = new Date("2025-03-12T09:00:00Z");
const MARCH = { fran: "2025-03-01", till: "2025-03-12" };
const ECONOMY = /"[a-zA-Z]*(Ore|Bp)"\s*:|\bkr\b/;

let fx: AssistantFixture;
let owner: Viewer;
let refiller: Viewer;

beforeAll(async () => {
  fx = await seedAssistantFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
});

describe("ekonomi: samma tal som beräkningslagret", () => {
  it("inkopspriser ger hela beloppet per order som standard, som sidan", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const out = await pricesTool.run(ctx, pricesTool.input.parse(MARCH));
    const data = await loadDomainInputFor(
      owner,
      { period: { start: MARCH.fran, end: MARCH.till } },
      NOW,
    );
    const expected = currentPriceEconomics({ ...data.current, titleIds: [...fx.titleIds] });
    const d = out.data as { butikensAndelVisas: boolean; rader: Array<Record<string, unknown>> };
    expect(d.butikensAndelVisas).toBe(false);
    for (const e of expected) {
      const row = d.rader.find((r) => r.id === e.titleId)!;
      expect(row.kvarPerOrderOre).toBe(e.leftBeforeStoreOre);
      expect(row.marginalBp).toBe(e.marginBeforeStoreBp);
      expect(row.order).toBe(e.orders);
      expect(row).not.toHaveProperty("butikensAndelPerOrderOre");
      if (!e.lossWarning) expect(row).not.toHaveProperty("varDelPerOrderOre");
    }
    expect(out.links[0]!.href).toContain("/inkopspriser");
    expect(out.links[0]!.href).not.toContain("andel=1");
  });

  it("inkopspriser med butik eller visa_andel ger butikens andel och vår del", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const data = await loadDomainInputFor(
      owner,
      { period: { start: MARCH.fran, end: MARCH.till }, storeId: fx.storeId },
      NOW,
    );
    const expected = currentPriceEconomics({ ...data.current, titleIds: [...fx.titleIds] });
    const out = await pricesTool.run(
      ctx,
      pricesTool.input.parse({ ...MARCH, butik: "ICA Assistent" }),
    );
    const d = out.data as { butikensAndelVisas: boolean; rader: Array<Record<string, unknown>> };
    expect(d.butikensAndelVisas).toBe(true);
    let withShare = 0;
    for (const e of expected) {
      const row = d.rader.find((r) => r.id === e.titleId)!;
      expect(row.kvarPerOrderOre).toBe(e.leftBeforeStoreOre);
      expect(row.butikensAndelPerOrderOre).toBe(e.storeSharePerOrderOre);
      expect(row.varDelPerOrderOre).toBe(e.leftPerOrderOre);
      if ((e.storeSharePerOrderOre ?? 0) !== 0) withShare++;
    }
    // Fixturens butik har 10 % provision: delningen syns.
    expect(withShare).toBeGreaterThan(0);

    const all = await pricesTool.run(ctx, pricesTool.input.parse({ ...MARCH, visa_andel: true }));
    expect((all.data as { butikensAndelVisas: boolean }).butikensAndelVisas).toBe(true);
    expect(all.links[0]!.href).toContain("andel=1");
  });

  it("butiksandel: butikens ersättning är profitability per butik", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const out = await storeShareTool.run(
      ctx,
      storeShareTool.input.parse({ ...MARCH, butik: "ICA Assistent" }),
    );
    const data = await loadDomainInputFor(
      owner,
      { period: { start: MARCH.fran, end: MARCH.till }, storeId: fx.storeId },
      NOW,
    );
    const store = profitability(data.current, "store").rows.find((r) => r.key === fx.storeId)!;
    const d = out.data as { butiksersattningTotaltOre: number; avtal: { andelBp: number } };
    expect(d.butiksersattningTotaltOre).toBe(store.compensationOre);
    expect(d.avtal.andelBp).toBe(1000);
  });

  it("forandring: vinstförändringen är skillnaden mot perioden före", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const out = await changeTool.run(
      ctx,
      changeTool.input.parse({ fran: "2025-03-07", till: "2025-03-12", per: "automat" }),
    );
    const data = await loadDomainInputFor(
      owner,
      {
        period: { start: "2025-03-07", end: "2025-03-12" },
        compare: { start: "2025-03-01", end: "2025-03-06" },
      },
      NOW,
    );
    const diff = keyMetrics(data.current).profitOre - keyMetrics(data.previous!).profitOre;
    expect((out.data as { vinstForandringOre: number }).vinstForandringOre).toBe(diff);
  });

  it("tid_monster räknar alla order per veckodag", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    const out = await patternTool.run(ctx, patternTool.input.parse({ ...MARCH, per: "veckodag" }));
    const d = out.data as { orderTotalt: number; rader: Array<{ order: number }> };
    expect(d.orderTotalt).toBe(7);
    expect(d.rader.reduce((n, r) => n + r.order, 0)).toBe(7);
  });

  it("slutsalt, avtal, bokföring och synk svarar för ägaren", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    for (const [tool, input] of [
      [lostSalesTool, MARCH],
      [contractsTool, {}],
      [bookkeepingTool, {}],
      [syncTool, {}],
    ] as const) {
      const out = await (tool as typeof syncTool).run(
        ctx,
        (tool as typeof syncTool).input.parse(input) as never,
      );
      expect(out.summary.length, tool.name).toBeGreaterThan(10);
      expect(out.links.length, tool.name).toBeGreaterThan(0);
    }
  });

  it("perioden måste ha både fran och till", async () => {
    const ctx = toolContextFor(owner, "owner", NOW);
    await expect(
      storeShareTool.run(ctx, storeShareTool.input.parse({ fran: "2025-03-01" })),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("påfyllaren", () => {
  it("de nya ekonomiverktygen nekas av laddaren även om de anropas direkt", async () => {
    const ctx = toolContextFor(refiller, "refiller", NOW);
    await expect(pricesTool.run(ctx, pricesTool.input.parse(MARCH))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(changeTool.run(ctx, changeTool.input.parse(MARCH))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(storeShareTool.run(ctx, storeShareTool.input.parse({}))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(bookkeepingTool.run(ctx, {})).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("besöksplan, status och vårt lager svarar utan belopp", async () => {
    const ctx = toolContextFor(refiller, "refiller", NOW);
    for (const out of [
      await visitPlanTool.run(ctx, {}),
      await machineStatusTool.run(ctx, {}),
      await ourStockTool.run(ctx, {}),
    ]) {
      expect(JSON.stringify(out.data)).not.toMatch(ECONOMY);
      expect(out.summary).not.toMatch(/\bkr\b/);
    }
  });
});

describe("knappar (foresla_knapp)", () => {
  it("bygger adressen själv och bara till sidor rollen ser", async () => {
    const owners = await actionsTool.run(toolContextFor(owner, "owner", NOW), {
      knappar: [
        {
          typ: "inkopspris",
          etikett: "Gå till Inköpspriser för 151",
          titel: "Pokémon 151 Booster",
        },
        { typ: "pafyllning", etikett: "Öppna påfyllning för BL-002", automat: "BL-002" },
        { typ: "inkopslista", etikett: "Skapa inköpslista" },
      ],
    });
    expect(owners.actions).toEqual([
      { label: "Gå till Inköpspriser för 151", href: `/inkopspriser?titel=${fx.titleIds[0]}` },
      { label: "Öppna påfyllning för BL-002", href: `/lager?automat=${fx.machineIds[1]}` },
      { label: "Skapa inköpslista", href: "/prognos#inkopsforslag" },
    ]);
    const refillers = await actionsTool.run(toolContextFor(refiller, "refiller", NOW), {
      knappar: [
        { typ: "inkopspris", etikett: "Inköpspriser", titel: "Pokémon 151 Booster" },
        { typ: "pafyllning", etikett: "Påfyllning", automat: "BL-001" },
      ],
    });
    expect(refillers.actions).toEqual([
      { label: "Påfyllning", href: `/lager?automat=${fx.machineIds[0]}` },
    ]);
  });
});
