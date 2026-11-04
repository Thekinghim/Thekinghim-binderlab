/**
 * Verktyg för resten av verksamheten: butikernas andel enligt avtal, inköpspriser och
 * marginal per titel, förändring mot perioden före (varför vinsten ändrades), försäljning
 * per timme och veckodag, slutsålt (förlorad försäljning), vårt lager, besöksplan,
 * automaternas status, avtal, bokföringens månader och synken från Awish.
 *
 * Inget räknas här som sidorna inte räknar: talen kommer från samma laddare och
 * domänfunktioner som sidorna (src/domain, src/analytics, src/server/*), som läser som
 * användaren med RLS. Alla verktyg är läsande; rollerna kontrolleras av loopen och igen av
 * laddarna.
 */

import "server-only";

import { z } from "zod";

import {
  addDays,
  changeBp,
  monthEnd,
  profitability,
  titleEconomics,
  type IsoDate,
  type Period,
  type ProfitabilityRow,
  type StoreAgreement,
} from "@/domain";
import { ALL_COST_LINES } from "@/lib/cost-lines";
import { formatDate, formatDelta } from "@/lib/format";
import { titleRows, type TitleRow } from "@/app/(app)/inkopspriser/_lib/model";
import { loadOurStockFor } from "@/app/(app)/lager/_lib/data";
import { withUserDbFor } from "@/server/access";
import { loadContractsFor } from "@/server/accounting/service";
import { healthOf, loadHealthData } from "@/server/alerts/inputs";
import { loadBokforingFor } from "@/server/bokforing/service";
import { querySlotPeriods } from "@/server/data/assortment";
import { loadDomainInputFor, loadSyncInfoFor } from "@/server/data/core/loaders";
import { queryStock } from "@/server/data/core/queries";
import { ALL_ROLES, ECONOMY_ROLES } from "@/server/data/core/types";
import { weeklyVisitPlan } from "@/server/data/visit-plan";
import { lostSalesSummaryFor } from "@/server/purchasing";

import {
  count,
  defineTool,
  kr,
  nameMaps,
  pageHref,
  pct,
  periodBefore,
  periodFrom,
  periodSchema,
  periodText,
  resolveOne,
  resolveScope,
  scopeSchema,
  scopeText,
  ToolInputError,
  type ResolvedScope,
  type ToolContext,
} from "./common";
import { ownStockTotals } from "@/server/data/core/own-stock";

function scopeIds(scope: ResolvedScope) {
  return { machineId: scope.machine?.id ?? null, storeId: scope.store?.id ?? null };
}

function periodData(period: Period) {
  return { fran: period.start, till: period.end, text: periodText(period) };
}

function deltaText(bp: number | null): string {
  return bp === null ? "–" : formatDelta(bp / 10_000, Math.abs(bp) < 1000 ? 1 : 0);
}

/** "13 okt. 2026". */
function dateText(date: IsoDate | null): string {
  if (!date) return "–";
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return formatDate(new Date(y, m - 1, d), { year: "always" });
}

/** Belopp med tecken: "+1 240 kr", "−1 240 kr", "0 kr". */
function signedKr(ore: number): string {
  if (ore === 0) return kr(0);
  return ore > 0 ? `+${kr(ore)}` : `−${kr(-ore)}`;
}

/** De senaste `months` hela kalendermånaderna före i dag. */
function lastFullMonths(today: IsoDate, months: number): Period {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const endMonth = new Date(Date.UTC(y, m - 2, 1)); // förra månaden
  const startMonth = new Date(Date.UTC(y, m - 1 - months, 1));
  const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start: `${iso(startMonth)}-01`, end: monthEnd(iso(endMonth)) };
}

const optionalPeriod = {
  fran: periodSchema.fran.optional(),
  till: periodSchema.till.optional(),
};

/** Perioden ur parametrarna, eller standardperioden när de saknas. */
function periodOr(ctx: ToolContext, input: { fran?: string; till?: string }, fallback: Period) {
  if (input.fran && input.till) return periodFrom(ctx, { fran: input.fran, till: input.till });
  if (input.fran || input.till) {
    throw new ToolInputError("Ange både fran och till, eller ingen av dem.");
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// butiksandel
// ---------------------------------------------------------------------------

const MODEL_TEXT: Record<string, string> = {
  profit_after_costs: "vinstdelning (andel av vinsten efter kostnader)",
  net_excl_vat: "provision på nettointäkten",
};

function agreementData(a: StoreAgreement) {
  const base = a.commissionBase ?? "net_excl_vat";
  return {
    modell: MODEL_TEXT[base] ?? base,
    andel: a.commissionBp === null ? "–" : pct(a.commissionBp),
    andelBp: a.commissionBp,
    // Hyran bara när avtalet har någon (de flesta har ingen).
    ...(a.monthlyRentOre !== null && a.monthlyRentOre > 0
      ? { manadshyra: kr(a.monthlyRentOre), manadshyraOre: a.monthlyRentOre }
      : {}),
    vidForlust:
      base === "profit_after_costs"
        ? a.lossTreatment === "proportional"
          ? "butiken bär sin andel av förlusten"
          : "butiken får 0 kr (bär ingen förlust)"
        : null,
    vmbForeDelning: base === "profit_after_costs" ? Boolean(a.vmbBeforeSplit) : null,
    giltigtFran: a.validFrom,
    giltigtTill: a.validTo ?? "tills vidare",
  };
}

function currentAgreement(
  agreements: readonly StoreAgreement[],
  storeId: string,
  today: IsoDate,
): StoreAgreement | null {
  const mine = agreements
    .filter((a) => a.storeId === storeId && a.validFrom <= today)
    .filter((a) => a.validTo === null || a.validTo >= today)
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1));
  return mine[0] ?? null;
}

const storeShareInput = z
  .object({
    ...optionalPeriod,
    butik: scopeSchema.butik,
  })
  .strict();

