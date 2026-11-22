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

import { cache } from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import type { IsoDate } from "@/domain";
import { loadContext, requireViewer } from "@/server/data/core";
import { correctionsTotal, payoutDueDate } from "@/server/settlements/model";
import { loadPaymentListFor, type PaymentListItem } from "@/server/settlements/payments";
import { loadSettlementPageFor, type SettlementRow } from "@/server/settlements/service";
import { loadFleetState } from "@/server/data/v2/fleet";
import type { FleetStatus, FleetStatusTone } from "@/analytics/fleet-status";

import { loadStoreList } from "@/app/(app)/butiker/_lib/data";
import { MODEL_LABEL } from "@/app/(app)/butiker/_lib/model";
import { loadStoresFor } from "@/app/(app)/butiker/_lib/service";

/* ------------------------------------------------------------------ */
/* Att betala                                                          */
/* ------------------------------------------------------------------ */

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
  };
});

/* ------------------------------------------------------------------ */
/* Butikslistan                                                        */
/* ------------------------------------------------------------------ */

export interface ShopMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: FleetStatus;
  readonly statusLabel: string;
  readonly tone: FleetStatusTone;
  /** Fyllnad i bp (Awish), null = okänd. */
  readonly fillBp: number | null;
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
  /** Vinst per automat som står i butiken i dag, null utan automat. */
  readonly perMachineOre: number | null;
  /** Butikens andel i perioden (avräkningens motor). */
  readonly shareOre: number;
  /** Hittills intjänad andel i månaden som pågår. */
  readonly earnedMonthOre: number;
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

export async function loadShops(sp: SearchParamsInput): Promise<ShopsData | null> {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  const viewer = await requireViewer();
  const [list, pay, fleet, stores, payments] = await Promise.all([
    loadStoreList(sp),
    loadMoneyPay(),
    loadFleetState(),
    loadStoresFor(viewer),
    loadPaymentListFor(viewer),
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
      status: m.status,
      statusLabel: m.statusLabel,
      tone: m.tone,
      fillBp: m.fill?.fillBp ?? null,
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
        name: r.name,
        city: d?.city?.trim() || null,
        address: d?.address ?? null,
        contactName: d?.contactName ?? null,
        phone: d?.phone ?? null,
        email: d?.email ?? null,
        location: d?.location ?? null,
        machines,
        profitOre: r.profitOre,
        perMachineOre: machines.length > 0 ? Math.round(r.profitOre / machines.length) : null,
        shareOre: r.toStoreOre,
        earnedMonthOre: r.earnedMonthOre,
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
