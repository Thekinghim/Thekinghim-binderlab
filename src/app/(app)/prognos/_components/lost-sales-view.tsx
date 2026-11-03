"use client";

import { useMemo } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiStrip } from "@/components/ui/kpi-strip";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { formatInt } from "@/lib/format";

import type { LostModel, LostRow } from "../_lib/model";
import { daysBp, kr, packsMilli, packsWhole, titleDaysBp } from "../_lib/units";
import { EvidenceButton } from "./evidence-button";

/** Slutsåld just nu (varning) eller påfylld igen (info). */
/**
 * Läget för en period. En period som pågått längre än analysens gräns (capped) räknas som
 * tagen ur sortimentet: den kostar inget efter gränsen och är ingen åtgärd (grått).
 */
function LostStatus({ ongoing, capped }: { ongoing: boolean; capped: boolean }) {
  if (ongoing && capped) return <StatusTag status="neutral">Ur sortimentet</StatusTag>;
  return ongoing ? (
    <StatusTag status="warning">Slutsåld nu</StatusTag>
  ) : (
    <StatusTag status="neutral">Påfylld</StatusTag>
  );
}

/** Förlorad försäljning: nyckeltal, perioderna med slutsålt och summan per månad. */
export function LostSalesView({ model }: { model: LostModel }) {
  const columns = useMemo<Column<LostRow>[]>(
    () => [
      {
        key: "title",
        header: "Titel",
        sortValue: (r) => r.title,
        render: (r) => (
          // md:min-w-44: titel och automat på en rad var i stället för tre smala rader.
          <span className="flex min-w-0 flex-col md:min-w-44">
            <span className="text-fg">{r.title}</span>
            <span className="text-xs text-subtle">{r.machine}</span>
            {/* Under md står perioden och läget här; kolumnerna är dolda (design.md §5.1). */}
            <span className="tnum text-xs text-subtle md:hidden">{r.periodText}</span>
            <span className="mt-1 md:hidden">
              <LostStatus ongoing={r.ongoing} capped={r.capped} />
            </span>
          </span>
        ),
        // CSV med vanligt bindestreck i koden (namnen har hårt bindestreck för visning).
        csv: (r) => `${r.title} – ${r.machine.replace(/\u2011/g, "-")}`,
      },
      {
        key: "period",
        header: "Slutsåld",
        hideOnMobile: true,
        sortValue: (r) => r.start,
        render: (r) => <span className="tnum">{r.periodText}</span>,
        csv: (r) => `${r.start}–${r.end}`,
      },
      {
        key: "status",
        header: "Läge",
        hideable: false,
        hideOnMobile: true,
        render: (r) => <LostStatus ongoing={r.ongoing} capped={r.capped} />,
        csv: (r) => (r.ongoing ? "Slutsåld nu" : "Påfylld"),
      },
      {
        key: "source",
        header: "Källa",
        hideOnMobile: true,
        sortValue: (r) => r.source,
        render: (r) => (
          <span className="text-muted">
            {r.source === "stock" ? "Lagret" : "Bedömd ur försäljningen"}
          </span>
        ),
        csv: (r) => (r.source === "stock" ? "Lagret" : "Bedömd"),
      },
      {
        key: "days",
        header: "Dagar",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.dayWeightBp,
        render: (r) => daysBp(r.dayWeightBp),
        csv: (r) => r.dayWeightBp / 10_000,
      },
      {
        key: "rate",
        header: "Takt före",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.ratePerDayMilli,
        render: (r) => (
          <span className={r.rateLowData ? "text-subtle" : undefined}>
            {packsMilli(r.ratePerDayMilli)} /dag
          </span>
        ),
        csv: (r) => r.ratePerDayMilli / 1000,
      },
      {
        key: "units",
        header: "Pack",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.lostUnitsMilli,
        render: (r) => packsMilli(r.lostUnitsMilli),
        csv: (r) => r.lostUnitsMilli / 1000,
      },
      {
        key: "revenue",
        // Kort huvud (sektionen heter Förlorad försäljning) så att beloppet ryms i 375 px.
        header: "Förlorat",
        numeric: true,
        sortValue: (r) => r.lostRevenueOre,
        render: (r) => <span className="text-fg">{kr(r.lostRevenueOre)}</span>,
        csv: (r) => r.lostRevenueOre / 100,
      },
      {
        key: "gross",
        header: "Minus inköp",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.lostGrossProfitOre ?? -1,
        render: (r) =>
          r.lostGrossProfitOre === null ? (
            <span className="text-subtle">Pris saknas</span>
          ) : (
            kr(r.lostGrossProfitOre)
          ),
        csv: (r) => (r.lostGrossProfitOre === null ? null : r.lostGrossProfitOre / 100),
      },
      {
        key: "evidence",
        header: "Underlag",
        hideable: false,
        render: (r) => (
          <EvidenceButton evidence={r.evidence} title={`${r.title} i ${r.machine}`} text={r.text} />
        ),
      },
    ],
    [],
  );

  if (model.rows.length === 0) {
    return (
      <StateMessage
        kind="empty"
        compact
        message={`Ingen titel var slutsåld ${model.periodText} i någon automat.`}
        detail="Slutsålt räknas ur lagerhändelserna; där saldot är okänt bedöms det ur försäljningen."
        action={{ label: "Öppna lagret", href: "/lager" }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <KpiStrip
        label={`Förlorad försäljning · ${model.periodText}`}
        items={[
          {
            id: "revenue",
            label: "Förlorad intäkt",
            value: model.totalRevenueOre,
            format: kr,
            primary: true,
          },
          {
            id: "gross",
            label: "Minus inköp",
            value: model.totalGrossProfitOre,
            format: kr,
          },
          {
            id: "units",
            // Uppskattning: hela pack med "ca", inga tiondelar.
            label: "Förlorade pack",
            value: model.totalUnitsMilli,
            format: (v) => (v >= 1_000 ? `ca ${packsWhole(v)}` : packsMilli(v)),
          },
          {
            id: "days",
            // Summa över titlar och automater (se noten under tabellen), inte kalenderdagar.
            label: "Titeldagar slutsålt",
            value: model.totalDayWeightBp,
            format: (v) => titleDaysBp(v),
          },
        ]}
      />

      <DataTable
        surface="bg"
        columns={columns}
        rows={model.rows}
        rowKey={(r) => r.key}
        caption={`Perioder med slutsålt ${model.periodText}`}
        defaultSort={{ key: "revenue", dir: "desc" }}
        dense
        exportFileName={`forlorad-forsaljning-${model.period.start}-${model.period.end}`}
      />

      <details className="text-sm text-muted">
        <summary className="label cursor-pointer text-subtle hover:text-fg">Så räknas det</summary>
        <p className="mt-2 max-w-prose">
          En titeldag är en titel slutsåld i en automat en dag; samma titel slutsåld i två automater
          samma dag är två titeldagar. Påfyllningsdagen räknas som en halv dag.
          {model.hiddenWithoutCost > 0
            ? ` ${formatInt(model.hiddenWithoutCost)} ${model.hiddenWithoutCost === 1 ? "period" : "perioder"} för titlar som togs ur sortimentet före ${model.periodText} kostar inget och visas inte.`
            : ""}
        </p>
      </details>

      {model.months.length > 1 ? (
        <ul className="flex flex-col">
          {model.months.map((m) => (
            <li
              key={m.month}
              className="flex flex-col gap-1 border-t border-line py-3 last:border-b sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-fg">{m.text}</span>
                <span className="text-xs text-subtle">{m.detail}</span>
              </span>
              <EvidenceButton evidence={m.evidence} title={m.text} />
            </li>
          ))}
        </ul>
      ) : null}

      {model.mismatches > 0 ? (
        <p className="text-sm text-muted">
          {formatInt(model.mismatches)} {model.mismatches === 1 ? "dag hade" : "dagar hade"}{" "}
          försäljning trots saldo 0 i lagret. En påfyllning saknas troligen; de dagarna räknas som
          att titeln fanns.
        </p>
      ) : null}
    </div>
  );
}
