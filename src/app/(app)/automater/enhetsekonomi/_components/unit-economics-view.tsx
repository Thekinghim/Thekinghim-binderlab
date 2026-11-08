"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { signedPct, type UnitEconomicsComparisonRow } from "@/analytics/expansion";
import { BarChart } from "@/components/charts/bar-chart";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { StateMessage } from "@/components/ui/state-message";
import type { MachineUnitEconomics, Period } from "@/domain";
import { formatInt, formatSek, MISSING } from "@/lib/format";

import { FormModal, type FieldSpec } from "../../../expansion/_components/form-kit";
import {
  kr,
  krOrMissing,
  oreToInput,
  paybackShort,
  pctOrMissing,
} from "../../../expansion/_lib/display";
import type { Named } from "../../../expansion/_lib/data";
import type { InvestmentRecord } from "../../../expansion/_lib/service";
import { saveInvestment } from "../actions";

const KIND_LABEL: Record<InvestmentRecord["kind"], string> = {
  purchase: "Inköp",
  installation: "Installation",
  other: "Övrigt",
};

function lonsamhetHref(period: Period, machineId: string) {
  return `/lonsamhet?from=${period.start}&to=${period.end}&automat=${machineId}&grupp=titel`;
}

export function UnitEconomicsKpis({
  averageProfitPerDayOre,
  averageRevenuePerDayOre,
  investmentOre,
  bookValueOre,
  comparison,
}: {
  averageProfitPerDayOre: number | null;
  averageRevenuePerDayOre: number | null;
  investmentOre: number;
  bookValueOre: number;
  comparison: string;
}) {
  const sek = (ore: number) => formatSek(ore / 100);
  const items: KpiItem[] = [
    {
      id: "profit",
      label: "Vinst per automat och dag",
      value: averageProfitPerDayOre ?? 0,
      format: (v) => (averageProfitPerDayOre === null ? MISSING : sek(v)),
      primary: true,
    },
    {
      id: "revenue",
      label: "Intäkt per dag",
      value: averageRevenuePerDayOre ?? 0,
      format: (v) => (averageRevenuePerDayOre === null ? MISSING : sek(v)),
    },
    { id: "investment", label: "Investerat", value: investmentOre, format: sek },
    { id: "book", label: "Bokfört värde", value: bookValueOre, format: sek },
  ];
  return <KpiStrip items={items} label="Alla automater" headingLevel={2} comparison={comparison} />;
}

export function ProfitPerDayChart({
  rows,
  codes,
}: {
  rows: ReadonlyArray<UnitEconomicsComparisonRow>;
  codes: Record<string, string>;
}) {
  const data = rows
    .filter((r) => r.profitPerDayOre !== null)
    .map((r) => ({
      label: codes[r.machineId] ?? r.name,
      code: codes[r.machineId],
      name: r.name,
      value: r.profitPerDayOre! / 100,
    }));
  if (data.length === 0) {
    return (
      <StateMessage
        kind="empty"
        compact
        message="Ingen automat var placerad i perioden."
        action={{ label: "Välj en längre period", href: "?period=allt" }}
      />
    );
  }
  return (
    <BarChart
      data={data}
      format={formatSek}
      showMean
      labelHeading="Automat"
      valueHeading="Vinst per dag"
      summary={`Vinst per dag för ${data.length} automater.`}
    />
  );
}

