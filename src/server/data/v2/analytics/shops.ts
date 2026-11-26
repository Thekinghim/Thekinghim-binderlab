/**
 * Butiker och "Att betala" i V2 (G4). Allt kommer från befintliga laddare, oförändrat:
 *
 *   - butikslistan (vinst, andel, villkor) ur Butikers lista (loadStoreList: profitability
 *     per butik och storeCompensation, samma motor som avräkningen);
 *   - att betala ur avräkningarna (loadSettlementPageFor: obetalda, minus förskott);
 *   - betalningarna ur store_payments (loadPaymentListFor, berakningar §32);
 *   - automaternas status och fyllnad ur flottans läge;
 *   - stad, adress, kontakt och strömtider ur butiksregistret (loadStoresFor).
 *
 * Bara ägare, admin och läsare (sidan kräver rutten "butiker"; laddarna kontrollerar rollen
 * igen mot databasen).
 */

import "server-only";

import { sql } from "drizzle-orm";
import { cache } from "react";

import { cityLabel, storeNameLabel } from "@/lib/format";
import type { SearchParamsInput } from "@/components/shell/period-state";
import {
  addDays,
  maxDate,
  minDate,
  monthEnd,
  monthOf,
  monthStart,
  storeCompensation,
  type IsoDate,
} from "@/domain";
import { requestPageLoaders } from "@/server/data/page-loaders";
import { withUserDbFor } from "@/server/access";
import { cachedViewState, loadContext, requireViewer, type AppContext } from "@/server/data/core";
import { correctionsTotal, payoutDueDate } from "@/server/settlements/model";
import { loadPaymentListFor, type PaymentListItem } from "@/server/settlements/payments";
import { loadSettlementPageFor, type SettlementRow } from "@/server/settlements/service";
import { loadFleetState } from "@/server/data/v2/fleet";
import type { PayOverview } from "@/server/payouts/balances";
import { loadPayoutsPageFor } from "@/server/payouts/service";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import type { FleetStatus, FleetStatusTone } from "@/analytics/fleet-status";
import type { MachineLook } from "@/lib/machine-look";

import { loadStoreList } from "@/app/(app)/butiker/_lib/data";
import { MODEL_LABEL } from "@/app/(app)/butiker/_lib/model";
import { perMachineProfit } from "@/app/(app)/butiker/_lib/v2-model";
import { loadStoresFor } from "@/app/(app)/butiker/_lib/service";

/* ------------------------------------------------------------------ */
/* Att betala                                                          */
/* ------------------------------------------------------------------ */

const PAYOUT_ROLES: ReadonlySet<string> = new Set(OPERATOR_ROLES);

export interface PayItem {
  readonly id: string;
  readonly storeId: string;
  readonly storeName: string;
  /** 'ÅÅÅÅ-MM'. */
  readonly month: string;
  /** Kvar att betala (avräkningen − förskott). */
  readonly leftOre: number;
  readonly amountOre: number;
  readonly advanceOre: number;
  /** Den godkända rapportens belopp med rättelser, eller null (som Utbetalning). */
  readonly reportOre: number | null;
  /** Sista dag att betala. */
  readonly due: IsoDate;
  readonly late: boolean;
}

export interface MoneyPay {
  readonly items: readonly PayItem[];
  readonly totalOre: number;
  readonly stores: number;
  readonly canEdit: boolean;
  readonly today: IsoDate;
  /** Butikerna att välja i "Registrera betalning". */
  readonly storeOptions: readonly { readonly id: string; readonly name: string }[];
  /** Alla avräkningar (12 månader), för butikens historik. */
  readonly settlements: readonly SettlementRow[];
  /** Butiker och månader utan avräkning (samma som "Saknas" på Utbetalning), äldst först. */
  readonly missing: readonly { readonly storeName: string; readonly month: string }[];
}

/** Obetalda avräkningar som går att betala nu (samma urval som Utbetalning). */
export function payItems(rows: readonly SettlementRow[], today: IsoDate): PayItem[] {
  return rows
    .filter((r) => r.state === "unpaid" && !r.blocked && r.leftOre > 0)
    .map((r) => {
      const due = payoutDueDate(r.month);
      return {
        id: r.id,
        storeId: r.storeId,
        storeName: r.storeName,
        month: r.month,
        leftOre: r.leftOre,
        amountOre: r.amountOre,
        advanceOre: r.advanceOre,
        reportOre:
          r.reportOre === null || r.reportOre === 0
            ? null
            : r.reportOre + correctionsTotal(r.corrections),
        due,
        late: due < today,
      };
    })
    .sort((a, b) => a.due.localeCompare(b.due) || b.leftOre - a.leftOre);
}

