/**
 * Filerna som demon importerar, precis som en användare skulle ladda upp dem:
 *
 * - Awish-orderlistor, en per månad (samma format som src/seed/awish-csv.ts).
 * - Utbetalningar från betalväxeln (en per månad, betald den 2:a nästa månad)
 *   och en specifikation per order för avvikelsemånaden. I den månaden har
 *   leverantören avsiktligt inte betalat ut två order, så att avstämningen har
 *   en avvikelse att visa.
 *
 * Här finns också kopplingen mellan kundärendena och orderna (vilken order ett
 * ärende gäller och vad som återbetalades), eftersom utbetalningarna dras med
 * återbetalningarna. Allt är rent och deterministiskt.
 */

import { addDays, addMonths, monthEnd, monthStart } from "@/domain/dates";
import type { IsoDate, IsoMonth } from "@/domain/types";

import { formatAwishAmount, toAwishCsv } from "../awish-csv";
import { stockholmToUtcMs, type SeedOrder } from "../orders";
import { DEMO_INCIDENTS, DEMO_NOW, DEMO_PAYOUT } from "./catalog";
import { ordersByMonth } from "./generate";

export interface DemoCsvFile {
  month: string;
  name: string;
  bytes: Uint8Array;
  orders: number;
  revenueOre: number;
}

/** En Awish-export per månad (UTF-8 med BOM, nyaste ordern först). */
export function demoOrderFiles(orders: readonly SeedOrder[], suffix = ""): DemoCsvFile[] {
  const out: DemoCsvFile[] = [];
  for (const [month, list] of ordersByMonth(orders)) {
    const first = list[0]?.businessDate ?? `${month}-01`;
    const last = list[list.length - 1]?.businessDate ?? first;
    out.push({
      month,
      name: `awish-orderlista-${first}--${last}${suffix}.csv`,
      bytes: new TextEncoder().encode(toAwishCsv(list)),
      orders: list.length,
      revenueOre: list.reduce((n, o) => n + o.amountOre, 0),
    });
  }
  return out;
}

export interface DemoIncidentPlan {
  index: number;
  machineCode: string;
  startedAtMs: number;
  endedAtMs: number | null;
  /** Ordern som ärendet gäller (externt ordernummer), om någon. */
  orderExternalId: string | null;
  title: string | null;
  refundedOre: number;
  refundedOn: IsoDate | null;
}

/** Ärendenas order och återbetalningar: första ordern i automaten från tidpunkten (inom 3 dygn). */
export function planIncidents(orders: readonly SeedOrder[]): DemoIncidentPlan[] {
  return DEMO_INCIDENTS.map((incident, index) => {
    const startedAtMs = stockholmToUtcMs(incident.date, incident.time);
    const endedOn =
      incident.resolvedAfterDays === null
        ? null
        : addDays(incident.date, incident.resolvedAfterDays);
    const endedAtMs = endedOn === null ? null : stockholmToUtcMs(endedOn, "10:00:00");
    let order: SeedOrder | undefined;
    if (incident.linkOrder) {
      order = orders.find(
        (o) =>
          o.machineCode === incident.machineCode &&
          o.paidAtMs >= startedAtMs - 3_600_000 &&
          o.paidAtMs <= startedAtMs + 3 * 86_400_000,
      );
      if (!order) {
        throw new Error(
          `Ingen order hittades för ärendet i ${incident.machineCode} ${incident.date}.`,
        );
      }
    }
    const refundedOre = incident.refund && order ? order.amountOre : 0;
    return {
      index,
      machineCode: incident.machineCode,
      // Ärendet börjar när kunden köpte (eller vid tidpunkten om ingen order).
      startedAtMs: order ? order.paidAtMs : startedAtMs,
      endedAtMs,
      orderExternalId: order?.externalId ?? null,
      title: order?.title ?? null,
      refundedOre,
      refundedOn: refundedOre > 0 ? (endedOn ?? incident.date) : null,
    };
  });
}

export interface DemoPayout {
  reference: string;
  month: IsoMonth;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  paidOn: IsoDate;
  amountOre: number;
  salesOre: number;
  refundsOre: number;
  /** Order som leverantören inte betalade ut (avvikelsen). */
  missing: string[];
}

export interface DemoPayoutFiles {
  payouts: DemoPayout[];
  payoutsCsv: { name: string; bytes: Uint8Array };
  linesCsv: { name: string; bytes: Uint8Array; lines: number };
}

/** De två order i avvikelsemånaden som inte betalas ut: den 14:e mitt på dagen. */
function missingOrders(list: readonly SeedOrder[]): string[] {
  const day = `${DEMO_PAYOUT.deviationMonth}-14`;
  const candidates = list.filter((o) => {
    const hour = Number(o.stockholmTime.slice(11, 13));
    return o.businessDate === day && hour >= 12 && hour <= 16;
  });
  if (candidates.length < DEMO_PAYOUT.missingOrders) {
    throw new Error("För få order för avvikelsen i utbetalningen.");
  }
  return candidates.slice(0, DEMO_PAYOUT.missingOrders).map((o) => o.externalId);
}

/** Utbetalningar för alla hela månader före demons "nu", betalda den 2:a nästa månad. */
export function demoPayoutFiles(
  orders: readonly SeedOrder[],
  incidents: readonly DemoIncidentPlan[],
): DemoPayoutFiles {
  const byMonth = ordersByMonth(orders);
  const payouts: DemoPayout[] = [];
  const lineRows: string[] = [];
  for (const [month, list] of byMonth) {
    const periodStart = monthStart(month);
    const periodEnd = monthEnd(month);
    const paidOn = addDays(monthStart(addMonths(month, 1)), 1);
    if (paidOn > DEMO_NOW.date) {
      continue;
    }
    const salesOre = list.reduce((n, o) => n + o.amountOre, 0);
    const refundsOre = incidents
      .filter(
        (i) => i.refundedOn !== null && i.refundedOn >= periodStart && i.refundedOn <= periodEnd,
      )
      .reduce((n, i) => n + i.refundedOre, 0);
    const missing = month === DEMO_PAYOUT.deviationMonth ? missingOrders(list) : [];
    const missingSet = new Set(missing);
    const missingOre = list
      .filter((o) => missingSet.has(o.externalId))
      .reduce((n, o) => n + o.amountOre, 0);
    const reference = `${DEMO_PAYOUT.referencePrefix}${month}`;
    payouts.push({
      reference,
      month,
      periodStart,
      periodEnd,
      paidOn,
      amountOre: salesOre - refundsOre - missingOre,
      salesOre,
      refundsOre,
      missing,
    });
    if (month === DEMO_PAYOUT.linesMonth) {
      for (const o of list) {
        if (!missingSet.has(o.externalId)) {
          lineRows.push([reference, o.externalId, formatAwishAmount(o.amountOre)].join(","));
        }
      }
    }
  }
  const payoutRows = payouts.map((p) =>
    [
      p.reference,
      p.periodStart,
      p.periodEnd,
      p.paidOn,
      formatAwishAmount(p.amountOre),
      formatAwishAmount(0),
    ].join(","),
  );
  const encode = (lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
  return {
    payouts,
    payoutsCsv: {
      name: "awish-utbetalningar-2026.csv",
      bytes: encode(["Referens,Period från,Period till,Utbetald,Belopp,Avgifter", ...payoutRows]),
    },
    linesCsv: {
      name: `awish-specifikation-${DEMO_PAYOUT.linesMonth}.csv`,
      bytes: encode(["Referens,Ordernummer,Belopp", ...lineRows]),
      lines: lineRows.length,
    },
  };
}
