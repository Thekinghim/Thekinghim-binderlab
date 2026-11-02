"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { formatInt, MISSING } from "@/lib/format";

import { dateText } from "../_lib/dates";
import type { PlanLineView, PlanModel, SupplierView } from "../_lib/model";
import { kr, packsMilli } from "../_lib/units";
import { CreateOrderDialog, type OrderDraft } from "./create-order-dialog";
import { EvidenceButton } from "./evidence-button";

function coverText(days: number | null): string {
  if (days === null) return "över ett år";
  return `${formatInt(days)} ${days === 1 ? "dag" : "dagar"}`;
}

const proposalColumns: Column<PlanLineView>[] = [
  {
    key: "title",
    header: "Titel",
    sortValue: (r) => r.title,
    render: (r) => <span className="text-fg">{r.title}</span>,
  },
  {
    key: "status",
    header: "Läge",
    hideable: false,
    render: (r) => <StatusTag status={r.tone}>{r.statusLabel}</StatusTag>,
    csv: (r) => r.statusLabel,
  },
  {
    key: "stock",
    header: "Lager",
    numeric: true,
    hideOnMobile: true,
    sortValue: (r) => r.positionPacks,
    render: (r) => (
      <span
        title={`Centrallager ${r.warehouseOnHand}, automater ${r.machineOnHand}, beställt ${r.onOrderCounted}`}
      >
        {formatInt(r.positionPacks)}
      </span>
    ),
    csv: (r) => r.positionPacks,
  },
  {
    key: "need",
    header: "Behov + säkerhet",
    numeric: true,
    hideOnMobile: true,
    sortValue: (r) => r.targetMilli,
    render: (r) => (
      <span>
        {packsMilli(r.demandProtectionMilli)}
        <span className="text-subtle"> + {packsMilli(r.safetyStockMilli)}</span>
      </span>
    ),
    csv: (r) => r.targetMilli / 1000,
  },
  {
    key: "qty",
    header: "Beställ",
    numeric: true,
    sortValue: (r) => r.orderQty,
    render: (r) => (
      <span className="flex flex-col items-end">
        <span className="text-fg">{formatInt(r.orderQty)} pack</span>
        <span className="text-xs text-subtle">
          {r.boxes} × {r.packSize}
        </span>
      </span>
    ),
    csv: (r) => r.orderQty,
  },
  {
    key: "value",
    header: "Värde",
    numeric: true,
    sortValue: (r) => r.orderValueOre,
    render: (r) => kr(r.orderValueOre),
    csv: (r) => r.orderValueOre / 100,
  },
  {
    key: "orderBy",
    header: "Beställ senast",
    hideOnMobile: true,
    sortValue: (r) => r.orderBy ?? "9999",
    render: (r) => <span className="tnum">{r.orderBy ? dateText(r.orderBy) : MISSING}</span>,
    csv: (r) => r.orderBy,
  },
  {
    key: "evidence",
    header: "Underlag",
    hideable: false,
    render: (r) => <EvidenceButton evidence={r.evidence} title={r.title} text={r.text} />,
  },
];

const allColumns: Column<PlanLineView>[] = [
  {
    key: "title",
    header: "Titel",
    sortValue: (r) => r.title,
    render: (r) => (
      <span className="flex min-w-0 flex-col">
        <span className="text-fg">{r.title}</span>
        <span className="text-xs text-subtle">{r.supplierName ?? "Ingen leverantör"}</span>
      </span>
    ),
    csv: (r) => r.title,
  },
  {
    key: "status",
    header: "Läge",
    hideable: false,
    sortValue: (r) => r.statusLabel,
    render: (r) => <StatusTag status={r.tone}>{r.statusLabel}</StatusTag>,
    csv: (r) => r.statusLabel,
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
    key: "onOrder",
    header: "Beställt",
    numeric: true,
    hideOnMobile: true,
    sortValue: (r) => r.onOrderCounted + r.onOrderLater,
    render: (r) => formatInt(r.onOrderCounted + r.onOrderLater),
  },
  {
    key: "cover",
    header: "Räcker",
    numeric: true,
    sortValue: (r) => r.coverDays ?? 100_000,
    render: (r) => coverText(r.coverDays),
    csv: (r) => r.coverDays,
  },
  {
    key: "lead",
    header: "Ledtid",
    numeric: true,
    hideOnMobile: true,
    sortValue: (r) => r.leadTimeDays,
    render: (r) => (
      <span className={r.leadTimeSource === "default" ? "text-subtle" : undefined}>
        {r.leadTimeDays} d
      </span>
    ),
    csv: (r) => r.leadTimeDays,
  },
  {
    key: "evidence",
    header: "Underlag",
    hideable: false,
    render: (r) => <EvidenceButton evidence={r.evidence} title={r.title} text={r.text} />,
  },
];