export const loadMoneyPay = cache(async (): Promise<MoneyPay | null> => {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  // Beror inte på vald period: sparad mellan förfrågningar (core/cachedViewState).
  return cachedViewState("money-pay", () => moneyPayNow(ctx));
});

async function moneyPayNow(ctx: AppContext): Promise<MoneyPay> {
  const page = await loadSettlementPageFor(await requireViewer());
  const items = payItems(page.rows, ctx.today);
  return {
    items,
    totalOre: items.reduce((a, i) => a + i.leftOre, 0),
    stores: new Set(items.map((i) => i.storeId)).size,
    canEdit: page.canEdit,
    today: ctx.today,
    storeOptions: page.stores,
    settlements: page.rows,
    missing: [...page.missing]
      .map((m) => ({ storeName: m.storeName, month: m.month }))
      .sort(
        (a, b) => a.month.localeCompare(b.month) || a.storeName.localeCompare(b.storeName, "sv"),
      ),
  };
}

/**
 * "Att betala just nu" ur utbetalningarna från Nayax: samma saldon och samma summa som
 * /pengar/utbetalningar (loadPayoutsPageFor). null när organisationen inte har lagt in någon
 * utbetalning (då gäller avräkningarna, loadMoneyPay) eller personen inte får se sidan
 * (bara ägare och admin).
 */
export const loadMoneyPayouts = cache(async (): Promise<PayOverview | null> => {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy || !PAYOUT_ROLES.has(ctx.role)) return null;
  const page = await loadPayoutsPageFor(await requireViewer(), new Date(ctx.now));
  return page.payouts.length > 0 ? page : null;
});

/* ------------------------------------------------------------------ */
/* Butikslistan                                                        */
/* ------------------------------------------------------------------ */

export interface ShopMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Utseende (machines.appearance, läses bara): automatens bild. */
  readonly appearance: MachineLook;
  readonly status: FleetStatus;
  readonly statusLabel: string;
  readonly tone: FleetStatusTone;
  /** Fyllnad i bp (Awish), null = okänd. */
  readonly fillBp: number | null;
  /** Titlarna i automaten (fackens ordning), för packbilderna i det lilla kortet. */
  readonly packs: readonly { readonly name: string; readonly empty: boolean }[];
  readonly href: string;
}

export interface ShopRow {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly address: string | null;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly machines: readonly ShopMachine[];
  /** Vår vinst i perioden (Lönsamhets regel för vyn). */
  readonly profitOre: number;
  /**
   * Vinst per automat i perioden, med automatdagar (perMachineProfit): butikens vinst delad
   * med hur många automater som i snitt stod där. null utan automat i perioden.
   */
  readonly perMachineOre: number | null;
  /** Butikens andel i perioden (avräkningens motor). */
  readonly shareOre: number;
  /** Hittills intjänad andel i månaden som pågår. */
  readonly earnedMonthOre: number;
  /**
   * Butikens andel per hel månad de senaste fem månaderna ('ÅÅÅÅ-MM' → öre), räknad med
   * samma motor som avräkningen (storeCompensation). Används där en avräkning saknas.
   */
  readonly monthlyShare: readonly { readonly month: string; readonly ore: number }[];
  /** "50 % av vinsten", null utan avtal. */
  readonly terms: string | null;
  /** Kvar att betala (alla obetalda månader), 0 = inget. */
  readonly payOre: number;
  readonly payDue: IsoDate | null;
  readonly payLate: boolean;
  /** Strömtider, null = alltid på. */
  readonly power: { readonly on: string; readonly off: string } | null;
  readonly agreement: {
    readonly terms: string;
    readonly model: string;
    readonly validFrom: IsoDate;
    readonly validTo: IsoDate | null;
  } | null;
  /** Butiken har ingen automat i dag och har inte sålt (på väg in). */
  readonly prospect: boolean;
  readonly href: string;
  // --- Visuellt (Butiker): kontraktets läge i butikskortet. Bara läsning. ---
  /** Kontraktet (signerat, osignerat, saknas), eller null om okänt (ur butikslistan). */
  readonly contract: "signed" | "unsigned" | "missing" | null;
}

