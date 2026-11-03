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
import type { IsoDate } from "@/domain";
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
