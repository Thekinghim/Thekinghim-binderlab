/**
 * Kontraktsidans lista: en rad per butik och kontrakt, med villkoren i klartext och en
 * status som en icke-teknisk person förstår (Saknas, Utkast, Skickat, Signerat, Löper ut,
 * Uppsagt). Butiker utan signerat kontrakt först. Rent, testas i model.test.ts.
 */

import {
  contractInForce,
  isSigned,
  signedCount,
  storeContractStates,
  type SignableContract,
  type StoreContractState,
} from "@/analytics/contracts/signed";
import type { ContractStatus as ReminderStatus } from "@/analytics/contracts/types";
import { addDays, type IsoDate } from "@/domain";
import { formatDate, formatPercent } from "@/lib/format";
import { contractTermsPlain } from "@/reports/contract-pdf";

export type RowStatus = "missing" | "draft" | "sent" | "signed" | "due" | "terminated" | "upcoming";

export type RowTone = "critical" | "warning" | "ok" | "neutral";

export const ROW_STATUS: Record<RowStatus, { label: string; tone: RowTone }> = {
  missing: { label: "Saknas", tone: "critical" },
  draft: { label: "Utkast", tone: "warning" },
  sent: { label: "Skickat", tone: "warning" },
  signed: { label: "Signerat", tone: "ok" },
  due: { label: "Löper ut", tone: "warning" },
  terminated: { label: "Uppsagt", tone: "neutral" },
  upcoming: { label: "Börjar senare", tone: "ok" },
};

export interface ContractInput extends SignableContract {
  readonly hasFile: boolean;
  readonly archived: boolean;
}

export interface AgreementInput {
  readonly id: string;
  readonly storeId: string;
  readonly contractId: string | null;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly commissionBp: number | null;
  readonly monthlyRentOre: number | null;
  readonly commissionBase: "net_excl_vat" | "profit_after_costs";
  readonly lossTreatment?: "zero" | "proportional";
  readonly vmbBeforeSplit?: boolean;
}

export interface ContractRow {
  /** Unik nyckel: kontraktets id, eller "store:<id>" för en butik utan kontrakt. */
  readonly key: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly contractId: string | null;
  /** "50 % av vinsten efter kostnader", eller null utan villkor. */
  readonly terms: string | null;
  readonly status: RowStatus;
  /** Röd markering: butiken har automat men inget signerat kontrakt. */
  readonly alert: boolean;
  readonly hasMachine: boolean;
}

export interface ContractList {
  readonly rows: ContractRow[];
  readonly states: Map<string, StoreContractState>;
  readonly signed: number;
  readonly total: number;
}

const ORDER: Record<RowStatus, number> = {
  missing: 0,
  draft: 1,
  sent: 2,
  due: 3,
  terminated: 4,
  upcoming: 5,
  signed: 6,
};

/** Villkoren som gäller i dag för kontraktet (annars de första kopplade, annars butikens). */
function termsOf(
  agreements: readonly AgreementInput[],
  storeId: string,
  contractId: string | null,
  today: IsoDate,
): string | null {
  const own = agreements.filter((a) =>
    contractId === null ? a.storeId === storeId : a.contractId === contractId,
  );
  const now = own.find((a) => a.validFrom <= today && (a.validTo === null || a.validTo >= today));
  const pick = now ?? own[0];
  if (!pick) return null;
  return contractTermsPlain({
    shareBp: pick.commissionBp,
    base: pick.commissionBase,
    lossTreatment: pick.lossTreatment ?? "zero",
    vmbBeforeSplit: pick.vmbBeforeSplit ?? false,
    monthlyRentOre: pick.monthlyRentOre,
  });
}

function rowStatus(
  c: ContractInput,
  reminder: ReminderStatus | undefined,
  due: boolean,
  today: IsoDate,
): RowStatus {
  if (!isSigned(c)) return c.sentAt ? "sent" : "draft";
  if (c.validFrom > today) return "upcoming";
  if (reminder === "terminated") return "terminated";
  if (due) return "due";
  return "signed";
}

