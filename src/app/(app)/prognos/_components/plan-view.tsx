"use client";

import { useMemo, useState } from "react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatInt, MISSING, NBSP } from "@/lib/format";

import { dateText } from "../_lib/dates";
import type { PlanLineView, PlanModel, SupplierView } from "../_lib/model";
import { kr, packsMilli } from "../_lib/units";
import { CreateOrderDialog, type OrderDraft } from "./create-order-dialog";
import { BuyButtons, type BuyPlace } from "./buy-actions";
import { EvidenceButton } from "./evidence-button";

/** Räcker (samma regel som Vårt lager): "12 dagar" · "–" utan takt. */
function coverText(days: number | null): string {
  if (days === null) return MISSING;
  return `${formatInt(days)} ${days === 1 ? "dag" : "dagar"}`;
}

/** Under titeln: leverantören, eller för egna produkter vad som ska packas. */
function sourceText(r: PlanLineView): string {
  if (r.own) return r.packQty > 0 ? (r.action?.text ?? "Packa") : "Egen produkt";
  return r.supplierName ?? "Ingen leverantör";
}

/** Under titeln: lite data och utkast som inte räknas som beställt. */
function LineNotes({ r }: { r: PlanLineView }) {
  const notes: string[] = [];
  if (r.lowData) {
    notes.push(
      `Lite data i ${formatInt(r.lowData.lowDataSeries)} av ${formatInt(r.lowData.series)} ${r.lowData.series === 1 ? "automat" : "automater"}`,
    );
  }
  if (r.drafts.length > 0) {
    notes.push(
      `I utkast ${r.drafts.map((d) => `${d.number} (${formatInt(d.quantity)})`).join(", ")}`,
    );
  }
  if (notes.length === 0 && !r.steps && !r.toMystery) return null;
  return (
    <>
      {/* En del i mystery packs: så många av packen som köps går dit. */}
      {r.toMystery ? <span className="text-xs text-muted">{r.toMystery.text}</span> : null}
      {/* Under 0 hemma: räkna om först (samma två steg som på Vårt lager). */}
      {r.steps ? <span className="text-xs font-medium text-signal-fg">{r.steps}</span> : null}
      {notes.length > 0 ? <span className="text-xs text-subtle">{notes.join(" · ")}</span> : null}
    </>
  );
}

function notesCsv(r: PlanLineView): string {
  const parts: string[] = [r.title];
  if (r.lowData) parts.push(`lite data ${r.lowData.lowDataSeries}/${r.lowData.series}`);
  if (r.drafts.length > 0) parts.push(`utkast ${r.drafts.map((d) => d.number).join(" ")}`);
  return parts.join(" · ");
}

