/**
 * Abonnemang: texter, format och CSV för fakturaunderlaget. Rena funktioner (ingen databas),
 * testas i model.test.ts.
 */

import type {
  CustomerState,
  InvoiceBasis,
  Money,
  PlanStatus,
  VatMode,
} from "@/analytics/subscriptions/billing";
import type { IsoMonth } from "@/domain";
import { toCsv, type CsvColumn } from "@/lib/csv";
import { formatCsvNumber, formatInt, NBSP } from "@/lib/format";

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];

/** 1 → "1 kund", 3 → "3 kunder". */
export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** "2026-11" → "november 2026". */
export function monthLabel(month: IsoMonth): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2026-11" → "nov." (axlar). */
export function monthShort(month: IsoMonth): string {
  const m = Number(month.slice(5, 7));
  const name = MONTHS[m - 1] ?? "";
  return name.length <= 4 ? name : `${name.slice(0, 3)}.`;
}

/** "2026-11-30" → "30 nov. 2026"; null → "–". */
export function dayLabel(date: string | null): string {
  if (!date) return "–";
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${monthShort(`${y}-${String(m).padStart(2, "0")}`)} ${y}`;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** ?manad=ÅÅÅÅ-MM, annars `fallback`. */
export function parseMonthParam(value: unknown, fallback: IsoMonth): IsoMonth {
  return typeof value === "string" && MONTH_RE.test(value) ? value : fallback;
}

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Öre i valutan: 49 900 → "499 kr", 49 950 → "499,50 kr", DKK → "499 DKK". */
export function formatMoney(
  amountOre: number,
  currency: string,
  decimals: "auto" | 2 = "auto",
): string {
  const neg = amountOre < 0;
  const abs = Math.abs(Math.round(amountOre));
  const kr = Math.floor(abs / 100);
  const ore = abs % 100;
  const body =
    decimals === 2 || ore !== 0
      ? `${groupThousands(kr)},${String(ore).padStart(2, "0")}`
      : groupThousands(kr);
  const unit = currency === "SEK" ? "kr" : currency;
  return `${neg ? "−" : ""}${body}${NBSP}${unit}`;
}

/** Flera valutor: "12 400 kr + 3 000 DKK"; tomt → "0 kr". */
export function formatMoneyList(values: readonly Money[]): string {
  if (values.length === 0) return `0${NBSP}kr`;
  return values.map((v) => formatMoney(v.amountOre, v.currency)).join(" + ");
}

export const STATUS_LABEL: Record<PlanStatus, string> = {
  active: "Aktiv",
  paused: "Pausad",
  ended: "Avslutad",
};

export const STATE_LABEL: Record<CustomerState, string> = {
  active: "Betalar",
  trial: "Provperiod",
  paused: "Pausad",
  ended: "Avslutad",
  none: "Ingen plan",
};

export const VAT_LABEL: Record<VatMode, string> = {
  se_vat: "Svensk moms 25 %",
  reverse_charge: "Omvänd skattskyldighet",
  missing_vat_number: "Svensk moms 25 % (momsnr saknas)",
  outside_eu: "Utanför EU, ingen moms",
};

/** "60 automatdagar à 499 kr" per rad, ihopslaget. */
export function basisSpecification(basis: InvoiceBasis): string {
  if (basis.lines.length === 0) {
    return basis.trialMachineDays > 0
      ? `${formatInt(basis.trialMachineDays)} automatdagar i provperiod`
      : "Inget att fakturera";
  }
  return basis.lines
    .map(
      (l) =>
        `${formatInt(l.machineDays)} automatdagar à ${formatMoney(l.pricePerMachineOre, l.currency)}/mån (${formatInt(basis.daysInMonth)} dagar)`,
    )
    .join("; ");
}

export interface InvoiceCsvRow {
  name: string;
  slug: string;
  countryCode: string | null;
  vatNumber: string | null;
  basis: InvoiceBasis;
}

interface FlatRow {
  r: InvoiceCsvRow;
  currency: string;
  netOre: number;
  vatOre: number;
  totalOre: number;
  machineDays: number;
}

/** En rad per kund och valuta. Kunder utan belopp (provperiod, paus) får en nollrad. */
export function invoiceCsv(month: IsoMonth, rows: readonly InvoiceCsvRow[]): string {
  const flat: FlatRow[] = rows.flatMap((r) => {
    if (r.basis.totals.length === 0) {
      return [{ r, currency: "", netOre: 0, vatOre: 0, totalOre: 0, machineDays: 0 }];
    }
    return r.basis.totals.map((t) => ({
      r,
      currency: t.currency,
      netOre: t.netOre,
      vatOre: t.vatOre,
      totalOre: t.totalOre,
      machineDays: r.basis.lines
        .filter((l) => l.currency === t.currency)
        .reduce((n, l) => n + l.machineDays, 0),
    }));
  });
  const kr = (ore: number) => formatCsvNumber(ore / 100, 2);
  const columns: CsvColumn<FlatRow>[] = [
    { header: "Månad", csv: () => month },
    { header: "Kund", csv: (x) => x.r.name },
    { header: "Kund-id", csv: (x) => x.r.slug },
    { header: "Land", csv: (x) => x.r.countryCode ?? "SE" },
    { header: "Momsnummer", csv: (x) => x.r.vatNumber ?? "" },
    { header: "Moms", csv: (x) => VAT_LABEL[x.r.basis.vat.mode] },
    { header: "Valuta", csv: (x) => x.currency },
    { header: "Aktiva automater", csv: (x) => x.r.basis.activeMachines },
    { header: "Debiterade automatdagar", csv: (x) => x.machineDays },
    { header: "Dagar i månaden", csv: (x) => x.r.basis.daysInMonth },
    { header: "Belopp exkl. moms", csv: (x) => kr(x.netOre) },
    { header: "Momssats %", csv: (x) => formatCsvNumber(x.r.basis.vat.rateBp / 100, 0) },
    { header: "Moms", csv: (x) => kr(x.vatOre) },
    { header: "Att fakturera", csv: (x) => kr(x.totalOre) },
    { header: "Specifikation", csv: (x) => basisSpecification(x.r.basis) },
    { header: "Notering", csv: (x) => x.r.basis.vat.note },
  ];
  return toCsv(flat, columns);
}
