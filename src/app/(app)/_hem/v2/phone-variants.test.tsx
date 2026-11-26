/**
 * Telefonens varianter på Hem (och Pengars månadstabell) ritas av servern, inte efter
 * hydreringen: samma HTML på alla skärmar, och CSS (≤ 900 px) döljer det telefonen inte ska
 * visa. Förut gav usePhone() falskt på servern, så telefonen fick först datorns rader och
 * etiketter och sedan ett hopp.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../rutt/actions", () => ({ changeRoute: vi.fn(), undoRouteChange: vi.fn() }));

import type { HemAction } from "@/analytics/home-v2/actions";
import type { DaySales, DaySalesRow } from "@/analytics/day-sales";
import { DaySalesCard } from "@/components/v2/day-sales";
import type { MonthTable } from "@/server/data/v2/analytics/money-model";

import { MonthsTable } from "../../pengar/_components/months-table";
import { ActionsList } from "./actions-card";
import type { GeoCard } from "./cards-data";
import { GeoBody } from "./geo-body";

const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

function action(i: number): HemAction {
  return {
    key: `a${i}`,
    kind: "fyll-pa",
    machineId: `m${i}`,
    code: `NA-0${i}`,
    title: `Automat ${i}`,
    sub: "Butik",
    badge: "Fyll på",
    tone: "warning",
    fillBp: 2000,
    packs: 10,
    daysLeft: 2,
    offlineSince: null,
    phone: null,
    contactName: null,
  };
}

const actions = (n: number) => Array.from({ length: n }, (_, i) => action(i));
const list = (n: number) =>
  renderToStaticMarkup(
    <ActionsList rows={actions(n)} nowIso="2026-11-26T08:00:00Z" canRoute inRoute={[]} />,
  );

describe("Kräver åtgärd", () => {
  it("ritar datorns sex rader; rad 4–6 göms på telefon och knappen bara där", () => {
    const html = list(5);
    expect(count(html, /class="arow[^"]*"/g)).toBe(5);
    expect(count(html, /class="arow ph-x"/g)).toBe(2);
    expect(html).toContain('class="lk amore text-left ph-only"');
    expect(html).toContain("Visa alla 5");
  });

  it("med fler än sex: knappen syns överallt", () => {
    const html = list(9);
    expect(count(html, /class="arow[^"]*"/g)).toBe(6);
    expect(count(html, /class="arow ph-x"/g)).toBe(3);
    expect(html).toContain('class="lk amore text-left"');
  });

  it("tre eller färre: ingen knapp och inget dolt", () => {
    const html = list(3);
    expect(html).not.toContain("ph-x");
    expect(html).not.toContain("amore");
  });
});

describe("Vinst per stad", () => {
  const geo = (n: number): GeoCard => ({
    cities: Array.from({ length: n }, (_, i) => ({
      city: `Stad ${i}`,
      machines: 1,
      profitOre: 100_000 - i * 1000,
      revenueOre: 200_000,
      perMachineOre: 100_000,
      shareBp: 1000,
    })) as unknown as GeoCard["cities"],
    machines: [],
    totalOre: 1_000_000,
    perMachineOre: 100_000,
  });

  it("ritar tio rader; rad 6–10 göms på telefon", () => {
    const html = renderToStaticMarkup(<GeoBody data={geo(7)} />);
    expect(count(html, /class="x-br[^"]*"/g)).toBe(7);
    expect(count(html, /class="x-br ph-x"/g)).toBe(2);
    expect(html).toContain('class="x-more ph-only"');
  });

  it("fler än tio: Visa alla syns överallt", () => {
    const html = renderToStaticMarkup(<GeoBody data={geo(12)} />);
    expect(count(html, /class="x-br[^"]*"/g)).toBe(10);
    expect(html).toContain('class="x-more"');
  });
});

describe("Sålt (phoneTop)", () => {
  const row = (i: number): DaySalesRow => ({
    id: `t${i}`,
    name: `Titel ${i}`,
    units: 10 - i,
    revenueOre: 1000,
    profitOre: 500,
  });
  const sales = (n: number): DaySales => ({
    units: 40,
    revenueOre: 10_000,
    unpricedRevenueOre: null,
    profitOre: 5000,
    titles: Array.from({ length: n }, (_, i) => row(i)),
    machines: [row(0)],
    hours: [],
    economy: true,
  });

  it("fem titlar: en Visa alla som bara telefonen visar (.ph)", () => {
    const html = renderToStaticMarkup(
      <DaySalesCard sales={sales(5)} title="Sålt i går" inline="i går" phoneTop />,
    );
    expect(html).toContain('class="v2-card v2-ds v2-ds-c"');
    expect(html).toContain('<details class="ph"><summary>Visa alla 5</summary>');
  });

  it("utan phoneTop: som förut", () => {
    const html = renderToStaticMarkup(
      <DaySalesCard sales={sales(5)} title="Sålt i går" inline="i går" />,
    );
    expect(html).not.toMatch(/v2-ds-c[" ]/);
    expect(html).not.toContain("<details");
  });
});

describe("Vinst per automat · 12 mån", () => {
  it("är öppen i HTML:en men markerad data-auto, så att telefonen fäller ihop den med CSS", () => {
    const table: MonthTable = {
      months: [{ month: "2026-10", running: false }],
      rows: [{ machineId: "m1", code: "NA-01", name: "Automat", values: [1000], averageOre: 1000 }],
      totals: [1000],
      totalAverageOre: 1000,
      maxOre: 1000,
    };
    const html = renderToStaticMarkup(<MonthsTable table={table} />);
    expect(html).toMatch(/<details class="v2-card g4-year" open="" data-auto="">/);
  });
});
