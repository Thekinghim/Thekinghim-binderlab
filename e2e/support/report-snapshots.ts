/**
 * Ögonblicksbilder för sidindelningstestet (e2e/10-rapportsidor): rapporterna byggs med
 * samma kod som appen (buildSnapshot) ur ett påhittat, deterministiskt underlag med många
 * automater, titlar och dagar, så att tabeller och listor blir långa.
 */

import type { OrderLine, Placement, PurchasePrice, StoreAgreement } from "@/domain";
import type { PartnerOwner, ReportSources, StoreBasis } from "@/reports";
import { NO_TAX } from "@/reports/testing/fixtures";
import {
  buildSnapshot,
  type ReportSnapshot,
  type SnapshotInput,
  type SnapshotStockEvent,
} from "@/server/reports/snapshot";

export const ORGANIZATION = {
  id: "e2e-org",
  name: "Binderlab AB",
  orgNumber: "559000-0000",
  timeZone: "Europe/Stockholm",
};

const GENERATED_AT = "2026-11-02T06:00:00.000Z";

/** Dagarna från och med `start` till och med `end` (ÅÅÅÅ-MM-DD). */
function days(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Underlag: `machines` automater i tre butiker, `titles` titlar med inköpspris (utom den
 * sista) och order varje dag från 2025-10-01 till 2026-11-01.
 */
export function bigSources(machines: number, titles: number): ReportSources {
  const stores = [
    { id: "s-1", name: "Westfield Mall of Scandinavia" },
    { id: "s-2", name: "Nordstan Göteborg" },
    { id: "s-3", name: "Emporia Malmö" },
  ];
  const machineList = Array.from({ length: machines }, (_, i) => ({
    id: `m-${i + 1}`,
    name: `${stores[i % 3]!.name.split(" ")[0]} automat ${i + 1}, plan ${(i % 4) + 1}`,
    code: `BL-${String(i + 1).padStart(3, "0")}`,
  }));
  const titleList = Array.from({ length: titles }, (_, i) => ({
    id: `t-${i + 1}`,
    name: `Scarlet & Violet ${i + 1}: ${["Booster Bundle", "Elite Trainer Box", "Sleeved Booster", "Booster Pack"][i % 4]}`,
  }));
  const placements: Placement[] = machineList.map((m, i) => ({
    machineId: m.id,
    storeId: stores[i % 3]!.id,
    from: "2025-01-01",
    to: null,
  }));
  const agreements: StoreAgreement[] = stores.map((s, i) => ({
    storeId: s.id,
    validFrom: "2025-01-01",
    validTo: null,
    commissionBp: 1000 + i * 250,
    monthlyRentOre: i === 0 ? 150_000 : null,
  }));
  const prices: PurchasePrice[] = titleList.slice(0, -1).map((t, i) => ({
    titleId: t.id,
    unitCostOre: 2000 + (i % 7) * 350,
    validFrom: "2025-01-01",
  }));
  const orders: OrderLine[] = [];
  let n = 100_000;
  days("2025-10-01", "2026-11-01").forEach((day, di) => {
    machineList.forEach((m, mi) => {
      const count = 1 + ((di + mi) % 3);
      for (let k = 0; k < count; k++) {
        n++;
        const title = titleList[(di + mi * 3 + k) % titleList.length]!;
        orders.push({
          id: `o-${n}`,
          externalId: String(n),
          titleId: title.id,
          machineId: m.id,
          businessDate: day,
          amountOre: 4900 + ((di + k) % 4) * 1000,
        });
      }
    });
  });
  return {
    orders,
    prices,
    agreements,
    placements,
    settings: NO_TAX,
    stores,
    machines: machineList,
    titles: titleList,
  };
}

/** Inventering av varje titel i centrallagret. */
function stockEvents(src: ReportSources): SnapshotStockEvent[] {
  return src.titles.map((t, i) => ({
    id: `se-${i}`,
    locationId: "loc-central",
    machineId: null,
    titleId: t.id,
    kind: "count",
    quantity: 5 + ((i * 7) % 40),
    businessDate: "2025-09-30",
  }));
}

/** `count` delägare som tillsammans äger 100 %. */
export function owners(count: number): PartnerOwner[] {
  const base = Math.floor(10_000 / count);
  return Array.from({ length: count }, (_, i) => ({
    id: `owner-${i + 1}`,
    name: `Delägare ${i + 1} ${["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson"][i % 5]}`,
    shareBp: i === 0 ? 10_000 - base * (count - 1) : base,
  }));
}

function build(
  input: Omit<SnapshotInput, "organization" | "generatedAt">,
  generatedAt = GENERATED_AT,
): ReportSnapshot {
  return buildSnapshot({ ...input, organization: ORGANIZATION, generatedAt });
}

export interface PartnerCase {
  readonly name: string;
  readonly period?: { start: string; end: string };
  readonly month: string;
  readonly machines: number;
  readonly titles: number;
  readonly owners: number;
  /** Lägg till påhittade händelser (långa texter) så att listan blir full. */
  readonly extraEvents?: number;
}

export function partnerSnapshot(c: PartnerCase): ReportSnapshot {
  const src = bigSources(c.machines, c.titles);
  const snap = build({
    type: "delagare",
    month: c.month,
    period: c.period ?? null,
    sources: src,
    owners: owners(c.owners),
    stockEvents: stockEvents(src),
    comment: "Bra period. Vi fyller på de mest sålda titlarna i början av nästa månad.",
  });
  if (snap.type !== "delagare" || !c.extraEvents) return snap;
  const extra = Array.from({ length: c.extraEvents }, (_, i) => ({
    kind: snap.report.events[0]?.kind ?? ("price_change" as const),
    severity: (["warning", "info", "positive"] as const)[i % 3],
    date: snap.period.end,
    text: `Händelse ${i + 1}: ${src.machines[i % src.machines.length]!.name} stod tom i två dagar och flyttades sedan till entrén, där försäljningen ökade direkt efter flytten.`,
    evidence: snap.report.events[0]?.evidence ?? ({} as never),
  }));
  return {
    ...snap,
    report: { ...snap.report, events: [...snap.report.events, ...extra] },
  } as ReportSnapshot;
}

/**
 * Underlaget som det sparades i första utgåvan (före avtalsformen, VMB-valet, betalningarna
 * och totalraden): en sådan rapport ska visas som den visades då.
 */
export const STEP1_BASIS: StoreBasis = {
  payer: {
    name: "Binderlab Sverige AB",
    legal: true,
    orgNumber: "559000-1234",
    address: "Västra Hamngatan 12, 411 17 Göteborg",
    vatNumber: "SE559000123401",
  },
  contract: {
    title: "Placeringsavtal Westfield Mall of Scandinavia",
    validFrom: "2025-01-01",
    signedOn: "2024-12-18",
  },
  vatMode: "added",
  vatRateBp: 2500,
};

/**
 * Underlaget för butikens bokföring med allt ifyllt (det högsta blocket): företagsnamn som
 * skiljer sig från namnet verksamheten kallas, org.nr, adress, momsregistreringsnummer, ett
 * undertecknat skriftligt avtal, moms som tillkommer, VMB-texten och (i `storeSnapshot`) en
 * utbetalning som redan är gjord.
 */
export const FULL_BASIS: StoreBasis = {
  ...STEP1_BASIS,
  rev: 2,
  payer: { ...STEP1_BASIS.payer, brand: "Binderlab" },
  agreementForm: "written",
  vmb: true,
};

/** Dagen då ersättningen (exklusive moms) betalades ut i testfallen. */
export const PAID_ON = "2026-11-05";

/** Rapporten med en utbetalning på hela ersättningen exklusive moms (kvar: momsen). */
function withPayment(snap: ReportSnapshot, paidOn: string): ReportSnapshot {
  if (snap.type !== "butik" || !snap.report.basis || snap.report.compensation.totalOre <= 0)
    return snap;
  return {
    ...snap,
    report: {
      ...snap.report,
      basis: {
        ...snap.report.basis,
        payments: [{ paidOn, amountOre: snap.report.compensation.totalOre }],
      },
    },
  };
}

/**
 * Butiksrapporten för butiken s-1, som har var tredje automat. `details` = butikens val
 * "Visa detaljer i rapporten" (standard av: den korta rapporten). `split` = avtalet är en
 * vinstdelning med hyra och VMB-moms före delning (den längsta uträkningen: åtta rader).
 * `basis`: underlaget för bokföringen (standard allt ifyllt, `null` = en äldre rapport utan).
 */
export function storeSnapshot(
  month: string,
  machines: number,
  details = false,
  options: { split?: boolean; greeting?: string; basis?: StoreBasis | null } = {},
): ReportSnapshot {
  const base = bigSources(machines, 30);
  const sources: ReportSources = options.split
    ? {
        ...base,
        // Vinstdelning kräver inköpspris på varje såld titel (den sista saknar annars pris).
        prices: base.titles.map((t, i) => ({
          titleId: t.id,
          unitCostOre: 2000 + (i % 7) * 350,
          validFrom: "2025-01-01",
        })),
        agreements: base.agreements.map((a) =>
          a.storeId === "s-1"
            ? {
                ...a,
                commissionBp: 5000,
                commissionBase: "profit_after_costs" as const,
                vmbBeforeSplit: true,
                monthlyRentOre: 150_000,
              }
            : a,
        ),
      }
    : base;
  const snap = build({
    type: "butik",
    month,
    sources,
    storeId: "s-1",
    storeDetails: details,
    storeBasis: options.basis === undefined ? FULL_BASIS : options.basis,
    greeting:
      options.greeting ?? "Tack för ett bra samarbete! Hör av er om ni vill flytta någon automat.",
    storeService: {
      refills: { count: 9, last: "2026-10-29" },
      busiest: "Lördag 13–15",
      busiestOrders: 120,
    },
  });
  // Utgåva 2: en utbetalning är redan gjord (fakturablocket får två rader till).
  return snap.type === "butik" && (snap.report.basis?.rev ?? 1) >= 2
    ? withPayment(snap, PAID_ON)
    : snap;
}

/**
 * Ägarens verkliga fall: en automat i en butik, vinstdelning 50 %, muntligt avtal, eget
 * datum över två månader (14 okt.–14 nov. 2026), avtalet förnyat utan ändring den 3 nov.
 * (förut tre perioder i uträkningen, nu oktober och november), VMB-texten, ett juridiskt
 * namn som skiljer sig från "Binderlab" och ersättningen exklusive moms redan utbetald.
 */
export function ownerCaseSnapshot(): ReportSnapshot {
  const store = { id: "s-1", name: "Sega Gubben Spel & Samlarkort" };
  const titles = Array.from({ length: 6 }, (_, i) => ({
    id: `t-${i + 1}`,
    name: `Pokémon ${["151", "Prismatic Evolutions", "Surging Sparks", "Journey Together", "Destined Rivals", "Paldean Fates"][i]} Booster`,
  }));
  const orders: OrderLine[] = [];
  let n = 500_000;
  days("2026-09-01", "2026-11-14").forEach((day, di) => {
    const count = 2 + (di % 4);
    for (let k = 0; k < count; k++) {
      n++;
      orders.push({
        id: `o-${n}`,
        externalId: String(n),
        titleId: titles[(di + k) % titles.length]!.id,
        machineId: "m-1",
        businessDate: day,
        amountOre: 6900 + ((di + k) % 3) * 1000,
      });
    }
  });
  const split = (validFrom: string, validTo: string | null): StoreAgreement => ({
    storeId: store.id,
    validFrom,
    validTo,
    commissionBp: 5000,
    monthlyRentOre: null,
    commissionBase: "profit_after_costs",
    lossTreatment: "zero",
  });
  const sources: ReportSources = {
    orders,
    prices: titles.map((t, i) => ({
      titleId: t.id,
      unitCostOre: 4200 + (i % 3) * 450,
      validFrom: "2026-01-01",
    })),
    agreements: [split("2026-10-14", "2026-11-02"), split("2026-11-03", null)],
    placements: [{ machineId: "m-1", storeId: store.id, from: "2026-09-01", to: null }],
    settings: { vatRateBp: 0, cardFeeBp: 150 },
    stores: [store],
    machines: [{ id: "m-1", name: "Pokémonautomaten", code: "BL-001" }],
    titles,
  };
  const snap = build(
    {
      type: "butik",
      month: "2026-10",
      period: { start: "2026-10-14", end: "2026-11-14" },
      sources,
      storeId: store.id,
      storeDetails: false,
      storeBasis: {
        rev: 2,
        payer: {
          name: "Kortautomater i Norden AB",
          legal: true,
          orgNumber: "559000-1234",
          address: "Västra Hamngatan 12, 411 17 Göteborg",
          vatNumber: "SE559000123401",
          brand: "Binderlab",
        },
        agreementForm: "oral",
        contract: null,
        vatMode: "added",
        vatRateBp: 2500,
        vmb: true,
      },
      greeting: null,
      storeService: { refills: { count: 4, last: "2026-11-10" }, busiest: null, busiestOrders: 0 },
    },
    "2026-11-17T08:00:00.000Z",
  );
  return withPayment(snap, "2026-11-16");
}

/**
 * En butik med bara hyra och ett skriftligt, undertecknat avtal: en automat, hela oktober,
 * VMB-texten, ingen utbetalning gjord (fakturablocket som i första utgåvan).
 */
export function rentCaseSnapshot(): ReportSnapshot {
  const base = bigSources(3, 12);
  const sources: ReportSources = {
    ...base,
    agreements: base.agreements.map((a) =>
      a.storeId === "s-1" ? { ...a, commissionBp: null, monthlyRentOre: 250_000 } : a,
    ),
  };
  return build({
    type: "butik",
    month: "2026-10",
    sources,
    storeId: "s-1",
    storeDetails: false,
    storeBasis: FULL_BASIS,
    greeting: null,
    storeService: { refills: { count: 2, last: "2026-10-20" }, busiest: null, busiestOrders: 0 },
  });
}

export function accountantSnapshot(
  month: string,
  period: { start: string; end: string } | null,
): ReportSnapshot {
  return build({
    type: "bokforing",
    month,
    period,
    sources: bigSources(9, 12),
  });
}
