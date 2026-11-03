/**
 * Prognos- och inköpsverktyg: försäljningsprognos för kommande dagar och inköpsförslag
 * (vad som ska beställas, hur mycket och när). Bara ägare, admin och läsare: förslaget
 * innehåller inköpspriser och ordervärde.
 *
 * Talen räknas av @/analytics (forecastSales, purchasePlan) via serverladdaren för
 * Prognos & inköp (src/server/purchasing, loadPrognosFor), som läser som användaren.
 */

import "server-only";

import { z } from "zod";

import { packs } from "@/analytics/forecast";
import type { AggregateForecast, ForecastTotal } from "@/analytics/forecast/types";
import type { PurchaseLine } from "@/analytics/purchasing/types";
import { addDays } from "@/domain";
import { loadPrognosFor } from "@/server/purchasing";
import { ECONOMY_ROLES } from "@/server/data/core/types";

import {
  count,
  defineTool,
  kr,
  nameMaps,
  pageHref,
  periodText,
  resolveTitle,
  type ToolContext,
} from "./common";

const STATUS_TEXT: Record<PurchaseLine["status"], string> = {
  order: "beställ",
  ok: "räcker",
  "no-supplier": "saknar leverantör",
  "no-demand": "ingen efterfrågan",
};

async function loadPlan(ctx: ToolContext) {
  const asOf = addDays(ctx.today, -1);
  return loadPrognosFor(ctx.viewer, { period: { start: addDays(asOf, -6), end: asOf } }, ctx.now);
}

// ---------------------------------------------------------------------------
// inkopsforslag
// ---------------------------------------------------------------------------

const purchasingInput = z
  .object({
    titel: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Begränsa till en titel (namn eller id)."),
    visa: z
      .enum(["bestall", "alla"])
      .optional()
      .describe("bestall (standard): bara titlar som ska beställas. alla: även de som räcker."),
  })
  .strict();

export const purchasingTool = defineTool({
  name: "inkopsforslag",
  title: "Inköpsförslag",
  label: () => "Inköpsförslag",
  description:
    "Inköpsförslag i dag per titel och leverantör, utifrån försäljningsprognosen, lagret i våra egna lager (alla tillsammans) och automater, redan beställt, ledtid, säkerhetslager (95 % servicenivå), minsta order och boxstorlek: antal pack och boxar att beställa, ordervärde, väntad leverans, när lagret annars tar slut och senaste dag att beställa. Använd för 'vad ska jag beställa', 'behöver vi köpa in inför nästa vecka'.",
  roles: ECONOMY_ROLES,
  input: purchasingInput,
  async run(ctx: ToolContext, input) {
    const master = await ctx.master();
    const names = nameMaps(master);
    const title = input.titel ? resolveTitle(master, input.titel) : null;
    const data = await loadPlan(ctx);
    const supplierName = new Map(data.suppliers.map((s) => [s.id, s.name]));
    const lines = data.plan.lines
      .filter((l) => !title || l.titleId === title.id)
      .filter((l) => (input.visa ?? "bestall") === "alla" || l.status === "order")
      .slice(0, 40);
    const toOrder = data.plan.lines.filter((l) => l.status === "order");
    const orders = data.plan.orders;
    return {
      summary:
        toOrder.length === 0
          ? `Inget behöver beställas i dag (${count(data.plan.lines.length)} titlar i planen).`
          : `${count(toOrder.length)} titlar att beställa hos ${count(orders.length)} leverantörer, totalt ${kr(data.plan.totalOre)}. ${data.plan.text}`,
      data: {
        idag: data.today,
        sammanfattning: data.plan.text,
        totaltVarde: kr(data.plan.totalOre),
        totaltVardeOre: data.plan.totalOre,
        inkopsorder: orders.map((o) => ({
          leverantor: supplierName.get(o.supplierId) ?? o.supplierId,
          pack: o.totalPacks,
          varde: kr(o.totalOre),
          vardeOre: o.totalOre,
          vantadLeverans: o.expectedArrival,
          text: o.text,
        })),
        rader: lines.map((l) => ({
          titel: names.title.get(l.titleId) ?? l.titleId,
          status: STATUS_TEXT[l.status],
          leverantor: l.supplierId ? (supplierName.get(l.supplierId) ?? l.supplierId) : null,
          bestallPack: l.orderQty,
          boxar: l.boxes,
          packPerBox: l.packSize,
          prisPerPack: kr(l.unitCostOre),
          varde: kr(l.orderValueOre),
          vardeOre: l.orderValueOre,
          iVartLager: l.warehouseOnHand,
          iAutomater: l.machineOnHand,
          redanBestalltSomRaknas: l.onOrderCounted,
          bestallningsniva: packs(l.targetMilli),
          behovUnderLedtidOchIntervall: packs(l.demandProtectionMilli),
          sakerhetslager: packs(l.safetyStockMilli),
          ledtidDagar: l.leadTimeDays,
          vantadLeverans: l.expectedArrival,
          raeckerDagar: l.coverDays,
          tarSlut: l.projectedStockout,
          senastBestallningsdag: l.orderBy,
          forSent: l.late,
          text: l.text,
        })),
        anmarkning:
          "Beställningsnivå = efterfrågan under ledtid + 7 dagars intervall + säkerhetslager. Förslaget avrundas uppåt till minsta order och hela boxar.",
      },
      figures: [
        { label: "Titlar att beställa", value: count(toOrder.length) },
        { label: "Ordervärde", value: kr(data.plan.totalOre) },
        ...toOrder.slice(0, 4).map((l) => ({
          label: names.title.get(l.titleId) ?? l.titleId,
          value: `${count(l.orderQty)} pack (${count(l.boxes)} boxar) · ${kr(l.orderValueOre)}`,
        })),
      ],
      links: [{ label: "Inköp", href: "/prognos" }],
    };
  },
});