export interface ShopsData {
  readonly rows: readonly ShopRow[];
  readonly pay: MoneyPay;
  readonly periodLabel: string;
  readonly days: number;
  readonly showStoreShare: boolean;
  readonly canEdit: boolean;
  readonly payments: readonly PaymentListItem[];
  /** Månaden som pågår ('ÅÅÅÅ-MM') och dagarna hittills, för andelen per månad. */
  readonly month: { readonly month: string; readonly days: number };
}

type Row = Record<string, unknown>;

/**
 * Titlarna per automat för packbilderna: Awish-läsningen (fackens kanalordning, tomma fack
 * markerade), annars lagret i appen. Som den inloggade (RLS); bara namn, inga belopp.
 */
async function loadMachinePacks(
  orgId: string,
): Promise<Map<string, { name: string; empty: boolean }[]>> {
  const viewer = await requireViewer();
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await tx.execute(sql`
      select l.machine_id::text as machine_id, t.name,
             (coalesce(f.units, 0) <= 0 or coalesce(f.empty, 0) >= greatest(coalesce(f.channels, 1), 1)) as empty,
             coalesce(c.channels[1], '') as channel
      from public.stock_locations l
      cross join lateral jsonb_to_recordset(
        case when jsonb_typeof(l.awish_fill) = 'array' then l.awish_fill else '[]'::jsonb end
      ) as f(title_id uuid, units int, channels int, empty int)
      join public.titles t on t.organization_id = l.organization_id and t.id = f.title_id
      left join public.machine_slot_capacity c
        on c.organization_id = l.organization_id and c.machine_id = l.machine_id
       and c.title_id = f.title_id
      where l.organization_id = ${orgId}::uuid and l.kind = 'machine'
        and l.machine_id is not null and l.archived_at is null
      union all
      select l.machine_id::text, t.name, false, ''
      from public.stock_locations l
      join public.stock_levels sl
        on sl.organization_id = l.organization_id and sl.location_id = l.id
      join public.titles t on t.organization_id = l.organization_id and t.id = sl.title_id
      where l.organization_id = ${orgId}::uuid and l.kind = 'machine'
        and l.machine_id is not null and l.archived_at is null
        and (l.awish_fill is null or jsonb_typeof(l.awish_fill) <> 'array'
             or jsonb_array_length(l.awish_fill) = 0)
        and sl.quantity > 0`);
    const out = new Map<string, { name: string; empty: boolean; channel: string }[]>();
    for (const r of Array.from(rows) as Row[]) {
      const id = String(r.machine_id);
      const list = out.get(id) ?? [];
      list.push({
        name: String(r.name ?? ""),
        empty: r.empty === true,
        channel: String(r.channel ?? ""),
      });
      out.set(id, list);
    }
    const sorted = new Map<string, { name: string; empty: boolean }[]>();
    for (const [id, list] of out) {
      sorted.set(
        id,
        list
          .sort(
            (a, b) =>
              Number(a.channel === "") - Number(b.channel === "") ||
              a.channel.localeCompare(b.channel, "sv", { numeric: true, sensitivity: "base" }) ||
              a.name.localeCompare(b.name, "sv"),
          )
          .map(({ name, empty }) => ({ name, empty })),
      );
    }
    return sorted;
  });
}

/** Månader i andelsstapeln (den pågående inräknad). */
const SHARE_MONTHS = 6;

/**
 * Andelen per butik och hel månad, de senaste SHARE_MONTHS − 1 månaderna: storeCompensation
 * (samma motor som avräkningen och "hittills i månaden") på varje månads order och avtal.
 */
async function monthlyShares(today: IsoDate): Promise<Map<string, Map<string, number>>> {
  let start = monthStart(monthOf(today));
  for (let i = 1; i < SHARE_MONTHS; i++) start = monthStart(monthOf(addDays(start, -1)));
  const lastPast = addDays(monthStart(monthOf(today)), -1);
  const out = new Map<string, Map<string, number>>();
  if (lastPast < start) return out;
  const input = await requestPageLoaders().domainInput({ period: { start, end: lastPast } });
  for (let cursor = start; cursor <= lastPast; cursor = addDays(monthEnd(monthOf(cursor)), 1)) {
    const month = monthOf(cursor);
    const period = {
      start: maxDate(monthStart(month), start),
      end: minDate(monthEnd(month), lastPast),
    };
    const result = storeCompensation({
      ...input.current,
      period,
      orders: input.current.orders.filter(
        (o) => o.businessDate >= period.start && o.businessDate <= period.end,
      ),
    });
    for (const c of result.stores) {
      const m = out.get(c.storeId) ?? new Map<string, number>();
      m.set(month, c.totalOre);
      out.set(c.storeId, m);
    }
  }
  return out;
}