/**
 * Raderna på Kontrakt. Kontrakt som gått ut eller är arkiverade visas inte här (de finns
 * under Arkiv); en butik utan kontrakt som gäller får en rad "Saknas".
 */
export function buildContractRows(args: {
  stores: readonly { id: string; name: string }[];
  contracts: readonly ContractInput[];
  agreements: readonly AgreementInput[];
  /** Påminnelsernas status per kontrakt (contractReminders). */
  reminders: ReadonlyMap<string, ReminderStatus>;
  /** Kontrakt som behöver beslut nu (påminnelsen har kommit). */
  due: ReadonlySet<string>;
  /** Butiker med automat i dag. */
  withMachine: ReadonlySet<string>;
  today: IsoDate;
}): ContractList {
  const live = args.contracts.filter((c) => !c.archived && contractInForce(c, args.today));
  const states = storeContractStates(
    args.contracts.filter((c) => !c.archived),
    args.stores.map((s) => s.id),
    args.today,
  );
  const rows: ContractRow[] = [];
  for (const store of args.stores) {
    const hasMachine = args.withMachine.has(store.id);
    const own = live.filter((c) => c.storeId === store.id);
    const state = states.get(store.id) ?? "missing";
    if (own.length === 0) {
      rows.push({
        key: `store:${store.id}`,
        storeId: store.id,
        storeName: store.name,
        contractId: null,
        terms: termsOf(args.agreements, store.id, null, args.today),
        status: "missing",
        alert: hasMachine,
        hasMachine,
      });
      continue;
    }
    for (const c of own) {
      const status = rowStatus(c, args.reminders.get(c.id), args.due.has(c.id), args.today);
      rows.push({
        key: c.id,
        storeId: store.id,
        storeName: store.name,
        contractId: c.id,
        terms: termsOf(args.agreements, store.id, c.id, args.today),
        status,
        alert: hasMachine && state !== "signed",
        hasMachine,
      });
    }
  }
  rows.sort(
    (a, b) =>
      Number(b.alert) - Number(a.alert) ||
      ORDER[a.status] - ORDER[b.status] ||
      a.storeName.localeCompare(b.storeName, "sv"),
  );
  const count = signedCount(states, args.withMachine);
  return { rows, states, signed: count.signed, total: count.total };
}

/** Rubriken: "2 av 3 butiker har signerat kontrakt." */
export function contractHeadline(signed: number, total: number): string {
  if (total === 0) return "Inga butiker än.";
  if (signed === total) {
    return total === 1
      ? "Butiken har signerat kontrakt."
      : `Alla ${total} butiker har signerat kontrakt.`;
  }
  return `${signed} av ${total} ${total === 1 ? "butik" : "butiker"} har signerat kontrakt.`;
}

function dayText(iso: IsoDate, today: IsoDate): string {
  return formatDate(new Date(`${iso}T12:00:00`), {
    year: "auto",
    now: new Date(`${today}T12:00:00`),
  });
}

/** "Täcker försäljningen sedan 14 okt." under startdagen; en varning när kontraktet börjar senare. */
export function startHint(
  firstSale: string | null,
  validFrom: string,
  today: string,
): string | undefined {
  if (!firstSale) return undefined;
  // "14 okt." slutar redan med punkt.
  const text = dayText(firstSale as IsoDate, today as IsoDate).replace(/\.$/, "");
  return validFrom && validFrom > firstSale
    ? `Automaten har sålt sedan ${text}. Den försäljningen täcks inte.`
    : `Täcker försäljningen sedan ${text}.`;
}

/** Försäljning i en butik som inget signerat kontrakt täcker. */
export interface UncoveredSales {
  readonly storeId: string;
  readonly storeName: string;
  /** Första dagen med försäljning utan signerat kontrakt. */
  readonly from: IsoDate;
  /** Sista dagen i luckan (dagen före nästa signerade kontrakt, annars sista försäljningen). */
  readonly to: IsoDate;
  /** Butikens osignerade kontrakt som gäller nu, och dess startdag (för texten). */
  readonly unsignedId: string | null;
  readonly unsignedFrom: IsoDate | null;
}

