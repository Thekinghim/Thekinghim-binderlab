/**
 * Lager- och stamdataverktyg. Alla roller, även påfyllaren: inga belopp.
 *
 * Talen kommer från laddarna (loadStockFor, loadSalesCountsFor, loadTodosFor, RLS) och
 * @/domain (dailyUnits, salesVelocity, daysOfStockLeft, stockoutDate).
 */

import "server-only";

import { z } from "zod";

import {
  addDays,
  daysOfStockLeft,
  salesVelocity,
  stockoutDate,
  type DailyUnits,
  type IsoDate,
} from "@/domain";
import { todayIn } from "@/components/shell/period-state";
import { formatDate, formatDecimal } from "@/lib/format";
import { normalize } from "@/lib/fuzzy";
import { loadSlotPeriodsFor, withoutRetired } from "@/server/data/assortment";
import {
  businessToday,
  loadSalesCountsFor,
  loadStockFor,
  loadTodosFor,
} from "@/server/data/core/loaders";
import { ALL_ROLES, canSeeEconomy } from "@/server/data/core/types";

import {
  count,
  defineTool,
  kr,
  nameMaps,
  pageHref,
  periodFrom,
  periodSchema,
  periodText,
  resolveOne,
  resolveScope,
  resolveTitle,
  scopeSchema,
  scopeText,
  type ToolContext,
} from "./common";

/** Roller med Att göra-lista (läsaren har ingen). */
const TODO_ROLES = ["owner", "admin", "refiller"] as const;

/** "13 okt. 2026" (src/lib/format). */
function dateText(date: IsoDate | null): string {
  if (!date) return "–";
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return formatDate(new Date(y, m - 1, d), { year: "always" });
}

/** Tidpunkt (ISO 8601) som datum i organisationens tidszon. */
function instantDateText(iso: string | null, timeZone: string): string {
  if (!iso) return "–";
  const instant = new Date(iso);
  return Number.isNaN(instant.getTime())
    ? "–"
    : formatDate(todayIn(instant, timeZone), { year: "always" });
}

// ---------------------------------------------------------------------------
// hitta (stamdata)
// ---------------------------------------------------------------------------

const lookupInput = z
  .object({
    typ: z
      .enum(["automater", "butiker", "titlar", "alla"])
      .optional()
      .describe("Vad som ska listas. Standard: alla."),
    sok: z.string().min(1).max(100).optional().describe("Del av namn eller kod att söka på."),
  })
  .strict();