async function monthlySharesOrEmpty(today: IsoDate): Promise<Map<string, Map<string, number>>> {
  try {
    return await monthlyShares(today);
  } catch (error) {
    console.error("[butiker/v2] Andelen per månad kunde inte räknas:", error);
    return new Map();
  }
}

/** Packbilderna är bara dekor: ett fel stoppar inte Butiker. */
async function machinePacksOrEmpty(
  orgId: string,
): Promise<Map<string, { name: string; empty: boolean }[]>> {
  try {
    return await loadMachinePacks(orgId);
  } catch (error) {
    console.error("[butiker/v2] Titlarna per automat kunde inte läsas:", error);
    return new Map();
  }
}

export async function loadShops(sp: SearchParamsInput): Promise<ShopsData | null> {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  const viewer = await requireViewer();
  const [list, pay, fleet, stores, payments, packs, shares] = await Promise.all([
    loadStoreList(sp),
    loadMoneyPay(),
    loadFleetState(),
    loadStoresFor(viewer),
    loadPaymentListFor(viewer),
    machinePacksOrEmpty(ctx.organization.id),
    monthlySharesOrEmpty(ctx.today),
  ]);
  if (!pay) return null;
  const detail = new Map(stores.map((s) => [s.id, s]));
  const machinesBy = new Map<string, ShopMachine[]>();
  for (const m of fleet.machines) {
    if (!m.store) continue;
    const list2 = machinesBy.get(m.store.id) ?? [];
    list2.push({
      id: m.id,
      code: m.code,
      name: m.name,
      appearance: m.appearance,
      status: m.status,
      statusLabel: m.statusLabel,
      tone: m.tone,
      fillBp: m.fill?.fillBp ?? null,
      packs: packs.get(m.id) ?? [],
      href: `/automater?valj=${encodeURIComponent(m.code)}`,
    });
    machinesBy.set(m.store.id, list2);
  }
  const payBy = new Map<string, { ore: number; due: IsoDate; late: boolean }>();
  for (const i of pay.items) {
    const cur = payBy.get(i.storeId);
    payBy.set(i.storeId, {
      ore: (cur?.ore ?? 0) + i.leftOre,
      due: cur && cur.due < i.due ? cur.due : i.due,
      late: (cur?.late ?? false) || i.late,
    });
  }
  const rows: ShopRow[] = list.rows
    .filter((r) => !r.archived)
    .map((r) => {
      const d = detail.get(r.id);
      const machines = machinesBy.get(r.id) ?? [];
      const p = payBy.get(r.id);
      return {
        id: r.id,
        name: storeNameLabel(r.name, d?.city),
        city: cityLabel(d?.city),
        address: d?.address ?? null,
        contactName: d?.contactName ?? null,
        phone: d?.phone ?? null,
        email: d?.email ?? null,
        location: d?.location ?? null,
        machines,
        profitOre: r.profitOre,
        perMachineOre: perMachineProfit(r.profitOre, r.id, list.placements, list.period.coverage),
        shareOre: r.toStoreOre,
        earnedMonthOre: r.earnedMonthOre,
        monthlyShare: [...(shares.get(r.id) ?? new Map<string, number>())].map(([month, ore]) => ({
          month,
          ore,
        })),
        terms: r.terms,
        payOre: p?.ore ?? 0,
        payDue: p?.due ?? null,
        payLate: p?.late ?? false,
        power: d?.powerHours ?? null,
        agreement: r.current
          ? {
              terms: r.current.termsLabel,
              model: MODEL_LABEL[r.current.model],
              validFrom: r.current.validFrom,
              validTo: r.current.validTo,
            }
          : null,
        prospect: machines.length === 0 && r.orders === 0,
        href: r.href,
        // --- Visuellt (Butiker): kontraktets läge. Bara läsning. ---
        contract: r.contract,
      };
    });
  return {
    rows,
    pay,
    periodLabel: list.period.rangeLabel,
    days: list.period.days,
    showStoreShare: list.showStoreShare,
    canEdit: ctx.canEdit,
    payments,
    month: { month: ctx.today.slice(0, 7), days: Number(ctx.today.slice(8, 10)) },
  };
}