export const storeShareTool = defineTool({
  name: "butiksandel",
  title: "Butikernas andel",
  label: (input) => (input.butik ? `Butikens andel: ${input.butik}` : "Butikernas andel"),
  description:
    "Vad butikerna får enligt sina avtal: butiksersättning (vinstandel eller provision, plus hyra bara om avtalet har hyra) per butik, och för en butik per månad med snitt per hel månad, plus avtalets villkor (modell, andel, hyra, vad som gäller vid förlust, VMB före delningen). Standardperiod: de tre senaste hela månaderna. Använd för 'hur mycket får Sega gubben i månaden', 'vad betalar vi butikerna'. Vinstdelningen är normalt 50/50 av vinsten efter kostnader.",
  roles: ECONOMY_ROLES,
  input: storeShareInput,
  async run(ctx: ToolContext, input) {
    const period = periodOr(ctx, input, lastFullMonths(ctx.today, 3));
    const scope = await resolveScope(ctx, { butik: input.butik });
    const data = await loadDomainInputFor(
      ctx.viewer,
      { period, compare: null, storeId: scope.store?.id ?? null, vmb: ctx.vmb },
      ctx.now,
    );
    const names = nameMaps(data);
    // Utan hyra i något avtal nämns ingen hyra (raderna vore 0 kr).
    const rent = (data.costLines ?? ALL_COST_LINES).rent;
    const rentOf = (ore: number) =>
      rent || ore !== 0 ? { varavHyra: kr(ore), varavHyraOre: ore } : {};
    if (scope.store) {
      const store = scope.store;
      const months = profitability(data.current, "month", { fillTimeGaps: true }).rows.filter(
        (r) => r.kind === "time",
      );
      const full = months.filter((r) => !r.partial);
      const total = months.reduce((n, r) => n + r.compensationOre, 0);
      const fullTotal = full.reduce((n, r) => n + r.compensationOre, 0);
      const avg = full.length > 0 ? Math.round(fullTotal / full.length) : null;
      const agreement = currentAgreement(data.sources.agreements, store.id, ctx.today);
      return {
        summary: `${store.name}, ${periodText(period)}: butiksersättning ${kr(total)}${avg !== null ? `, i snitt ${kr(avg)} per hel månad (${count(full.length)} månader)` : ""}.`,
        data: {
          period: periodData(period),
          butik: store.name,
          avtal: agreement ? agreementData(agreement) : "inget gällande avtal i dag",
          butiksersattningTotalt: kr(total),
          butiksersattningTotaltOre: total,
          snittPerHelManad: avg === null ? "–" : kr(avg),
          snittPerHelManadOre: avg,
          helaManader: full.length,
          manader: months.map((r) => ({
            manad: r.range ? periodText(r.range) : r.key,
            del: r.partial,
            butiksersattning: kr(r.compensationOre),
            butiksersattningOre: r.compensationOre,
            varavAndel: kr(r.commissionOre),
            varavAndelOre: r.commissionOre,
            ...rentOf(r.rentOre),
            vinstForOss: kr(r.profitOre),
            vinstForOssOre: r.profitOre,
            order: r.orders,
          })),
          anmarkning: rent
            ? "Butiksersättning = andel/provision + hyra, räknad som i Lönsamhet och Bokföring. Vinst för oss är efter butikens del."
            : "Butiksersättning = butikens andel/provision (ingen hyra), räknad som i Lönsamhet och Bokföring. Vinst för oss är efter butikens del.",
        },
        figures: [
          { label: "Butiksersättning", value: kr(total) },
          ...(avg !== null ? [{ label: "Snitt per hel månad", value: kr(avg) }] : []),
        ],
        links: [
          { label: store.name, href: pageHref(`/butiker/${store.id}`, period) },
          { label: "Kontrakt", href: "/avtal" },
        ],
      };
    }
    const rows = profitability(data.current, "store")
      .rows.filter((r) => r.kind === "item")
      .sort((a, b) => b.compensationOre - a.compensationOre);
    const total = rows.reduce((n, r) => n + r.compensationOre, 0);
    return {
      summary: `${periodText(period)}: butikerna får ${kr(total)} totalt${rows[0] ? `, mest ${names.store.get(rows[0].key) ?? rows[0].key} (${kr(rows[0].compensationOre)})` : ""}.`,
      data: {
        period: periodData(period),
        totalt: kr(total),
        totaltOre: total,
        butiker: rows.slice(0, 30).map((r) => {
          const a = currentAgreement(data.sources.agreements, r.key, ctx.today);
          return {
            butik: names.store.get(r.key) ?? r.key,
            id: r.key,
            butiksersattning: kr(r.compensationOre),
            butiksersattningOre: r.compensationOre,
            varavAndel: kr(r.commissionOre),
            varavAndelOre: r.commissionOre,
            ...rentOf(r.rentOre),
            vinstForOss: kr(r.profitOre),
            vinstForOssOre: r.profitOre,
            avtal: a ? agreementData(a) : "inget gällande avtal i dag",
          };
        }),
      },
      figures: rows.slice(0, 4).map((r) => ({
        label: names.store.get(r.key) ?? r.key,
        value: kr(r.compensationOre),
      })),
      links: [
        { label: "Butiker", href: pageHref("/butiker", period) },
        { label: "Kontrakt", href: "/avtal" },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// inkopspriser
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<TitleRow["status"], string> = {
  missing: "saknar inköpspris",
  loss: "går med förlust",
  partial: "inköpspris saknas för en del av perioden",
  "loss-after-rent": "går med förlust efter hyran",
  idle: "ingen försäljning",
  ok: "lönsam",
};

const pricesInput = z
  .object({
    ...periodSchema,
    ...scopeSchema,
    visa: z
      .enum(["alla", "forlust", "saknar_pris"])
      .optional()
      .describe(
        "alla (standard), forlust: bara titlar med förlust, saknar_pris: titlar som saknar inköpspris.",
      ),
    sortera: z
      .enum(["marginal", "kvar_per_order", "order"])
      .optional()
      .describe("marginal (standard, lägst först), kvar_per_order (lägst först) eller order."),
    antal: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe("Högst så många rader. Standard 20."),
  })
  .strict();

export const pricesTool = defineTool({
  name: "inkopspriser",
  title: "Inköpspriser och marginal",
  label: () => "Inköpspriser per titel",
  description:
    "Per titel som på sidan Inköpspriser: inköpspris i dag (det som är inmatat i appen är sanningen), snittpris per order, vad varje order lämnar efter inköp, avgifter och provision, marginal, vad som är kvar efter hyran (bara om något avtal har hyra), antal order och status (förlust, saknar pris, lönsam). Använd för 'vilka titlar går med förlust', 'vad kostar Perfect Order', 'vilken titel har bäst marginal'.",
  roles: ECONOMY_ROLES,
  input: pricesInput,
  async run(ctx: ToolContext, input) {
    const period = periodFrom(ctx, input);
    const scope = await resolveScope(ctx, input);
    const data = await loadDomainInputFor(
      ctx.viewer,
      { period, compare: null, ...scopeIds(scope), vmb: ctx.vmb },
      ctx.now,
    );
    const active = data.titles.filter((t) => !t.archived).map((t) => t.id);
    // Utan hyra i något avtal är "kvar per order" allt som blir kvar: inget "efter hyra".
    const rent = (data.costLines ?? ALL_COST_LINES).rent;
    const economics = titleEconomics({ ...data.current, titleIds: active });
    const unpriced = profitability(data.current, "title").unpriced;
    const all = titleRows(economics, data.titles, unpriced.byTitle);
    const visa = input.visa ?? "alla";
    const filtered = all.filter((r) =>
      visa === "forlust"
        ? r.status === "loss" || r.status === "loss-after-rent"
        : visa === "saknar_pris"
          ? r.status === "missing" || r.unpricedOrders > 0
          : true,
    );
    const sort = input.sortera ?? "marginal";
    const key = (r: TitleRow) =>
      sort === "order"
        ? -r.orders
        : sort === "kvar_per_order"
          ? (r.leftOre ?? Number.POSITIVE_INFINITY)
          : (r.marginBp ?? Number.POSITIVE_INFINITY);
    const rows = [...filtered].sort(
      (a, b) => key(a) - key(b) || a.name.localeCompare(b.name, "sv"),
    );
    const shown = rows.slice(0, input.antal ?? 20);
    const losses = all.filter((r) => r.status === "loss" || r.status === "loss-after-rent");
    const missing = all.filter((r) => r.status === "missing" || r.unpricedOrders > 0);
    return {
      summary: `${periodText(period)}${scopeText(scope)}: ${count(all.length)} titlar, ${count(losses.length)} med förlust, ${count(missing.length)} saknar inköpspris${shown[0] ? `. Först (${sort}): ${shown[0].name}, marginal ${pct(shown[0].marginBp)}` : ""}.`,
      data: {
        period: periodData(period),
        visa,
        sorterat: sort,
        antalTitlar: all.length,
        medForlust: losses.map((r) => r.name),
        saknarPris: missing.map((r) => r.name),
        rader: shown.map((r) => ({
          titel: r.name,
          id: r.id,
          status: STATUS_TEXT[r.status],
          inkopsprisIdag: r.currentCostOre === null ? "saknas" : kr(r.currentCostOre),
          inkopsprisIdagOre: r.currentCostOre,
          giltigtFran: r.currentFrom,
          snittprisPerOrder: r.averagePriceOre === null ? "–" : kr(r.averagePriceOre),
          snittprisPerOrderOre: r.averagePriceOre,
          kvarPerOrder: r.leftOre === null ? "–" : kr(r.leftOre),
          kvarPerOrderOre: r.leftOre,
          ...(rent
            ? {
                kvarEfterHyra: r.leftAfterRentOre === null ? "–" : kr(r.leftAfterRentOre),
                kvarEfterHyraOre: r.leftAfterRentOre,
              }
            : {}),
          marginal: pct(r.marginBp),
          marginalBp: r.marginBp,
          order: r.orders,
          orderUtanPris: r.unpricedOrders,
        })),
        anmarkning: rent
          ? "Kvar per order = snittpris exkl. moms − inköp − avgifter − provision. Kvar efter hyra drar även hyran per order."
          : "Kvar per order = snittpris exkl. moms − inköp − avgifter − provision (ingen hyra).",
      },
      figures: [
        { label: "Med förlust", value: count(losses.length) },
        { label: "Saknar pris", value: count(missing.length) },
        ...shown.slice(0, 3).map((r) => ({
          label: r.name,
          value: `${pct(r.marginBp)} · ${r.leftOre === null ? "–" : kr(r.leftOre)} per order`,
        })),
      ],
      links: [
        { label: "Inköpspriser", href: pageHref("/inkopspriser", period, scopeIds(scope)) },
        ...(shown[0]
          ? [
              {
                label: `Inköpspris för ${shown[0].name}`,
                href: `/inkopspriser?titel=${encodeURIComponent(shown[0].id)}`,
              },
            ]
          : []),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// forandring
// ---------------------------------------------------------------------------

const changeInput = z
  .object({
    ...periodSchema,
    ...scopeSchema,
    per: z
      .enum(["automat", "butik", "titel"])
      .optional()
      .describe("Vad som jämförs: automat, butik eller titel (standard)."),
    jamfor_fran: periodSchema.fran
      .optional()
      .describe("Jämförelseperiodens första dag. Standard: lika lång period direkt före."),
    jamfor_till: periodSchema.till.optional().describe("Jämförelseperiodens sista dag."),
    antal: z.number().int().min(1).max(30).optional().describe("Högst så många rader. Standard 8."),
  })
  .strict();

const CHANGE_GROUP = { automat: "machine", butik: "store", titel: "title" } as const;

export const changeTool = defineTool({
  name: "forandring",
  title: "Förändring mot perioden före",
  label: (input) => `Förändring per ${input.per ?? "titel"}`,
  description:
    "Varför vinsten eller intäkten ändrades: jämför perioden med lika lång period före (eller en vald jämförelseperiod), totalt uppdelat på intäkt, inköp, butiksersättning och VMB-moms, och per automat, butik eller titel med vinstförändringen i kronor och procent, största nedgången först (och största uppgången). Använd för 'varför gick vinsten ner', 'vad har ändrats sedan förra månaden', 'vilken automat tappade mest'.",
  roles: ECONOMY_ROLES,
  input: changeInput,
  async run(ctx: ToolContext, input) {
    const period = periodFrom(ctx, input);
    const scope = await resolveScope(ctx, input);
    const compare =
      input.jamfor_fran && input.jamfor_till
        ? periodFrom(ctx, { fran: input.jamfor_fran, till: input.jamfor_till })
        : periodBefore(period);
    const data = await loadDomainInputFor(
      ctx.viewer,
      { period, compare, ...scopeIds(scope), vmb: ctx.vmb },
      ctx.now,
    );
    const names = nameMaps(data);
    const per = input.per ?? "titel";
    const group = CHANGE_GROUP[per];
    const cur = profitability(data.current, group);
    const prev = profitability(data.previous!, group);
    const prevByKey = new Map(prev.rows.filter((r) => r.kind === "item").map((r) => [r.key, r]));
    const curByKey = new Map(cur.rows.filter((r) => r.kind === "item").map((r) => [r.key, r]));
    const keys = new Set([...prevByKey.keys(), ...curByKey.keys()]);
    const label = (key: string) => {
      if (group === "machine") {
        const m = names.machine.get(key);
        return m ? `${m.name} (${m.code})` : key;
      }
      if (group === "store") return names.store.get(key) ?? key;
      return names.title.get(key) ?? key;
    };
    const revenue = (r: ProfitabilityRow | undefined) =>
      r ? r.revenueOre + r.unpricedRevenueOre : 0;
    const rows = [...keys].map((key) => {
      const c = curByKey.get(key);
      const p = prevByKey.get(key);
      const diff = (c?.profitOre ?? 0) - (p?.profitOre ?? 0);
      return {
        namn: label(key),
        id: key,
        vinstNu: kr(c?.profitOre ?? 0),
        vinstNuOre: c?.profitOre ?? 0,
        vinstFore: kr(p?.profitOre ?? 0),
        vinstForeOre: p?.profitOre ?? 0,
        vinstForandring: signedKr(diff),
        vinstForandringOre: diff,
        vinstForandringProcent: deltaText(changeBp(c?.profitOre ?? 0, p?.profitOre ?? 0)),
        orderNu: c?.orders ?? 0,
        orderFore: p?.orders ?? 0,
        intaktNu: kr(revenue(c)),
        intaktFore: kr(revenue(p)),
      };
    });
    const drops = [...rows].sort((a, b) => a.vinstForandringOre - b.vinstForandringOre);
    const limit = input.antal ?? 8;
    const t = cur.totals;
    const pt = prev.totals;
    const parts = {
      intakt: signedKr(t.revenueOre + t.unpricedRevenueOre - pt.revenueOre - pt.unpricedRevenueOre),
      intaktOre: t.revenueOre + t.unpricedRevenueOre - pt.revenueOre - pt.unpricedRevenueOre,
      // Kostnader som ökar sänker vinsten: tecknet är kostnadens förändring.
      inkop: signedKr(t.costOre - pt.costOre),
      inkopOre: t.costOre - pt.costOre,
      butiksersattning: signedKr(t.compensationOre - pt.compensationOre),
      butiksersattningOre: t.compensationOre - pt.compensationOre,
      vmbMoms: signedKr(t.vmbVatOre - pt.vmbVatOre),
      vmbMomsOre: t.vmbVatOre - pt.vmbVatOre,
      avgifter: signedKr(t.feesOre - pt.feesOre),
      avgifterOre: t.feesOre - pt.feesOre,
    };
    const totalDiff = t.profitOre - pt.profitOre;
    const worst = drops[0];
    return {
      summary: `${periodText(period)} mot ${periodText(compare)}${scopeText(scope)}: vinst ${kr(t.profitOre)} mot ${kr(pt.profitOre)} (${signedKr(totalDiff)}, ${deltaText(changeBp(t.profitOre, pt.profitOre))}).${worst && worst.vinstForandringOre < 0 ? ` Störst nedgång: ${worst.namn} ${worst.vinstForandring}.` : ""}`,
      data: {
        period: periodData(period),
        jamforelseperiod: periodData(compare),
        per,
        vinstNu: kr(t.profitOre),
        vinstNuOre: t.profitOre,
        vinstFore: kr(pt.profitOre),
        vinstForeOre: pt.profitOre,
        vinstForandring: signedKr(totalDiff),
        vinstForandringOre: totalDiff,
        vinstForandringProcent: deltaText(changeBp(t.profitOre, pt.profitOre)),
        orderNu: t.orders,
        orderFore: pt.orders,
        orderForandringProcent: deltaText(changeBp(t.orders, pt.orders)),
        forandringPerDel: parts,
        storstNedgang: drops.slice(0, limit).filter((r) => r.vinstForandringOre < 0),
        storstUppgang: [...drops]
          .reverse()
          .slice(0, limit)
          .filter((r) => r.vinstForandringOre > 0),
        anmarkning:
          "forandringPerDel: intäktens förändring höjer vinsten; inköp, avgifter, butiksersättning och VMB-moms som ökar (+) sänker den.",
      },
      figures: [
        { label: "Vinst", value: `${kr(t.profitOre)} (${signedKr(totalDiff)})` },
        { label: "Intäkt", value: parts.intakt },
        ...drops
          .slice(0, 3)
          .filter((r) => r.vinstForandringOre < 0)
          .map((r) => ({ label: r.namn, value: r.vinstForandring })),
      ],
      links: [{ label: "Lönsamhet", href: pageHref("/lonsamhet", period, scopeIds(scope)) }],
    };
  },
});

// ---------------------------------------------------------------------------
// tid_monster
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

const patternInput = z
  .object({
    ...periodSchema,
    ...scopeSchema,
    per: z.enum(["timme", "veckodag"]).describe("timme (0–23, svensk tid) eller veckodag."),
  })
  .strict();

function hourIn(iso: string | undefined, timeZone: string): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const h = new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(d)
    .find((p) => p.type === "hour")?.value;
  return h === undefined ? null : Number(h);
}

function weekdayOf(date: IsoDate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export const patternTool = defineTool({
  name: "tid_monster",
  title: "Försäljning per timme och veckodag",
  label: (input) => `Försäljning per ${input.per}`,
  description:
    "Antal order (= sålda pack) och intäkt inkl. moms per timme på dygnet (svensk tid) eller per veckodag i en period, med andel av alla order och snitt per dag för veckodagar. Använd för 'när säljer vi mest', 'vilken veckodag är bäst', 'säljer automaten på kvällen'.",
  roles: ECONOMY_ROLES,
  input: patternInput,
  async run(ctx: ToolContext, input) {
    const period = periodFrom(ctx, input);
    const scope = await resolveScope(ctx, input);
    const data = await loadDomainInputFor(
      ctx.viewer,
      { period, compare: null, ...scopeIds(scope), vmb: ctx.vmb },
      ctx.now,
    );
    const orders = data.current.orders;
    const groups = new Map<number, { orders: number; grossOre: number }>();
    let unknown = 0;
    for (const o of orders) {
      const key =
        input.per === "timme" ? hourIn(o.orderedAt, ctx.timeZone) : weekdayOf(o.businessDate);
      if (key === null) {
        unknown += 1;
        continue;
      }
      const g = groups.get(key) ?? { orders: 0, grossOre: 0 };
      g.orders += 1;
      g.grossOre += o.amountOre;
      groups.set(key, g);
    }
    // Antal av varje veckodag i perioden (för snitt per dag).
    const dayCounts = new Map<number, number>();
    for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
      const w = weekdayOf(d);
      dayCounts.set(w, (dayCounts.get(w) ?? 0) + 1);
    }
    const total = orders.length;
    const label = (k: number) =>
      input.per === "timme"
        ? `${String(k).padStart(2, "0")}:00–${String(k).padStart(2, "0")}:59`
        : WEEKDAY_NAMES[k]!;
    const rows = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, g]) => ({
        namn: label(k),
        order: g.orders,
        andelAvOrder: pct(total > 0 ? Math.round((g.orders * 10_000) / total) : null),
        intakt: kr(g.grossOre),
        intaktOre: g.grossOre,
        ...(input.per === "veckodag"
          ? {
              dagarIPerioden: dayCounts.get(k) ?? 0,
              orderPerDag: (
                (g.orders / Math.max(1, dayCounts.get(k) ?? 1)) as number
              ).toLocaleString("sv-SE", { maximumFractionDigits: 1 }),
            }
          : {}),
      }));
    const best = [...rows].sort((a, b) => b.order - a.order)[0];
    return {
      summary: best
        ? `${periodText(period)}${scopeText(scope)}: flest order ${input.per === "timme" ? "kl." : "på"} ${best.namn} (${count(best.order)} av ${count(total)}, ${best.andelAvOrder}).`
        : `${periodText(period)}${scopeText(scope)}: inga order.`,
      data: {
        period: periodData(period),
        per: input.per,
        orderTotalt: total,
        utanTidpunkt: unknown,
        rader: rows,
      },
      figures: [...rows]
        .sort((a, b) => b.order - a.order)
        .slice(0, 4)
        .map((r) => ({ label: r.namn, value: `${count(r.order)} order · ${r.intakt}` })),
      links: [{ label: "Order", href: pageHref("/order", period, scopeIds(scope)) }],
    };
  },
});

// ---------------------------------------------------------------------------
// slutsalt
// ---------------------------------------------------------------------------

const lostInput = z.object({ ...periodSchema, ...scopeSchema }).strict();

export const lostSalesTool = defineTool({
  name: "slutsalt",
  title: "Slutsålt och förlorad försäljning",
  label: () => "Förlorad försäljning",
  description:
    "Vad slutsålda fack kostade i en period (som på Prognos & inköp): förlorad intäkt exkl. moms, förlorat bruttoresultat, förlorade pack och slutsålda dagar, per månad och per titel × automat (största först, och om det är slutsålt nu). Använd för 'vad förlorade vi på slutsålt', 'vilka fack var tomma'.",
  roles: ECONOMY_ROLES,
  input: lostInput,
  async run(ctx: ToolContext, input) {
    const period = periodFrom(ctx, input);
    const scope = await resolveScope(ctx, input);
    const master = await ctx.master();
    const names = nameMaps(master);
    const lost = await lostSalesSummaryFor(ctx.viewer, period, ctx.now, scopeIds(scope));
    const series = lost.series.slice(0, 15).map((s) => {
      const m = names.machine.get(s.machineId);
      return {
        titel: names.title.get(s.titleId) ?? s.titleId,
        automat: m ? `${m.name} (${m.code})` : s.machineId,
        forloradIntakt: kr(s.lostRevenueOre),
        forloradIntaktOre: s.lostRevenueOre,
        forloradePackMilli: s.lostUnitsMilli,
        slutsaltNu: s.ongoing,
        sedan: s.since,
      };
    });
    return {
      summary: `${lost.text} Förlorad intäkt ${kr(lost.lostRevenueOre)} (${periodText(lost.period)}${scopeText(scope)}).`,
      data: {
        period: periodData(lost.period),
        text: lost.text,
        forloradIntakt: kr(lost.lostRevenueOre),
        forloradIntaktOre: lost.lostRevenueOre,
        forloratBruttoresultat: kr(lost.lostGrossProfitOre),
        forloratBruttoresultatOre: lost.lostGrossProfitOre,
        forloradePackMilli: lost.lostUnitsMilli,
        slutsaldaDagar: (lost.stockoutDayWeightBp / 10_000).toLocaleString("sv-SE", {
          maximumFractionDigits: 1,
        }),
        manader: lost.months.map((m) => ({
          manad: m.month,
          forloradIntakt: kr(m.lostRevenueOre),
          forloradIntaktOre: m.lostRevenueOre,
          text: m.text,
        })),
        perTitelOchAutomat: series,
        anmarkning:
          "Förlorad försäljning är en uppskattning: takten före slutsålt gånger dagarna facket var tomt.",
      },
      figures: [
        { label: "Förlorad intäkt", value: kr(lost.lostRevenueOre) },
        ...series
          .slice(0, 3)
          .map((s) => ({ label: `${s.titel} · ${s.automat}`, value: s.forloradIntakt })),
      ],
      links: [{ label: "Förlorad försäljning", href: lost.href }],
    };
  },
});

// ---------------------------------------------------------------------------
// vart_lager
// ---------------------------------------------------------------------------

const ourStockInput = z
  .object({
    titel: z.string().min(1).max(200).optional().describe("Begränsa till en titel."),
    antal: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Högst så många rader. Standard 30."),
  })
  .strict();

export const ourStockTool = defineTool({
  name: "vart_lager",
  title: "Vårt lager",
  label: () => "Vårt lager",
  description:
    "Vårt lager (summan av våra egna lager, t.ex. Hemma och Kontoret) per titel: pack i lager totalt och per lager, alla automaters takt per dag, hur många dagar lagret räcker, vad veckans besök behöver och hur mycket som saknas, och senaste inventering. Kortast räckvidd först. Använd för 'hur länge räcker vårt lager', 'vad saknas hemma inför veckans påfyllning', 'hur många har vi på kontoret'.",
  roles: ALL_ROLES,
  input: ourStockInput,
  async run(ctx: ToolContext, input) {
    const master = await ctx.master();
    const names = nameMaps(master);
    const title = input.titel ? resolveOne(master.titles, input.titel, "titel") : null;
    const view = await loadOurStockFor(ctx.viewer, ctx.now);
    if (!view.hasWarehouse) {
      return {
        summary: "Organisationen har inget eget lager (Vårt lager) registrerat.",
        data: { harLager: false },
        figures: [],
        links: [{ label: "Vårt lager", href: "/vart-lager" }],
      };
    }
    const rows = view.rows
      .filter((r) => !title || r.titleId === title.id)
      .sort(
        (a, b) =>
          (a.daysLeft ?? Number.POSITIVE_INFINITY) - (b.daysLeft ?? Number.POSITIVE_INFINITY) ||
          a.onHand - b.onHand,
      );
    const multi = view.places.length > 1;
    const shown = rows.slice(0, input.antal ?? 30).map((r) => ({
      titel: names.title.get(r.titleId) ?? r.titleId,
      iLager: r.onHand,
      ...(multi
        ? {
            perLager: Object.fromEntries(
              view.places.map((p) => [p.name, view.byPlace[p.id]?.[r.titleId] ?? 0]),
            ),
          }
        : {}),
      taktPerDagTiondelar: r.perDayTenths,
      dagarKvar: r.daysLeft,
      veckansBehov: r.weekNeed,
      saknasForVeckan: r.shortBy,
      senastInventerad: r.lastCountedAt ? r.lastCountedAt.slice(0, 10) : null,
    }));
    const total = rows.reduce((n, r) => n + r.onHand, 0);
    const short = rows.filter((r) => r.shortBy > 0);
    const first = shown[0];
    const perPlace = view.places.map((p) => ({
      lager: p.name,
      pack: rows.reduce((n, r) => n + Math.max(0, view.byPlace[p.id]?.[r.titleId] ?? 0), 0),
    }));
    return {
      summary: `Vårt lager: ${count(total)} pack i ${count(rows.length)} titlar${multi ? ` (${perPlace.map((p) => `${p.lager} ${count(p.pack)}`).join(", ")})` : ""}, ${count(short.length)} räcker inte till veckans besök${first ? `. Kortast räckvidd: ${first.titel}, ${first.dagarKvar ?? "–"} dagar` : ""}.`,
      data: {
        fonsterDagar: view.windowDays,
        packTotalt: total,
        lager: perPlace,
        titlar: rows.length,
        racksInteForVeckan: short.length,
        anmarkning:
          "taktPerDagTiondelar: tiondelar pack per dag (25 = 2,5 pack/dag). dagarKvar null = ingen försäljning.",
        rader: shown,
      },
      figures: [
        { label: multi ? "Pack i lager" : "Pack hemma", value: count(total) },
        { label: "Räcker inte till veckan", value: count(short.length) },
      ],
      links: [{ label: "Vårt lager", href: "/vart-lager" }],
    };
  },
});

// ---------------------------------------------------------------------------
// besoksplan och automat_status (samma underlag som Drift)
// ---------------------------------------------------------------------------

async function driftData(ctx: ToolContext) {
  const orgId = ctx.viewer.organization.id;
  return withUserDbFor(ctx.viewer.user, async (tx) => {
    const data = await loadHealthData(tx, orgId, ctx.today, ctx.now);
    const health = healthOf(data, ctx.timeZone, ctx.now);
    const stockRows = await queryStock(tx, orgId);
    const warehouse = ownStockTotals(stockRows);
    const slotPeriods = await querySlotPeriods(tx, orgId);
    return { data, health, warehouse, slotPeriods };
  });
}

const visitInput = z
  .object({
    automat: scopeSchema.automat,
    butik: scopeSchema.butik,
  })
  .strict();

export const visitPlanTool = defineTool({
  name: "besoksplan",
  title: "Besöksplan och påfyllning",
  label: () => "Besöksplan",
  description:
    "Veckans besöksplan (som på Drift → Besök och Lager): vilka automater som ska fyllas på vilken dag och i vilken ordning, varför (vad som tar slut när), packlistan per besök (titel, antal att ta med, i lager nu, mål) och vad som saknas i vårt lager. Använd för 'vilken automat ska jag fylla på först', 'vad ska jag ta med till Sega gubben', 'planera veckans påfyllning'.",
  roles: ALL_ROLES,
  input: visitInput,
  async run(ctx: ToolContext, input) {
    const scope = await resolveScope(ctx, input);
    const { data, health, warehouse, slotPeriods } = await driftData(ctx);
    const plan = weeklyVisitPlan({
      orders: data.orders,
      machines: data.machines.filter((m) => !m.archived),
      titles: data.titles,
      stock: data.stock,
      warehouseStock: warehouse.length > 0 ? warehouse : null,
      health,
      slotPeriods,
      today: ctx.today,
      timeZone: ctx.timeZone,
      now: ctx.now,
    });
    const inScope = (machineId: string) =>
      (!scope.machine || scope.machine.id === machineId) &&
      (!scope.store || data.machines.find((m) => m.id === machineId)?.storeId === scope.store.id);
    const master = await ctx.master();
    const names = nameMaps(master);
    const days = plan.days
      .map((d) => ({ ...d, stops: d.stops.filter((s) => inScope(s.machineId)) }))
      .filter((d) => d.stops.length > 0);
    const stops = days.flatMap((d) => d.stops.map((s) => ({ date: d.date, s })));
    const first = stops[0];
    const storeOf = (machineId: string) => {
      const m = names.machine.get(machineId);
      return m?.storeId ? (names.store.get(m.storeId) ?? null) : null;
    };
    return {
      summary: first
        ? `${plan.summary} Först: ${first.s.machineName}${storeOf(first.s.machineId) ? ` (${storeOf(first.s.machineId)})` : ""} ${dateText(first.date)}, ${count(first.s.totalPacks)} pack${first.s.reasons[0] ? ` – ${first.s.reasons[0]}` : ""}.`
        : `Inga besök behövs ${periodText(plan.period)}${scopeText(scope)}.`,
      data: {
        period: periodData(plan.period),
        sammanfattning: plan.summary,
        packTotalt: plan.totalPacks,
        dagar: days.slice(0, 7).map((d) => ({
          datum: d.date,
          rubrik: d.title,
          besok: d.stops.slice(0, 8).map((s) => ({
            ordning: s.sequence,
            automat: s.machineName,
            butik: storeOf(s.machineId),
            senastDatum: s.needBy,
            forSent: s.late,
            skal: s.reasons.slice(0, 3),
            packAttTaMed: s.totalPacks,
            packlista: s.packs.slice(0, 12).map((p) => ({
              titel: p.titleName,
              taMed: p.quantity,
              iLagerNu: p.onHandNow,
              mal: p.target,
              saknasHemma: p.shortBy,
              tarSlut: p.stockoutDate,
            })),
          })),
        })),
        behoverInteBesok: plan.notNeeded.slice(0, 10).map((n) => ({
          automat: names.machine.get(n.machineId)?.name ?? n.machineId,
          senastBesok: n.needBy,
        })),
      },
      figures: stops.slice(0, 4).map(({ date, s }) => ({
        label: `${dateText(date)} · ${s.machineName}`,
        value: `${count(s.totalPacks)} pack`,
      })),
      links: [
        { label: "Besök", href: "/drift/besok" },
        ...(first
          ? [
              {
                label: `Påfyllning ${first.s.machineName}`,
                href: pageHref("/lager", null, { machineId: first.s.machineId }),
              },
            ]
          : []),
      ],
    };
  },
});

const statusInput = z.object({ automat: scopeSchema.automat }).strict();

const STATUS_ORDER = ["offline", "fault", "suspected_fault", "empty", "unknown", "ok", "inactive"];

export const machineStatusTool = defineTool({
  name: "automat_status",
  title: "Automaternas status",
  label: () => "Automaternas status",
  description:
    "Status per automat just nu (som på Drift): i drift, misstänkt fel, fel, ur drift, tom, okänd; sedan när, och förklaringen (t.ex. tyst längre än normalt för veckodagen). Sämst först. Använd för 'är någon automat tyst', 'fungerar BL-002'.",
  roles: ALL_ROLES,
  input: statusInput,
  async run(ctx: ToolContext, input) {
    const master = await ctx.master();
    const machine = input.automat ? resolveOne(master.machines, input.automat, "automat") : null;
    const names = nameMaps(master);
    const { health } = await driftData(ctx);
    const rows = health
      .filter((h) => !machine || h.machineId === machine.id)
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
      .map((h) => {
        const m = names.machine.get(h.machineId);
        return {
          automat: m ? `${m.name} (${m.code})` : h.machineId,
          status: h.label,
          sedan: h.since ? h.since.slice(0, 16).replace("T", " ") : null,
          rubrik: h.title,
          forklaring: h.detail,
          lank: h.link,
        };
      });
    const problems = health.filter((h) =>
      ["offline", "fault", "suspected_fault", "empty"].includes(h.status),
    );
    return {
      summary: `${count(rows.length)} automater, ${count(problems.length)} med problem${rows[0] ? `. Sämst: ${rows[0].automat} – ${rows[0].status}` : ""}.`,
      data: { antal: rows.length, medProblem: problems.length, automater: rows },
      figures: rows.slice(0, 5).map((r) => ({ label: r.automat, value: r.status })),
      links: [{ label: "Drift", href: "/drift" }],
    };
  },
});

// ---------------------------------------------------------------------------
// avtal
// ---------------------------------------------------------------------------

const contractsInput = z.object({ butik: scopeSchema.butik }).strict();

const CONTRACT_STATUS: Record<string, string> = {
  "not-started": "har inte börjat gälla",
  "open-ended": "gäller tills vidare",
  scheduled: "löper, påminnelse senare",
  due: "dags att säga upp eller omförhandla",
  "notice-passed": "uppsägningstiden har passerat",
  expired: "har gått ut",
  terminated: "uppsagt",
};

export const contractsTool = defineTool({
  name: "avtal",
  title: "Avtal",
  label: () => "Avtal",
  description:
    "Butiksavtalen (som på sidan Avtal): status per avtal (gäller tills vidare, dags att säga upp, har gått ut …), nuvarande slutdatum, sista uppsägningsdag och dagar kvar, villkoren per butik (modell, andel, hyra) och butiker med intäkt men utan gällande avtal. Använd för 'vilka avtal går ut snart', 'vilka villkor har Sega gubben'.",
  roles: ECONOMY_ROLES,
  input: contractsInput,
  async run(ctx: ToolContext, input) {
    const scope = await resolveScope(ctx, { butik: input.butik });
    const master = await ctx.master();
    const names = nameMaps(master);
    const view = await loadContractsFor(ctx.viewer, ctx.today);
    const inScope = (storeId: string) => !scope.store || scope.store.id === storeId;
    const reminders = view.reminders.reminders
      .filter((r) => inScope(r.storeId))
      .slice(0, 20)
      .map((r) => ({
        butik: names.store.get(r.storeId) ?? r.storeId,
        status: CONTRACT_STATUS[r.status] ?? r.status,
        rubrik: r.title,
        detalj: r.detail,
        slutar: r.term.currentEnd ?? "tills vidare",
        sistaUppsagningsdag: r.term.noticeDeadline,
        dagarTillUppsagning: r.daysToDeadline,
        dagarTillSlut: r.daysToEnd,
      }));
    const agreements = view.agreements
      .filter((a) => inScope(a.storeId))
      .filter((a) => a.validFrom <= ctx.today && (a.validTo === null || a.validTo >= ctx.today))
      .map((a) => ({
        butik: names.store.get(a.storeId) ?? a.storeId,
        modell: MODEL_TEXT[a.commissionBase] ?? a.commissionBase,
        andel: a.commissionBp === null ? "–" : pct(a.commissionBp),
        andelBp: a.commissionBp,
        ...(a.monthlyRentOre !== null && a.monthlyRentOre > 0
          ? { manadshyra: kr(a.monthlyRentOre), manadshyraOre: a.monthlyRentOre }
          : {}),
        giltigtFran: a.validFrom,
        giltigtTill: a.validTo ?? "tills vidare",
      }));
    const noContract = (view.overview?.stores ?? [])
      .filter((s) => s.category === "no-contract" && inScope(s.storeId))
      .map((s) => names.store.get(s.storeId) ?? s.storeId);
    const due = view.reminders.due.filter((r) => inScope(r.storeId));
    return {
      summary: `${view.reminders.summary} ${count(due.length)} kräver åtgärd${noContract.length ? `, ${count(noContract.length)} butiker saknar gällande avtal` : ""}.`,
      data: {
        sammanfattning: view.reminders.summary,
        kraverAtgard: due.length,
        avtal: reminders,
        villkorIdag: agreements,
        utanGallandeAvtal: noContract,
      },
      figures: [
        { label: "Kräver åtgärd", value: count(due.length) },
        ...reminders.slice(0, 3).map((r) => ({ label: r.butik, value: r.status })),
      ],
      links: [{ label: "Kontrakt", href: "/avtal" }],
    };
  },
});

// ---------------------------------------------------------------------------
// bokforing
// ---------------------------------------------------------------------------

const MONTH_STATUS: Record<string, string> = {
  open: "pågår (inte slut)",
  closed: "klar att skicka",
  sent: "skickad till bokföringen",
};

const bookkeepingInput = z
  .object({
    antal: z
      .number()
      .int()
      .min(1)
      .max(24)
      .optional()
      .describe("Högst så många månader. Standard 6."),
  })
  .strict();

export const bookkeepingTool = defineTool({
  name: "bokforing",
  title: "Bokföringens månader",
  label: () => "Bokföring",
  description:
    "Månaderna i Ekonomi → Bokföring, nyast först: status (pågår, klar att skicka, skickad), om siffrorna ändrats sedan den skickades, om bokföringspaketet (SIE-fil + PDF) är slutligt eller preliminärt och varför, och månadens siffror: order, försäljning inkl. moms, återbetalningar, inköp, butikernas andel och resultat. Använd för 'är oktober klar att bokföra', 'vad ska jag skicka till revisorn'.",
  roles: ECONOMY_ROLES,
  input: bookkeepingInput,
  async run(ctx: ToolContext, input) {
    const view = await loadBokforingFor(ctx.viewer, ctx.today);
    const months = view.months.slice(0, input.antal ?? 6).map((m) => ({
      manad: m.month,
      status: MONTH_STATUS[m.status] ?? m.status,
      skickad: m.sentAt ? m.sentAt.slice(0, 10) : null,
      andradEfterSkick: m.changedSinceSent,
      paket: m.stored
        ? `${m.stored.status === "final" ? "slutligt" : "preliminärt"}${m.stored.reason ? ` (${m.stored.reason})` : ""}`
        : "inte skapat",
      kvitton: m.receipts.length,
      order: m.book.orders,
      forsaljningInklMoms: kr(m.book.salesInclVatOre),
      forsaljningInklMomsOre: m.book.salesInclVatOre,
      aterbetalningar: kr(m.book.refundsOre),
      aterbetalningarOre: m.book.refundsOre,
      inkop: kr(m.book.purchasesOre),
      inkopOre: m.book.purchasesOre,
      butikernasAndel: kr(m.book.storeShareOre),
      butikernasAndelOre: m.book.storeShareOre,
      resultat: kr(m.book.resultOre),
      resultatOre: m.book.resultOre,
      utanInkopspris: m.book.unpricedOrders,
      vmb: m.book.vmbEnabled,
    }));
    const ready = months.filter((m) => m.status === MONTH_STATUS.closed);
    return {
      summary: `${count(ready.length)} månader klara att skicka${ready[0] ? ` (senast ${ready[0].manad})` : ""}; senaste månaden ${months[0]?.manad ?? "–"}: ${months[0]?.status ?? "–"}.`,
      data: { manader: months, vmbIBokforingen: view.settings },
      figures: months
        .slice(0, 4)
        .map((m) => ({ label: m.manad, value: `${m.status} · ${m.resultat}` })),
      links: [{ label: "Bokföring", href: "/ekonomi/bokforing" }],
    };
  },
});

// ---------------------------------------------------------------------------
// synk
// ---------------------------------------------------------------------------

const SYNC_STATE: Record<string, string> = {
  ok: "fungerar",
  stale: "inaktuell (ingen lyckad synk på länge)",
  failed: "misslyckas",
  "no-orders": "ansluten men inga order än",
};

export const syncTool = defineTool({
  name: "synk",
  title: "Hämtning från Awish",
  label: () => "Hämtning från Awish",
  description:
    "Hur synken från Awish mår: status (fungerar, inaktuell, misslyckas), senaste lyckade synk och hur många minuter sedan, antal datakällor. Order och automaternas lager synkas var 10:e minut. Använd för 'fungerar synken', 'varför syns inte dagens order'.",
  roles: ECONOMY_ROLES,
  input: z.object({}).strict(),
  async run(ctx: ToolContext) {
    const info = await loadSyncInfoFor(ctx.viewer, ctx.now);
    if (!info) throw new ToolInputError("Din roll ser inte datakällorna.");
    const minutes =
      info.syncedAt === null
        ? null
        : Math.max(0, Math.round((ctx.now.getTime() - new Date(info.syncedAt).getTime()) / 60_000));
    const when = info.syncedAt
      ? new Intl.DateTimeFormat("sv-SE", {
          timeZone: ctx.timeZone,
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(info.syncedAt))
      : "aldrig";
    return {
      summary: `Synken ${SYNC_STATE[info.state] ?? info.state}; senaste lyckade synk ${when}${minutes !== null ? ` (${count(minutes)} min sedan)` : ""}.`,
      data: {
        status: SYNC_STATE[info.state] ?? info.state,
        senastSynkad: when,
        minuterSedan: minutes,
        datakallor: info.sources,
        forvantatIntervallMinuter: 10,
      },
      figures: [
        { label: "Status", value: SYNC_STATE[info.state] ?? info.state },
        { label: "Senast", value: when },
      ],
      links: [{ label: "Datakällor", href: "/datakallor" }],
    };
  },
});