// ---------------------------------------------------------------------------
// prognos
// ---------------------------------------------------------------------------

const forecastInput = z
  .object({
    vecka: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional()
      .describe("Vilken av de fyra kommande veckorna (7 dagar från i dag): 1 (standard) … 4."),
    per: z.enum(["titel", "automat", "totalt"]).optional().describe("Uppdelning. Standard: titel."),
    antal: z
      .number()
      .int()
      .min(1)
      .max(40)
      .optional()
      .describe("Högst så många rader. Standard 15."),
  })
  .strict();

function totalData(t: ForecastTotal) {
  return {
    period: { fran: t.period.start, till: t.period.end, text: periodText(t.period) },
    pack: packs(t.unitsMilli),
    packMilli: t.unitsMilli,
    packLag: packs(t.unitsLowMilli),
    packHog: packs(t.unitsHighMilli),
    intakt: kr(t.revenueOre),
    intaktOre: t.revenueOre,
    intaktLag: kr(t.revenueLowOre),
    intaktHog: kr(t.revenueHighOre),
  };
}

export const forecastTool = defineTool({
  name: "prognos",
  title: "Prognos",
  label: (input) => `Prognos vecka ${input.vecka ?? 1}`,
  description:
    "Försäljningsprognos för en av de fyra kommande veckorna (7 dagar från i dag) per titel, per automat eller totalt: pack och intäkt med 80 %-intervall, och prognosens träffsäkerhet de senaste veckorna. Använd för 'hur mycket säljer vi nästa vecka', 'vilka titlar går åt mest framöver'.",
  roles: ECONOMY_ROLES,
  input: forecastInput,
  async run(ctx: ToolContext, input) {
    const master = await ctx.master();
    const names = nameMaps(master);
    const data = await loadPlan(ctx);
    const week = (input.vecka ?? 1) - 1;
    const per = input.per ?? "titel";
    const groups: readonly AggregateForecast[] =
      per === "titel"
        ? data.forecast.byTitle
        : per === "automat"
          ? data.forecast.byMachine
          : [data.forecast.total];
    const label = (key: string) => {
      if (per === "titel") return names.title.get(key) ?? key;
      if (per === "automat") {
        const m = names.machine.get(key);
        return m ? `${m.name} (${m.code})` : key;
      }
      return "Totalt";
    };
    const rows = groups
      .map((g) => ({ key: g.key, t: g.weeks[week] }))
      .filter((r): r is { key: string; t: ForecastTotal } => r.t !== undefined)
      .sort((a, b) => b.t.unitsMilli - a.t.unitsMilli)
      .slice(0, input.antal ?? 15);
    const total = data.forecast.total.weeks[week];
    return {
      summary: total
        ? `${periodText(total.period)}: prognos ${packs(total.unitsMilli)} pack (80 %: ${packs(total.unitsLowMilli)}–${packs(total.unitsHighMilli)}) och ${kr(total.revenueOre)} i intäkt.`
        : "Ingen prognos (för lite data).",
      data: {
        sistaDagMedData: data.asOf,
        totalt: total ? totalData(total) : null,
        rader: rows.map((r) => ({ namn: label(r.key), id: r.key, ...totalData(r.t) })),
        trafsakerhet: data.forecast.accuracy.text,
        anmarkning:
          "Pack och intäkt är väntevärden; intervallet täcker utfallet ungefär 4 gånger av 5.",
      },
      figures: [
        ...(total
          ? [
              {
                label: "Pack",
                value: `${packs(total.unitsMilli)} (${packs(total.unitsLowMilli)}–${packs(total.unitsHighMilli)})`,
              },
              { label: "Intäkt", value: kr(total.revenueOre) },
            ]
          : []),
        ...rows
          .slice(0, 3)
          .map((r) => ({ label: label(r.key), value: `${packs(r.t.unitsMilli)} pack` })),
      ],
      links: [{ label: "Inköp", href: pageHref("/prognos", null) }],
    };
  },
});
