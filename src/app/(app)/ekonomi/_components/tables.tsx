"use client";

/**
 * Tabellerna på Ekonomi: verifikationer, kontosammanställning och kassaflöde per månad.
 * Kolumnerna definieras här (utanför render), talen kommer färdiga från servern.
 */

import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag } from "@/components/ui/status-tag";
import { formatCsvNumber, formatDate } from "@/lib/format";

import { isoToDate, kr, monthText, sek, signedSek } from "../_lib/view";

// ---------------------------------------------------------------------------
// Verifikationer
// ---------------------------------------------------------------------------

export type VerificationRow = {
  key: string;
  number: number;
  date: string;
  text: string;
  amountOre: number;
  rows: string;
};

const VERIFICATION_COLUMNS: ReadonlyArray<Column<VerificationRow>> = [
  {
    key: "nr",
    header: "Ver",
    numeric: true,
    sortValue: (r) => r.number,
    render: (r) => <span className="tnum">{r.number}</span>,
    width: 64,
    hideOnMobile: true,
  },
  {
    key: "datum",
    header: "Datum",
    sortValue: (r) => r.date,
    render: (r) => (
      <span className="tnum whitespace-nowrap">
        {formatDate(isoToDate(r.date), { year: "never" })}
      </span>
    ),
    csv: (r) => r.date,
    width: 96,
  },
  {
    key: "text",
    header: "Text",
    sortValue: (r) => r.text,
    render: (r) => (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-fg">{r.text}</span>
        <span className="meta hidden text-subtle sm:block">{r.rows}</span>
      </span>
    ),
    csv: (r) => `${r.text} (${r.rows})`,
  },
  {
    key: "belopp",
    header: "Belopp",
    numeric: true,
    sortValue: (r) => r.amountOre,
    render: (r) => kr(r.amountOre),
    csv: (r) => formatCsvNumber(r.amountOre / 100),
  },
];

export function VerificationTable({ rows, month }: { rows: VerificationRow[]; month: string }) {
  return (
    <DataTable
      columns={VERIFICATION_COLUMNS}
      rows={rows}
      rowKey={(r) => r.key}
      caption={`Verifikationer ${monthText(month)}`}
      dense
      exportFileName={`verifikationer-${month}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Konton
// ---------------------------------------------------------------------------

export type AccountRow = { account: string; name: string; debitOre: number; creditOre: number };

export function AccountTable({
  rows,
  month,
  totals,
}: {
  rows: AccountRow[];
  month: string;
  totals: { debitOre: number; creditOre: number };
}) {
  const columns: ReadonlyArray<Column<AccountRow>> = [
    {
      key: "konto",
      header: "Konto",
      sortValue: (r) => r.account,
      render: (r) => <span className="font-mono text-sm">{r.account}</span>,
      footer: <span className="label text-muted">Summa</span>,
      width: 80,
    },
    { key: "namn", header: "Namn", sortValue: (r) => r.name, render: (r) => r.name },
    {
      key: "debet",
      header: "Debet",
      numeric: true,
      sortValue: (r) => r.debitOre,
      render: (r) => (r.debitOre === 0 ? "" : kr(r.debitOre)),
      csv: (r) => formatCsvNumber(r.debitOre / 100),
      footer: kr(totals.debitOre),
    },
    {
      key: "kredit",
      header: "Kredit",
      numeric: true,
      sortValue: (r) => r.creditOre,
      render: (r) => (r.creditOre === 0 ? "" : kr(r.creditOre)),
      csv: (r) => formatCsvNumber(r.creditOre / 100),
      footer: kr(totals.creditOre),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.account}
      caption={`Konton ${monthText(month)}`}
      dense
      exportFileName={`konton-${month}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Kassaflöde
// ---------------------------------------------------------------------------

export type CashRow = {
  key: string;
  /** "untracked": avslutad månad utan inläst utbetalningsfil (inte "Faktiskt 0 kr"). */
  phase: "actual" | "forecast" | "mixed" | "untracked";
  partial: boolean;
  payoutsOre: number;
  purchasesOre: number;
  storeCompensationOre: number;
  fixedCostsOre: number;
  netOre: number;
  summary: string;
  /** Förklaring när månaden ser tom ut, t.ex. att utbetalningen kom månaden efter. */
  note: string | null;
};

const PHASE: Record<CashRow["phase"], string> = {
  actual: "Faktiskt",
  forecast: "Prognos",
  mixed: "Faktiskt och prognos",
  untracked: "Saknar utbetalningsfil",
};

const CASH_COLUMNS: ReadonlyArray<Column<CashRow>> = [
  {
    key: "manad",
    header: "Månad",
    sortValue: (r) => r.key,
    render: (r) => (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="whitespace-nowrap text-fg" title={r.summary}>
          {monthText(r.key)}
        </span>
        {r.note ? <span className="text-xs text-subtle">{r.note}</span> : null}
      </span>
    ),
    csv: (r) => r.key,
  },
  {
    key: "lage",
    header: "Läge",
    sortValue: (r) => r.phase,
    render: (r) => (
      <StatusTag
        status={
          r.phase === "actual"
            ? "ok"
            : r.phase === "forecast"
              ? "offline"
              : r.phase === "untracked"
                ? "warning"
                : "neutral"
        }
      >
        {PHASE[r.phase]}
      </StatusTag>
    ),
    csv: (r) => PHASE[r.phase],
  },
  {
    key: "in",
    header: "Utbetalningar in",
    numeric: true,
    sortValue: (r) => r.payoutsOre,
    render: (r) => sek(r.payoutsOre),
    csv: (r) => formatCsvNumber(r.payoutsOre / 100),
  },
  {
    key: "inkop",
    header: "Inköp",
    numeric: true,
    hideOnMobile: true,
    sortValue: (r) => r.purchasesOre,
    render: (r) => sek(r.purchasesOre),
    csv: (r) => formatCsvNumber(r.purchasesOre / 100),
  },
  {
    key: "butik",
    header: "Butiksersättning",
    numeric: true,
    hideOnMobile: true,
    sortValue: (r) => r.storeCompensationOre,
    render: (r) => sek(r.storeCompensationOre),
    csv: (r) => formatCsvNumber(r.storeCompensationOre / 100),
  },
  {
    key: "fasta",
    header: "Fasta kostnader",
    numeric: true,
    hideOnMobile: true,
    sortValue: (r) => r.fixedCostsOre,
    render: (r) => sek(r.fixedCostsOre),
    csv: (r) => formatCsvNumber(r.fixedCostsOre / 100),
  },
  {
    key: "netto",
    header: "Netto",
    numeric: true,
    sortValue: (r) => r.netOre,
    render: (r) => <span className="text-fg">{signedSek(r.netOre)}</span>,
    csv: (r) => formatCsvNumber(r.netOre / 100),
  },
];

export function CashflowTable({ rows }: { rows: CashRow[] }) {
  return (
    <DataTable
      columns={CASH_COLUMNS}
      rows={rows}
      rowKey={(r) => r.key}
      caption="Kassaflöde per månad"
      exportFileName="kassaflode"
    />
  );
}