export const lookupTool = defineTool({
  name: "hitta",
  title: "Automater, butiker och titlar",
  label: (input) => (input.sok ? `Sök "${input.sok}"` : "Automater, butiker och titlar"),
  description:
    "Listar organisationens automater (namn, kod, butik de står i), butiker och titlar, med id. Använd när användaren nämner en automat, butik eller titel med ett namn du inte känner igen, eller för att räkna hur många det finns.",
  roles: ALL_ROLES,
  input: lookupInput,
  async run(ctx: ToolContext, input) {
    const master = await ctx.master();
    const names = nameMaps(master);
    const typ = input.typ ?? "alla";
    const q = input.sok ? normalize(input.sok) : null;
    const hit = (...fields: Array<string | null | undefined>) =>
      q === null || fields.some((f) => f && normalize(f).includes(q));
    const machines =
      typ === "alla" || typ === "automater"
        ? master.machines
            .filter((m) => hit(m.name, m.code))
            .map((m) => ({
              id: m.id,
              namn: m.name,
              kod: m.code,
              butik: m.storeId ? (names.store.get(m.storeId) ?? null) : null,
              status: m.archived
                ? "arkiverad"
                : m.activeTo && m.activeTo < ctx.today
                  ? "ur drift"
                  : "i drift",
            }))
        : [];
    const stores =
      typ === "alla" || typ === "butiker"
        ? master.stores
            .filter((s) => hit(s.name, s.address))
            .map((s) => ({ id: s.id, namn: s.name, adress: s.address, arkiverad: s.archived }))
        : [];
    const titles =
      typ === "alla" || typ === "titlar"
        ? master.titles
            .filter((t) => !t.mergedIntoId && hit(t.name, t.series))
            .map((t) => ({ id: t.id, namn: t.name, serie: t.series, arkiverad: t.archived }))
        : [];
    return {
      summary: `${count(machines.length)} automater, ${count(stores.length)} butiker och ${count(titles.length)} titlar${q ? ` som matchar "${input.sok}"` : ""}.`,
      data: { automater: machines, butiker: stores, titlar: titles.slice(0, 200) },
      figures: [
        { label: "Automater", value: count(machines.length) },
        { label: "Butiker", value: count(stores.length) },
        { label: "Titlar", value: count(titles.length) },
      ],
      links: [
        { label: "Automater", href: "/automater" },
        { label: "Butiker", href: "/butiker" },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// lager
// ---------------------------------------------------------------------------

const stockInput = z
  .object({
    plats: z
      .enum(["automater", "centrallager", "alla"])
      .optional()
      .describe("Var: automater, centrallager eller alla (standard)."),
    automat: scopeSchema.automat,
    titel: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Begränsa till en titel (namn eller id)."),
    antal: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Högst så många rader. Standard 50."),
  })
  .strict();

export const stockTool = defineTool({
  name: "lager",
  title: "Lagersaldo",
  label: () => "Lagersaldo",
  description:
    "Lagersaldo just nu i pack per lagerplats (automater och centrallager) och titel, med senaste påfyllning. Lägst saldo först. Använd för 'hur många finns kvar', 'vad finns i centrallagret'.",
  roles: ALL_ROLES,
  input: stockInput,
  async run(ctx: ToolContext, input) {
    const master = await ctx.master();
    const names = nameMaps(master);
    const machine = input.automat ? resolveOne(master.machines, input.automat, "automat") : null;
    const title = input.titel ? resolveTitle(master, input.titel) : null;
    const plats = input.plats ?? (machine ? "automater" : "alla");
    const stock = await loadStockFor(ctx.viewer);
    const rows = stock.rows
      .filter((r) =>
        plats === "automater"
          ? r.locationKind === "machine"
          : plats === "centrallager"
            ? r.isCentral
            : true,
      )
      .filter((r) => !machine || r.machineId === machine.id)
      .filter((r) => !title || r.titleId === title.id)
      .sort((a, b) => a.onHand - b.onHand || a.locationName.localeCompare(b.locationName, "sv"));
    const limit = input.antal ?? 50;
    const total = rows.reduce((sum, r) => sum + r.onHand, 0);
    const empty = rows.filter((r) => r.onHand <= 0).length;
    const placeName = (r: (typeof rows)[number]) => {
      if (r.machineId) {
        const m = names.machine.get(r.machineId);
        return m ? `${m.name} (${m.code})` : r.locationName;
      }
      return r.locationName;
    };
    return {
      summary: `${count(rows.length)} rader, ${count(total)} pack totalt${empty ? `, ${count(empty)} tomma` : ""}.`,
      data: {
        plats,
        antalRader: rows.length,
        visade: Math.min(limit, rows.length),
        packTotalt: total,
        tomma: empty,
        rader: rows.slice(0, limit).map((r) => ({
          plats: placeName(r),
          typ: r.isCentral ? "centrallager" : r.locationKind === "machine" ? "automat" : "lager",
          titel: names.title.get(r.titleId) ?? r.titleId,
          iLager: r.onHand,
          senastPafylld: instantDateText(r.lastRestockedAt, ctx.timeZone),
        })),
      },
      figures: [
        { label: "Pack i lager", value: count(total) },
        { label: "Tomma rader", value: count(empty) },
      ],
      links: [{ label: "Lager", href: pageHref("/lager", null, { machineId: machine?.id }) }],
    };
  },
});

// ---------------------------------------------------------------------------
// salda_pack
// ---------------------------------------------------------------------------

const salesInput = z
  .object({
    ...periodSchema,
    ...scopeSchema,
    per: z.enum(["automat", "titel", "dag"]).optional().describe("Gruppering. Standard: titel."),
    antal: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe("Högst så många rader. Standard 15."),
  })
  .strict();

export const salesTool = defineTool({
  name: "salda_pack",
  title: "Sålda pack",
  label: (input) => `Sålda pack per ${input.per ?? "titel"}`,
  description:
    "Antal sålda pack i en period per titel, automat eller dag (ur lagerhändelserna, utan belopp). Mest sålda först (per dag: i datumordning). Använd för 'vad säljer bäst', 'hur många pack sålde BL-002'.",
  roles: ALL_ROLES,
  input: salesInput,
  async run(ctx: ToolContext, input) {
    const period = periodFrom(ctx, input);
    const scope = await resolveScope(ctx, input);
    const master = await ctx.master();
    const names = nameMaps(master);
    const sales = await loadSalesCountsFor(ctx.viewer, {
      period,
      machineId: scope.machine?.id ?? null,
      storeId: scope.store?.id ?? null,
    });
    const per = input.per ?? "titel";
    const groups = new Map<string, number>();
    for (const r of sales.rows) {
      const key = per === "dag" ? r.date : per === "automat" ? (r.machineId ?? "–") : r.titleId;
      groups.set(key, (groups.get(key) ?? 0) + r.units);
    }
    const label = (key: string) => {
      if (per === "dag") return dateText(key);
      if (per === "automat") {
        const m = names.machine.get(key);
        return m ? `${m.name} (${m.code})` : "Utan automat";
      }
      return names.title.get(key) ?? key;
    };
    const rows = [...groups.entries()]
      .sort((a, b) =>
        per === "dag" ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
      )
      .slice(0, input.antal ?? 15)
      .map(([key, units], i) => ({ plats: i + 1, namn: label(key), id: key, pack: units }));
    return {
      summary: `${periodText(period)}${scopeText(scope)}: ${count(sales.units)} sålda pack${rows[0] && per !== "dag" ? `, flest ${rows[0].namn} (${count(rows[0].pack)})` : ""}.`,
      data: {
        period: { fran: period.start, till: period.end, text: periodText(period) },
        per,
        packTotalt: sales.units,
        antalGrupper: groups.size,
        rader: rows,
      },
      figures: [
        { label: "Sålda pack", value: count(sales.units) },
        ...rows.slice(0, 4).map((r) => ({ label: r.namn, value: `${count(r.pack)} pack` })),
      ],
      links: [
        canSeeEconomy(ctx.role)
          ? {
              label: "Order",
              href: pageHref("/order", period, {
                machineId: scope.machine?.id,
                storeId: scope.store?.id,
              }),
            }
          : { label: "Lager", href: "/lager" },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// rackvidd
// ---------------------------------------------------------------------------

const coverageInput = z
  .object({
    automat: scopeSchema.automat,
    titel: z.string().min(1).max(200).optional().describe("Begränsa till en titel."),
    fonster: z
      .union([z.literal(7), z.literal(14), z.literal(28)])
      .optional()
      .describe("Dagar bakåt som försäljningstakten räknas på: 7, 14 (standard) eller 28."),
    antal: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Högst så många rader. Standard 20."),
  })
  .strict();

export const coverageTool = defineTool({
  name: "rackvidd",
  title: "Räckvidd",
  label: () => "Räckvidd i automaterna",
  description:
    "Hur många dagar lagret i varje automat räcker per titel, vid försäljningstakten de senaste 7/14/28 hela dagarna: i lager, sålda pack i fönstret, takt per dag, dagar kvar och beräknat slutdatum. Kortast räckvidd först. Använd för 'vad behöver fyllas på', 'när tar 151 slut i BL-002'.",
  roles: ALL_ROLES,
  input: coverageInput,
  async run(ctx: ToolContext, input) {
    const master = await ctx.master();
    const names = nameMaps(master);
    const machine = input.automat ? resolveOne(master.machines, input.automat, "automat") : null;
    const title = input.titel ? resolveTitle(master, input.titel) : null;
    const days = input.fonster ?? 14;
    const asOf = addDays(ctx.today, -1); // senaste hela dagen
    const window = { start: addDays(asOf, -(days - 1)), end: asOf };
    const [stock, sales] = await Promise.all([
      loadStockFor(ctx.viewer),
      loadSalesCountsFor(ctx.viewer, { period: window, machineId: machine?.id ?? null }),
    ]);
    const daily = new Map<string, DailyUnits[]>();
    for (const r of sales.rows) {
      if (!r.machineId) continue;
      const key = `${r.machineId}:${r.titleId}`;
      const list = daily.get(key) ?? [];
      list.push({ date: r.date, units: r.units });
      daily.set(key, list);
    }
    const rows = stock.machineStock
      .filter((s) => !machine || s.machineId === machine.id)
      .filter((s) => !title || s.titleId === title.id)
      .filter((s) => {
        const m = names.machine.get(s.machineId);
        return m && !m.archived && (!m.activeTo || m.activeTo >= ctx.today);
      })
      .map((s) => {
        const m = names.machine.get(s.machineId)!;
        const velocity = salesVelocity(daily.get(`${s.machineId}:${s.titleId}`) ?? [], {
          asOf,
          days,
          ...(m.activeFrom ? { activeFrom: m.activeFrom } : {}),
        });
        const left = daysOfStockLeft(s.onHand, velocity);
        return {
          automat: `${m.name} (${m.code})`,
          automatId: m.id,
          titel: names.title.get(s.titleId) ?? s.titleId,
          iLager: s.onHand,
          saldaIFonstret: velocity.units,
          dagarIFonstret: velocity.days,
          taktPerDag: formatDecimal(velocity.perDay),
          dagarKvar: left,
          slutDatum: dateText(stockoutDate(asOf, s.onHand, velocity)),
        };
      })
      .sort(
        (a, b) =>
          (a.dagarKvar ?? Number.POSITIVE_INFINITY) - (b.dagarKvar ?? Number.POSITIVE_INFINITY) ||
          a.automat.localeCompare(b.automat, "sv"),
      );
    const shown = rows.slice(0, input.antal ?? 20);
    const under3 = rows.filter((r) => r.dagarKvar !== null && r.dagarKvar < 3).length;
    const first = shown[0];
    return {
      summary: first
        ? `Takt över ${days} dagar t.o.m. ${dateText(asOf)}. Kortast räckvidd: ${first.titel} i ${first.automat}, ${first.iLager} i lager, ${first.dagarKvar ?? "–"} dagar kvar. ${count(under3)} rader räcker under 3 dagar.`
        : "Inget lager i automaterna.",
      data: {
        fonster: { dagar: days, fran: window.start, till: window.end },
        antalRader: rows.length,
        underTreDagar: under3,
        anmarkning: "dagarKvar = golv(i lager / takt). null = ingen försäljning i fönstret.",
        rader: shown,
      },
      figures: shown.slice(0, 5).map((r) => ({
        label: `${r.titel} · ${r.automat}`,
        value: `${r.iLager} i lager · ${r.dagarKvar === null ? "ingen försäljning" : `${r.dagarKvar} dagar`}`,
      })),
      links: [
        { label: "Lager", href: pageHref("/lager", null, { machineId: machine?.id }) },
        { label: "Att göra", href: "/att-gora" },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// att_gora
// ---------------------------------------------------------------------------

const todosInput = z
  .object({
    antal: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Högst så många punkter. Standard 15."),
  })
  .strict();

const LEVEL: Record<string, string> = {
  now: "i dag",
  soon: "de närmaste dagarna",
  later: "när tid finns",
};

export const todosTool = defineTool({
  name: "att_gora",
  title: "Att göra",
  label: () => "Att göra",
  description:
    "Punkterna i Att göra just nu, mest brådskande först: påfyllning, tysta automater, saknade inköpspriser, dubbletter av titlar, rapporter att skicka. Varje punkt har text, underlag och länk. Påfyllare får bara påfyllning och tysta automater.",
  roles: TODO_ROLES,
  input: todosInput,
  async run(ctx: ToolContext, input) {
    // Samma punkter som Att göra: inga påfyllningar av utgångna titlar.
    const [all, periods] = await Promise.all([
      loadTodosFor(ctx.viewer, ctx.now),
      loadSlotPeriodsFor(ctx.viewer),
    ]);
    const todos = withoutRetired(
      all,
      periods,
      businessToday(ctx.now, ctx.viewer.organization.timezone),
    );
    const shown = todos.slice(0, input.antal ?? 15);
    const economy = canSeeEconomy(ctx.role);
    return {
      summary:
        todos.length === 0
          ? "Inget att göra just nu."
          : `${count(todos.length)} punkter. Först: ${shown[0]!.title}.`,
      data: {
        antal: todos.length,
        punkter: shown.map((t) => ({
          text: t.title,
          detalj: t.detail,
          brattom: LEVEL[t.level] ?? t.level,
          dagarKvar: t.daysLeft,
          ...(economy && t.atStakeOre !== null ? { intaktIRiskSjuDagar: kr(t.atStakeOre) } : {}),
          regel: t.evidence.rule,
          lank: t.link,
        })),
      },
      figures: shown.slice(0, 5).map((t) => ({ label: t.title, value: t.detail })),
      links: [{ label: "Att göra", href: "/att-gora" }],
    };
  },
});