export function ComparisonTable({
  rows,
  units,
  codes,
  period,
}: {
  rows: ReadonlyArray<UnitEconomicsComparisonRow>;
  units: ReadonlyArray<MachineUnitEconomics>;
  codes: Record<string, string>;
  period: Period;
}) {
  const unitById = useMemo(() => new Map(units.map((u) => [u.machineId, u])), [units]);
  const columns = useMemo<Column<UnitEconomicsComparisonRow>[]>(
    () => [
      {
        key: "machine",
        header: "Automat",
        sortValue: (r) => codes[r.machineId] ?? r.name,
        render: (r) => (
          <Link
            href={lonsamhetHref(period, r.machineId)}
            className="flex min-w-0 flex-col rounded-xs hover:underline max-md:min-h-11 max-md:justify-center"
            title={r.name}
          >
            <span className="font-mono text-sm">
              {codes[r.machineId] ?? r.machineId.slice(0, 8)}
            </span>
            {/* Under md bara koden, så att vinst och återbetalning ryms i 375 px. */}
            <span className="hidden truncate text-sm text-muted md:block">{r.name}</span>
          </Link>
        ),
        csv: (r) => r.name,
      },
      {
        key: "days",
        header: "Dagar",
        numeric: true,
        sortValue: (r) => r.activeDays,
        render: (r) => formatInt(r.activeDays),
        hideOnMobile: true,
        // Dold från start så att tabellen ryms i 1 440 px; kan väljas under Kolumner.
        defaultHidden: true,
      },
      {
        key: "revenueDay",
        header: "Intäkt/dag",
        numeric: true,
        sortValue: (r) => r.revenuePerDayOre ?? Number.NaN,
        render: (r) => krOrMissing(r.revenuePerDayOre),
        hideOnMobile: true,
      },
      {
        key: "profitDay",
        header: "Vinst/dag",
        numeric: true,
        sortValue: (r) => r.profitPerDayOre ?? Number.NaN,
        render: (r) => krOrMissing(r.profitPerDayOre),
      },
      {
        key: "vsAvg",
        header: "Mot snitt",
        numeric: true,
        sortValue: (r) => r.vsAverageBp ?? Number.NaN,
        render: (r) => (r.vsAverageBp === null ? MISSING : signedPct(r.vsAverageBp)),
        hideOnMobile: true,
      },
      {
        key: "profitMonth",
        header: "Vinst/mån",
        numeric: true,
        sortValue: (r) => r.profitPerMonthOre ?? Number.NaN,
        render: (r) => krOrMissing(r.profitPerMonthOre),
        hideOnMobile: true,
      },
      {
        key: "afterDep",
        header: "Efter avskr./mån",
        numeric: true,
        sortValue: (r) => r.profitPerMonthAfterDepreciationOre ?? Number.NaN,
        render: (r) => krOrMissing(r.profitPerMonthAfterDepreciationOre),
        hideOnMobile: true,
      },
      {
        key: "investment",
        header: "Investering",
        numeric: true,
        sortValue: (r) => r.investmentOre,
        render: (r) => (r.investmentOre === 0 ? MISSING : kr(r.investmentOre)),
        // Summan står i nyckeltalen (Investerat); under md får återbetalningen plats.
        hideOnMobile: true,
      },
      {
        key: "book",
        header: "Bokfört värde",
        numeric: true,
        sortValue: (r) => unitById.get(r.machineId)?.bookValueOre ?? 0,
        render: (r) => krOrMissing(unitById.get(r.machineId)?.bookValueOre),
        hideOnMobile: true,
        defaultHidden: true,
      },
      {
        key: "payback",
        header: "Återbetalning",
        numeric: true,
        sortValue: (r) => r.paybackTenths ?? Number.NaN,
        render: (r) => paybackShort(r.paybackTenths),
      },
      {
        key: "return",
        header: "Avkastning/år",
        numeric: true,
        sortValue: (r) => r.annualReturnBp ?? Number.NaN,
        render: (r) => pctOrMissing(r.annualReturnBp),
        hideOnMobile: true,
      },
    ],
    [codes, period, unitById],
  );
  return (
    <DataTable
      surface="bg"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.machineId}
      caption="Enhetsekonomi per automat, sida vid sida"
      defaultSort={null}
      columnPicker
      exportFileName={`enhetsekonomi-${period.start}-${period.end}`}
    />
  );
}

const INVESTMENT_FIELDS = (machines: ReadonlyArray<Named>): FieldSpec[] => [
  {
    name: "machineId",
    label: "Automat",
    type: "select",
    required: true,
    options: machines.map((m) => ({ value: m.id, label: `${m.code ?? ""} ${m.name}`.trim() })),
    span: 2,
  },
  {
    name: "kind",
    label: "Typ",
    type: "select",
    required: true,
    options: [
      { value: "purchase", label: "Inköp av automaten" },
      { value: "installation", label: "Installation och frakt" },
      { value: "other", label: "Övrigt" },
    ],
  },
  { name: "amountOre", label: "Belopp", type: "decimal", suffix: "kr", required: true },
  { name: "investedOn", label: "Datum", type: "date", required: true },
  {
    name: "depreciationMonths",
    label: "Avskrivningstid",
    type: "integer",
    suffix: "mån",
    hint: "Linjär avskrivning. Tomt = skrivs inte av.",
  },
  { name: "note", label: "Anteckning", type: "text", span: 2 },
];