/**
 * Butiker där automaten har sålt utan att ett signerat kontrakt täcker försäljningen
 * (Sega gubben: sålt sedan 14 okt., kontraktet osignerat och från 3 nov.). Täckt = ett
 * signerat (eller för hand registrerat) kontrakt, inte arkiverat, gäller den dagen; slutet
 * är validTo eller uppsägningsdagen. Bara den första luckan per butik rapporteras, och bara
 * för butiker som har ett kontrakt (utan kontrakt visar listan redan "Saknas").
 */
export function uncoveredSales(args: {
  stores: readonly { id: string; name: string }[];
  sales: ReadonlyMap<string, { firstSale: IsoDate | null; lastSale: IsoDate | null }>;
  contracts: readonly ContractInput[];
  today: IsoDate;
}): UncoveredSales[] {
  const out: UncoveredSales[] = [];
  for (const store of args.stores) {
    const sale = args.sales.get(store.id);
    if (!sale?.firstSale || !sale.lastSale) continue;
    const own = args.contracts.filter((c) => c.storeId === store.id && !c.archived);
    // Utan kontrakt står butiken redan som "Saknas" i listan; varningen gäller luckor
    // kring ett kontrakt som finns (osignerat, eller signerat från en senare dag).
    if (own.length === 0) continue;
    const spans = own
      .filter(isSigned)
      .map((c) => {
        const ends = [c.validTo, c.terminatedOn ?? null].filter((d): d is IsoDate => d !== null);
        return { start: c.validFrom, end: ends.sort()[0] ?? null };
      })
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    let cursor: IsoDate = sale.firstSale;
    let gapEnd: IsoDate | null = null;
    for (const span of spans) {
      if (span.end !== null && span.end < cursor) continue;
      if (span.start > cursor) {
        gapEnd = addDays(span.start, -1);
        break;
      }
      if (span.end === null) {
        cursor = addDays(sale.lastSale, 1);
        break;
      }
      cursor = addDays(span.end, 1);
    }
    if (cursor > sale.lastSale) continue;
    const to = gapEnd !== null && gapEnd < sale.lastSale ? gapEnd : sale.lastSale;
    const unsigned = own
      .filter((c) => !isSigned(c) && contractInForce(c, args.today))
      .sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1))[0];
    out.push({
      storeId: store.id,
      storeName: store.name,
      from: cursor,
      to,
      unsignedId: unsigned?.id ?? null,
      unsignedFrom: unsigned?.validFrom ?? null,
    });
  }
  return out;
}

/** Varningen på Kontrakt, en mening per butik. */
export function uncoveredText(u: UncoveredSales, today: IsoDate): string {
  const day = (d: IsoDate) => dayText(d, today);
  const span = u.from === u.to ? day(u.from) : `${day(u.from)} – ${day(u.to)}`;
  const head = `${u.storeName} har sålt ${span} utan signerat kontrakt.`;
  if (u.unsignedId && u.unsignedFrom && u.unsignedFrom > u.from) {
    return `${head} Kontraktet gäller först från ${day(u.unsignedFrom)}: ändra startdagen och signera.`;
  }
  return u.unsignedId ? `${head} Signera kontraktet.` : `${head} Skapa ett kontrakt för den tiden.`;
}

/**
 * Rubriken på fliken Intäkt. Intäkt utan signerat kontrakt är den största risken och står
 * först; annars andelen på kontrakt som löper ut inom 12 månader.
 */
export function revenueRiskHeadline(o: {
  readonly totalRevenueOre: number;
  readonly expiringShareBp: number | null;
  readonly noContractShareBp: number | null;
  readonly noContractRevenueOre: number;
}): string {
  if (o.totalRevenueOre <= 0 || o.expiringShareBp === null) {
    return "Ingen intäkt de senaste 12 månaderna.";
  }
  if (o.noContractRevenueOre > 0 && o.noContractShareBp !== null) {
    return `${formatPercent(o.noContractShareBp / 10_000, 0)} av intäkten saknar signerat kontrakt.`;
  }
  return `${formatPercent(o.expiringShareBp / 10_000, 0)} av intäkten löper ut inom 12 mån.`;
}