const proposalColumns: Column<PlanLineView>[] = [
  {
    key: "title",
    header: "Titel",
    sortValue: (r) => r.title,
    render: (r) => (
      <span className="flex min-w-0 flex-col">
        <span className="text-fg">{r.title}</span>
        <LineNotes r={r} />
        {/* Under md står läget här; kolumnen Läge är dold (design.md §5.1, MachineCell). */}
        <span className="mt-1 md:hidden">
          <StatusTag status={r.tone}>{r.statusLabel}</StatusTag>
        </span>
      </span>
    ),
    csv: notesCsv,
  },
  {
    key: "status",
    header: "Läge",
    hideable: false,
    hideOnMobile: true,
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
        title={`Vårt lager ${r.warehouseOnHand}, automater ${r.machineOnHand}, beställt ${r.onOrderCounted}`}
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
    // Under md står förslagets summa i raden ovanför tabellen; beloppet klipps aldrig.
    hideOnMobile: true,
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
        <span className="text-xs text-subtle">{sourceText(r)}</span>
        <LineNotes r={r} />
        {/* Under md står läget här; kolumnen Läge är dold (design.md §5.1, MachineCell). */}
        <span className="mt-1 md:hidden">
          <StatusTag status={r.tone}>{r.statusLabel}</StatusTag>
        </span>
      </span>
    ),
    csv: notesCsv,
  },
  {
    key: "status",
    header: "Läge",
    hideable: false,
    hideOnMobile: true,
    sortValue: (r) => r.statusLabel,
    render: (r) => <StatusTag status={r.tone}>{r.statusLabel}</StatusTag>,
    csv: (r) => r.statusLabel,
  },
  {
    key: "warehouse",
    header: "Vårt lager",
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
    sortValue: (r) => r.lastsDays ?? 100_000,
    render: (r) => coverText(r.lastsDays),
    csv: (r) => r.lastsDays,
  },
  {
    key: "lead",
    header: "Ledtid",
    numeric: true,
    hideOnMobile: true,
    sortValue: (r) => r.leadTimeDays,
    // Egna produkter packar vi själva: ingen ledtid.
    render: (r) =>
      r.own ? (
        <span className="text-subtle">{MISSING}</span>
      ) : (
        <span className={r.leadTimeSource === "default" ? "text-subtle" : undefined}>
          {r.leadTimeDays} d
        </span>
      ),
    csv: (r) => (r.own ? null : r.leadTimeDays),
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
  places = [],
  scope = "",
}: {
  model: PlanModel;
  suppliers: readonly SupplierView[];
  canEdit: boolean;
  today: string;
  /** De egna lagren (för "Köpt, har dem här"). */
  places?: readonly BuyPlace[];
  /** Nyckel för senast använda lager (organisation + användare). */
  scope?: string;
}) {
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [open, setOpen] = useState(false);
  // Ny nyckel för varje öppning: formuläret börjar om från förslaget, medan dialogen
  // ligger kvar monterad vid stängning så att fokus går tillbaka till knappen.
  const [openCount, setOpenCount] = useState(0);
  const hasSupplier = suppliers.some((s) => !s.archived);
  const others = useMemo(() => model.lines.filter((l) => l.status !== "no-demand"), [model.lines]);

  const openDraft = (d: OrderDraft | null) => {
    setDraft(d);
    setOpenCount((n) => n + 1);
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-12">
      {model.noSupplierLines.length > 0 ? (
        // Förslaget visas även utan leverantör: hur många pack som behövs. Leverantören
        // (pris, boxar, ledtid) är nästa steg, inte ett krav för att se förslaget.
        <section aria-label="Att köpa in utan leverantör" className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {model.noSupplierLines.map((l, i) => (
              <li
                key={l.titleId}
                className="rise flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
                style={{ "--i": Math.min(i, 8) } as React.CSSProperties}
              >
                <span className="flex min-w-0 flex-1 basis-56 flex-col text-base text-fg">
                  <span>
                    Köp ca <span className="tnum font-medium">{formatInt(l.suggestQty)}</span>
                    {NBSP}st {l.title}
                  </span>
                  {l.toMystery ? (
                    <span className="tnum text-sm text-muted">{l.toMystery.text}</span>
                  ) : null}
                  {l.steps ? (
                    <span className="text-sm font-medium text-signal-fg">
                      1. Räkna om. 2. Köp ca {formatInt(l.suggestQty)}
                      {NBSP}st.
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {/* Beställt eller redan köpt: ett tryck, utan leverantörsregister. */}
                  {canEdit ? (
                    <BuyButtons
                      target={{
                        titleId: l.titleId,
                        name: l.title,
                        qty: l.suggestQty,
                        unitCostOre: l.priceOre,
                      }}
                      places={places}
                      scope={scope}
                    />
                  ) : null}
                  <EvidenceButton evidence={l.evidence} title={l.title} text={l.text} />
                </span>
              </li>
            ))}
          </ul>
          {canEdit ? (
            <div>
              <a
                href="#leverantorer"
                className="inline-flex h-11 items-center rounded-sm border border-line-control px-4 text-sm font-medium text-fg transition-colors duration-fast ease-instrument hover:bg-hover"
              >
                Lägg till leverantör
              </a>
              <span className="meta ml-3 text-subtle">för pris och boxar</span>
            </div>
          ) : null}
        </section>
      ) : null}
      {model.proposals.length === 0
        ? null
        : model.proposals.map((p) => (
            <section
              key={p.supplierId}
              aria-label={`Förslag till ${p.supplierName}`}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="label text-subtle">{p.supplierName}</p>
                  <p className="text-md text-fg">
                    {formatInt(p.totalPacks)} pack för {kr(p.totalOre)}, framme{" "}
                    {dateText(p.expectedArrival)}.
                  </p>
                  {p.drafts.length > 0 ? (
                    <p className="text-sm text-muted">
                      Utkast finns:{" "}
                      {p.drafts.map((d) => `${d.number} (${formatInt(d.packs)} pack)`).join(", ")}.{" "}
                      <a href="#inkopsorder" className="text-fg underline underline-offset-2">
                        Beställ det
                      </a>
                      .
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <EvidenceButton evidence={p.evidence} title={p.supplierName} text={p.text} />
                  {canEdit ? (
                    <Button
                      variant={p.drafts.length > 0 ? "secondary" : "primary"}
                      size="sm"
                      onClick={() =>
                        openDraft({
                          supplierId: p.supplierId,
                          quantities: Object.fromEntries(
                            p.lines.map((l) => [l.titleId, l.orderQty]),
                          ),
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
                surface="bg"
                columns={proposalColumns}
                rows={p.lines}
                rowKey={(r) => r.titleId}
                caption={`Föreslagna rader till ${p.supplierName}`}
                defaultSort={{ key: "value", dir: "desc" }}
                isFlagged={(r) => r.late}
                dense
              />
            </section>
          ))}

      {canEdit && hasSupplier ? (
        // Mobil: utan förslag står samma knapp under Inköpsorder; en räcker.
        <div className={cn(model.proposals.length === 0 && "max-md:hidden")}>
          <Button variant="secondary" size="sm" iconLeft="plus" onClick={() => openDraft(null)}>
            Ny inköpsorder
          </Button>
        </div>
      ) : null}

      {others.length > 0 ? (
        <details
          aria-labelledby="alla-titlar"
          className="group flex flex-col gap-4 rounded-sm border border-line"
        >
          <summary className="flex cursor-pointer items-baseline justify-between gap-4 px-4 py-3 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-0.5">
            <h3 id="alla-titlar" className="text-sm font-medium text-fg">
              Alla titlar ({formatInt(others.length)})
            </h3>
            <span className="meta text-muted">
              {formatInt(model.counts.ok)} räcker
              {model.counts.order > 0 ? ` · ${formatInt(model.counts.order)} beställ` : ""}
              {model.packLines.length > 0 ? ` · ${formatInt(model.packLines.length)} packa` : ""}
              {model.counts["no-supplier"] > 0
                ? ` · ${formatInt(model.counts["no-supplier"])} utan leverantör`
                : ""}
            </span>
          </summary>
          <div className="border-t border-line p-4">
            <DataTable
              surface="bg"
              columns={allColumns}
              rows={others}
              rowKey={(r) => r.titleId}
              caption="Lagerposition och täckning per titel"
              defaultSort={{ key: "cover", dir: "asc" }}
              dense
              exportFileName={`inkopsplan-${today}`}
            />
          </div>
        </details>
      ) : null}

      {canEdit && openCount > 0 ? (
        <CreateOrderDialog
          key={openCount}
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
