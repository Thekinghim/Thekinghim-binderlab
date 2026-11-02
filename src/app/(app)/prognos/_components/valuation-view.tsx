"use client";

import { useMemo } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiStrip } from "@/components/ui/kpi-strip";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, MISSING } from "@/lib/format";

import type { ValuationModel, ValuationRow } from "../_lib/model";
import { kr, krExact, packsMilli, percentBp } from "../_lib/units";
import { EvidenceButton } from "./evidence-button";

const SOURCE: Record<ValuationRow["costSource"], string> = {
  "purchase-price": "Inköpspris",
  "supplier-item": "Leverantörens pris",
  none: "Pris saknas",
};

/** Lagervärde och kapitalbindning per titel. */
export function ValuationView({ model }: { model: ValuationModel }) {
  const columns = useMemo<Column<ValuationRow>[]>(
    () => [
      {
        key: "title",
        header: "Titel",
        sortValue: (r) => r.title,
        render: (r) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">{r.title}</span>
            <span className="text-xs text-subtle">
              {r.unitCostOre === null
                ? SOURCE.none
                : `${krExact(r.unitCostOre)} · ${SOURCE[r.costSource]}`}
            </span>
          </span>
        ),
        csv: (r) => r.title,
      },
      {
        key: "warehouse",
        header: "Centrallager",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.warehouseOnHand,
        render: (r) => formatInt(r.warehouseOnHand),
      },
      {
        key: "machines",
        header: "Automater",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.machineOnHand,
        render: (r) => formatInt(r.machineOnHand),
      },
      {
        key: "value",
        header: "Lagervärde",
        numeric: true,
        sortValue: (r) => r.valueOre,
        render: (r) => kr(r.valueOre),
        csv: (r) => r.valueOre / 100,
      },
      {
        key: "onOrder",
        header: "Beställt",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.onOrderValueOre,
        render: (r) => (r.onOrderPacks > 0 ? kr(r.onOrderValueOre) : MISSING),
        csv: (r) => r.onOrderValueOre / 100,
      },
      {
        key: "capital",
        header: "Kapitalbindning",
        numeric: true,
        sortValue: (r) => r.capitalTiedOre,
        render: (r) => <span className="text-fg">{kr(r.capitalTiedOre)}</span>,
        csv: (r) => r.capitalTiedOre / 100,
      },
      {
        key: "share",
        header: "Andel",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.shareBp ?? -1,
        render: (r) => percentBp(r.shareBp, 0),
        csv: (r) => (r.shareBp === null ? null : r.shareBp / 100),
      },
      {
        key: "cover",
        header: "Räcker",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.coverDays ?? 100_000,
        render: (r) =>
          r.coverDays === null
            ? r.demandPerDayMilli === 0
              ? "Ingen försäljning"
              : "Över ett år"
            : `${formatInt(r.coverDays)} d`,
        csv: (r) => r.coverDays,
      },
      {
        key: "rate",
        header: "Pack/dag",
        numeric: true,
        defaultHidden: true,
        sortValue: (r) => r.demandPerDayMilli,
        render: (r) => packsMilli(r.demandPerDayMilli),
        csv: (r) => r.demandPerDayMilli / 1000,
      },
      {
        key: "evidence",
        header: "Underlag",
        hideable: false,
        render: (r) => <EvidenceButton evidence={r.evidence} title={r.title} text={r.text} />,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-10">
      <KpiStrip
        label="Lager och beställt i dag"
        items={[
          {
            id: "capital",
            label: "Kapitalbindning",
            value: model.capitalTiedOre,
            format: kr,
            primary: true,
          },
          { id: "warehouse", label: "Centrallager", value: model.warehouseValueOre, format: kr },
          { id: "machines", label: "I automaterna", value: model.machineValueOre, format: kr },
          { id: "onOrder", label: "Beställt", value: model.onOrderValueOre, format: kr },
        ]}
      />
      {model.rows.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Inget lager är registrerat i centrallagret eller automaterna."
          action={{ label: "Öppna lagret", href: "/lager" }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <DataTable
            columns={columns}
            rows={model.rows}
            rowKey={(r) => r.titleId}
            caption="Lagervärde och kapitalbindning per titel"
            defaultSort={{ key: "capital", dir: "desc" }}
            dense
            columnPicker
            exportFileName="lagervarde"
          />
          <div className="flex justify-end">
            <EvidenceButton
              evidence={model.evidence}
              title="Lagervärde"
              text={model.heading.aside}
            />
          </div>
        </div>
      )}
      {model.titlesWithoutCost.length > 0 ? (
        <p className="text-sm text-muted">
          Utan inköpspris: {model.titlesWithoutCost.join(", ")}. Lägg in priset under Inköpspriser.
        </p>
      ) : null}
    </div>
  );
}