export function InvestmentsSection({
  investments,
  machines,
  canEdit,
  today,
}: {
  investments: ReadonlyArray<InvestmentRecord>;
  machines: ReadonlyArray<Named>;
  canEdit: boolean;
  today: string;
}) {
  const [editing, setEditing] = useState<InvestmentRecord | "new" | null>(null);
  const byId = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines]);
  const active = machines.filter((m) => !m.archived);
  const fields = useMemo(() => INVESTMENT_FIELDS(active), [active]);

  const columns = useMemo<Column<InvestmentRecord>[]>(
    () => [
      {
        key: "machine",
        header: "Automat",
        sortValue: (r) => byId.get(r.machineId)?.code ?? r.machineId,
        render: (r) => (
          <span className="flex flex-col">
            <span className="font-mono text-sm">{byId.get(r.machineId)?.code ?? MISSING}</span>
            <span className="text-sm text-muted">{byId.get(r.machineId)?.name ?? ""}</span>
          </span>
        ),
      },
      { key: "kind", header: "Typ", render: (r) => KIND_LABEL[r.kind] },
      {
        key: "date",
        header: "Datum",
        sortValue: (r) => r.investedOn,
        render: (r) => <span className="font-mono text-sm">{r.investedOn}</span>,
        hideOnMobile: true,
      },
      {
        key: "amount",
        header: "Belopp",
        numeric: true,
        sortValue: (r) => r.amountOre,
        render: (r) => kr(r.amountOre),
      },
      {
        key: "dep",
        header: "Avskrivning",
        numeric: true,
        sortValue: (r) => r.depreciationMonths ?? 0,
        render: (r) => (r.depreciationMonths ? `${r.depreciationMonths} mån` : "ingen"),
        hideOnMobile: true,
      },
      {
        key: "note",
        header: "Anteckning",
        render: (r) => <span className="text-muted">{r.note ?? ""}</span>,
        hideOnMobile: true,
      },
      ...(canEdit
        ? [
            {
              key: "edit",
              header: "Åtgärd",
              hideable: false,
              render: (r: InvestmentRecord) => (
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  Ändra
                </Button>
              ),
            } satisfies Column<InvestmentRecord>,
          ]
        : []),
    ],
    [byId, canEdit],
  );

  const initial =
    editing === null || editing === "new"
      ? {
          machineId: active[0]?.id ?? "",
          kind: "purchase",
          amountOre: "",
          investedOn: today,
          depreciationMonths: "60",
          note: "",
        }
      : {
          machineId: editing.machineId,
          kind: editing.kind,
          amountOre: oreToInput(editing.amountOre),
          investedOn: editing.investedOn,
          depreciationMonths: editing.depreciationMonths ? String(editing.depreciationMonths) : "",
          note: editing.note ?? "",
        };

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="secondary"
            iconLeft="plus"
            onClick={() => setEditing("new")}
            disabled={active.length === 0}
          >
            Ny investering
          </Button>
        </div>
      ) : null}
      {investments.length === 0 ? (
        <StateMessage kind="empty" message="Ingen investering registrerad." />
      ) : (
        <DataTable
          surface="bg"
          columns={columns}
          rows={investments}
          rowKey={(r) => r.id}
          caption="Investeringar per automat"
          defaultSort={{ key: "date", dir: "asc" }}
          dense
        />
      )}
      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Ny investering" : "Ändra investering"}
        eyebrow="Enhetsekonomi"
        description="Investeringar raderas aldrig. Fel rättas genom att beloppet ändras; ändringen loggas."
        fields={fields}
        initial={initial}
        fixed={{ id: editing && editing !== "new" ? editing.id : null }}
        action={saveInvestment}
        success={editing === "new" ? "Investeringen är registrerad" : "Investeringen är ändrad"}
      />
    </div>
  );
}