/** Inköpsförslaget per leverantör och läget för alla titlar. */
export function PlanView({
  model,
  suppliers,
  canEdit,
  today,
}: {
  model: PlanModel;
  suppliers: readonly SupplierView[];
  canEdit: boolean;
  today: string;
}) {
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [open, setOpen] = useState(false);
  const hasSupplier = suppliers.some((s) => !s.archived);
  const others = useMemo(() => model.lines.filter((l) => l.status !== "no-demand"), [model.lines]);

  const openDraft = (d: OrderDraft | null) => {
    setDraft(d);
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-12">
      {model.proposals.length === 0 ? (
        <StateMessage
          kind="empty"
          code="0 förslag"
          message={
            model.counts["no-supplier"] > 0
              ? "Inget kan föreslås: titlarna som behöver beställas saknar leverantör."
              : "Inget behöver beställas: lagret och det som redan är beställt räcker till nästa beställningstillfälle."
          }
          action={
            model.counts["no-supplier"] > 0 && canEdit
              ? { label: "Lägg till leverantör", href: "#leverantorer" }
              : canEdit && hasSupplier
                ? { label: "Ny inköpsorder", onClick: () => openDraft(null) }
                : undefined
          }
        />
      ) : (
        model.proposals.map((p) => (
          <section
            key={p.supplierId}
            aria-label={`Förslag till ${p.supplierName}`}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="label text-subtle">Förslag · {p.supplierName}</p>
                <p className="text-md text-fg">
                  {formatInt(p.totalPacks)} pack för {kr(p.totalOre)}, leverans{" "}
                  {dateText(p.expectedArrival)} om beställt i dag.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <EvidenceButton evidence={p.evidence} title={p.supplierName} text={p.text} />
                {canEdit ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      openDraft({
                        supplierId: p.supplierId,
                        quantities: Object.fromEntries(p.lines.map((l) => [l.titleId, l.orderQty])),
                        expectedOn: p.expectedArrival,
                      })
                    }
                  >
                    Skapa inköpsorder
                  </Button>
                ) : null}
              </div>
            </div>
            <DataTable
              columns={proposalColumns}
              rows={p.lines}
              rowKey={(r) => r.titleId}
              caption={`Föreslagna rader till ${p.supplierName}`}
              defaultSort={{ key: "value", dir: "desc" }}
              isFlagged={(r) => r.late}
              dense
            />
          </section>
        ))
      )}

      {others.length > 0 ? (
        <section aria-labelledby="alla-titlar" className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-1">
              <h3 id="alla-titlar" className="label text-subtle">
                Alla titlar som säljer · {others.length}
              </h3>
              <p className="text-md text-fg">
                {formatInt(model.counts.ok)} räcker, {formatInt(model.counts.order)} att beställa
                {model.counts["no-supplier"] > 0
                  ? `, ${formatInt(model.counts["no-supplier"])} utan leverantör`
                  : ""}
                .
              </p>
            </div>
            {canEdit && hasSupplier && model.proposals.length > 0 ? (
              <Button variant="secondary" size="sm" iconLeft="plus" onClick={() => openDraft(null)}>
                Ny inköpsorder
              </Button>
            ) : null}
          </div>
          <DataTable
            columns={allColumns}
            rows={others}
            rowKey={(r) => r.titleId}
            caption="Lagerposition och täckning per titel"
            defaultSort={{ key: "cover", dir: "asc" }}
            dense
            exportFileName={`inkopsplan-${today}`}
          />
        </section>
      ) : null}

      {canEdit && open ? (
        <CreateOrderDialog
          open={open}
          onClose={() => setOpen(false)}
          suppliers={suppliers}
          draft={draft}
          today={today}
        />
      ) : null}
    </div>
  );
}
