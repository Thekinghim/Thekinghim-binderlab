"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt, MISSING } from "@/lib/format";

import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  markPurchaseOrderOrdered,
  receivePurchaseOrder,
} from "../actions";
import { dateText } from "../_lib/dates";
import type { PurchaseOrderView, PurchaseOrdersModel, SupplierView } from "../_lib/model";
import { kr, krExact, parseCount } from "../_lib/units";
import { CreateOrderDialog } from "./create-order-dialog";

type Dialog =
  | { kind: "receive"; order: PurchaseOrderView }
  | { kind: "order"; order: PurchaseOrderView }
  | { kind: "cancel"; order: PurchaseOrderView }
  | { kind: "lines"; order: PurchaseOrderView }
  | { kind: "close"; order: PurchaseOrderView }
  | { kind: "new" }
  | null;

/** Inköpsorder: öppna (med åtgärder) och avslutade. */
export function OrdersView({
  model,
  suppliers,
  canEdit,
  today,
  hasCentralWarehouse,
}: {
  model: PurchaseOrdersModel;
  suppliers: readonly SupplierView[];
  canEdit: boolean;
  today: string;
  hasCentralWarehouse: boolean;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  // Dialogerna monteras bara när de är öppna. Knappen som öppnade dialogen får fokus
  // tillbaka när den stängs (annars hamnar fokus på body); finns raden inte längre
  // (t.ex. efter avbruten order) stannar fokus där webbläsaren lägger det.
  const returnTo = useRef<HTMLElement | null>(null);
  const openDialog = useCallback((d: Dialog) => {
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(d);
  }, []);
  const closeDialog = useCallback(() => {
    setDialog(null);
    const el = returnTo.current;
    window.requestAnimationFrame(() => {
      if (el?.isConnected) el.focus();
    });
  }, []);
  const [showClosed, setShowClosed] = useState(false);
  const hasSupplier = suppliers.some((s) => !s.archived);

  const columns = useMemo<Column<PurchaseOrderView>[]>(
    () => [
      {
        key: "number",
        header: "Order",
        sortValue: (r) => r.createdAt,
        render: (r) => (
          <span className="flex min-w-0 flex-col">
            <span className="font-mono text-sm text-fg">{r.number}</span>
            <span className="text-xs text-subtle">{r.supplierName}</span>
            {/* Under md står läget och leveransdagen här; kolumnerna är dolda (design.md §5.1). */}
            <span className="tnum text-xs text-subtle md:hidden">
              {r.receivedOn
                ? `Mottagen ${dateText(r.receivedOn)}`
                : `Väntas ${dateText(r.expectedOn)}`}
            </span>
            <span className="mt-1 md:hidden">
              <StatusTag status={r.tone}>{r.statusLabel}</StatusTag>
            </span>
          </span>
        ),
        csv: (r) => `${r.number} ${r.supplierName}`,
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
        key: "ordered",
        header: "Beställd",
        hideOnMobile: true,
        sortValue: (r) => r.orderedOn ?? "",
        render: (r) => <span className="tnum">{dateText(r.orderedOn)}</span>,
        csv: (r) => r.orderedOn,
      },
      {
        key: "expected",
        header: "Väntas",
        hideOnMobile: true,
        sortValue: (r) => r.expectedOn ?? "9999",
        render: (r) => (
          <span className="tnum">
            {r.receivedOn ? `Mottagen ${dateText(r.receivedOn)}` : dateText(r.expectedOn)}
          </span>
        ),
        csv: (r) => r.receivedOn ?? r.expectedOn,
      },
      {
        key: "packs",
        header: "Mottaget",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.totalPacks,
        render: (r) => `${formatInt(r.receivedPacks)} av ${formatInt(r.totalPacks)}`,
        csv: (r) => `${r.receivedPacks}/${r.totalPacks}`,
      },
      {
        key: "value",
        header: "Värde",
        numeric: true,
        sortValue: (r) => r.totalOre,
        render: (r) => kr(r.totalOre),
        csv: (r) => r.totalOre / 100,
      },
      {
        key: "actions",
        header: "Åtgärd",
        hideable: false,
        render: (r) => (
          <span className="flex flex-wrap justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openDialog({ kind: "lines", order: r })}
              aria-label={`Rader i ${r.number}`}
            >
              Rader
            </Button>
            {canEdit && r.status === "draft" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openDialog({ kind: "order", order: r })}
              >
                Beställ
              </Button>
            ) : null}
            {canEdit && (r.status === "ordered" || r.status === "partially_received") ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openDialog({ kind: "receive", order: r })}
                disabled={!hasCentralWarehouse}
              >
                Ta emot
              </Button>
            ) : null}
            {canEdit && r.status === "partially_received" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openDialog({ kind: "close", order: r })}
                aria-label={`Avsluta ${r.number} med restorder`}
              >
                Avsluta
              </Button>
            ) : null}
            {canEdit && (r.status === "draft" || r.status === "ordered") ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openDialog({ kind: "cancel", order: r })}
                aria-label={`Avbryt ${r.number}`}
              >
                Avbryt
              </Button>
            ) : null}
          </span>
        ),
      },
    ],
    [canEdit, hasCentralWarehouse, openDialog],
  );

  return (
    <div className="flex flex-col gap-6">
      {canEdit && hasSupplier ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            iconLeft="plus"
            onClick={() => openDialog({ kind: "new" })}
          >
            Ny inköpsorder
          </Button>
        </div>
      ) : null}
      {model.open.length === 0 ? (
        <StateMessage
          kind="empty"
          message={
            model.closed.length === 0
              ? hasSupplier
                ? "Ingen inköpsorder är skapad. Skapa en från förslaget ovan eller med Ny inköpsorder."
                : "Ingen inköpsorder är skapad. Lägg till en leverantör med artiklar först."
              : "Alla inköpsorder är mottagna eller avbrutna."
          }
          compact
        />
      ) : (
        <DataTable
          surface="bg"
          columns={columns}
          rows={model.open}
          rowKey={(r) => r.id}
          caption="Öppna inköpsorder"
          defaultSort={{ key: "expected", dir: "asc" }}
          isFlagged={(r) => r.overdue}
          dense
        />
      )}
      {!hasCentralWarehouse ? (
        <p className="text-sm text-muted">
          Organisationen saknar centrallager, så leveranser kan inte tas emot.
        </p>
      ) : null}

      {model.closed.length > 0 ? (
        <div className="flex flex-col gap-4">
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowClosed((v) => !v)}
              aria-expanded={showClosed}
            >
              {showClosed ? "Dölj" : "Visa"} {model.closed.length} avslutade
            </Button>
          </div>
          {showClosed ? (
            <DataTable
              surface="bg"
              columns={columns}
              rows={model.closed}
              rowKey={(r) => r.id}
              caption="Mottagna och avbrutna inköpsorder"
              defaultSort={{ key: "number", dir: "desc" }}
              dense
              exportFileName={`inkopsorder-${today}`}
            />
          ) : null}
        </div>
      ) : null}

      {dialog?.kind === "receive" ? (
        <ReceiveDialog order={dialog.order} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === "order" ? (
        <MarkOrderedDialog order={dialog.order} today={today} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === "cancel" ? (
        <CancelDialog order={dialog.order} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === "lines" ? <LinesDialog order={dialog.order} onClose={closeDialog} /> : null}
      {dialog?.kind === "close" ? <CloseDialog order={dialog.order} onClose={closeDialog} /> : null}
      {canEdit && dialog?.kind === "new" ? (
        <CreateOrderDialog
          open
          onClose={closeDialog}
          suppliers={suppliers}
          draft={null}
          today={today}
        />
      ) : null}
    </div>
  );
}

function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-signal-fg">
      {message}
    </p>
  ) : null;
}

function LinesDialog({ order, onClose }: { order: PurchaseOrderView; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${order.number} · ${order.supplierName}`}
      title={`${order.statusLabel}, ${formatInt(order.totalPacks)} pack för ${kr(order.totalOre)}.`}
      description={order.note ?? undefined}
    >
      <table className="w-full text-sm">
        <caption className="sr-only">Rader i {order.number}</caption>
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="label py-2 text-left font-normal text-subtle">
              Titel
            </th>
            <th scope="col" className="label py-2 text-right font-normal text-subtle">
              Antal
            </th>
            <th scope="col" className="label py-2 text-right font-normal text-subtle">
              Mottaget
            </th>
            <th scope="col" className="label py-2 text-right font-normal text-subtle">
              Pris
            </th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.id} className="border-b border-line">
              <th scope="row" className="py-2 pr-2 text-left font-normal text-fg">
                {l.title}
              </th>
              <td className="tnum py-2 text-right">{formatInt(l.quantity)}</td>
              <td className="tnum py-2 text-right">{formatInt(l.receivedQuantity)}</td>
              <td className="tnum py-2 text-right">{krExact(l.unitCostOre)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-5 flex flex-col">
        {[
          ["Beställd", dateText(order.orderedOn)],
          ["Väntas", dateText(order.expectedOn)],
          ["Mottagen", order.receivedOn ? dateText(order.receivedOn) : MISSING],
        ].map(([k, v]) => (
          <div
            key={k}
            className="flex items-baseline justify-between border-t border-line py-1.5 last:border-b"
          >
            <dt className="label text-subtle">{k}</dt>
            <dd className="meta tnum text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

function ReceiveDialog({ order, onClose }: { order: PurchaseOrderView; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      order.lines.map((l) => [l.id, String(Math.max(0, l.quantity - l.receivedQuantity))]),
    ),
  );
  const parsed = order.lines.map((l) => {
    const outstanding = l.quantity - l.receivedQuantity;
    const raw = qty[l.id] ?? "";
    const n = raw.trim() === "" ? 0 : parseCount(raw);
    const err = n === null ? "Hela pack" : n > outstanding ? `Högst ${outstanding}` : undefined;
    return { line: l, outstanding, n, err };
  });
  const total = parsed.reduce((s, p) => s + (p.n ?? 0), 0);
  const hasError = parsed.some((p) => p.err);

  const submit = () => {
    if (hasError) return setError("Rätta antalen först.");
    if (total === 0) return setError("Ange hur många pack som kom.");
    setError(null);
    start(async () => {
      const res = await receivePurchaseOrder({
        id: order.id,
        lines: parsed
          .filter((p) => p.outstanding > 0)
          .map((p) => ({ lineId: p.line.id, quantity: p.n ?? 0 })),
      });
      if (!res.ok) return setError(res.error);
      toast({
        title: res.data.status === "received" ? "Leverans mottagen" : "Delleverans mottagen",
        description: `${formatInt(res.data.received)} pack in i centrallagret.`,
        meta: order.number,
      });
      onClose();
      router.refresh();
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${order.number} · ${order.supplierName}`}
      title="Ta emot leverans"
      description="Antalen läggs in i centrallagret som inleverans."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Avbryt
          </Button>
          <Button variant="primary" onClick={submit} loading={pending}>
            {hasError || total === 0 ? "Ta emot" : `Ta emot ${formatInt(total)} pack`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col">
          {parsed.map((p) => (
            <li
              key={p.line.id}
              className="grid grid-cols-[1fr_7rem] items-center gap-3 border-t border-line py-2 last:border-b"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-fg">{p.line.title}</span>
                <span className="text-xs text-subtle">
                  {formatInt(p.line.receivedQuantity)} av {formatInt(p.line.quantity)} mottagna
                </span>
              </span>
              {p.outstanding > 0 ? (
                <Input
                  label={`Mottaget nu, ${p.line.title}`}
                  wrapperClassName="[&>label]:sr-only"
                  inputMode="numeric"
                  value={qty[p.line.id] ?? ""}
                  error={p.err}
                  suffix="st"
                  className="text-right"
                  onChange={(e) => setQty((cur) => ({ ...cur, [p.line.id]: e.target.value }))}
                />
              ) : (
                <span className="meta text-right text-subtle">Klar</span>
              )}
            </li>
          ))}
        </ul>
        <FormError message={error} />
      </div>
    </Modal>
  );
}

function MarkOrderedDialog({
  order,
  today,
  onClose,
}: {
  order: PurchaseOrderView;
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [expectedOn, setExpectedOn] = useState(order.expectedOn ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      const res = await markPurchaseOrderOrdered({ id: order.id, expectedOn: expectedOn || null });
      if (!res.ok) return setError(res.error);
      toast({ title: "Inköpsorder beställd", meta: order.number });
      onClose();
      router.refresh();
    });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      eyebrow={`${order.number} · ${order.supplierName}`}
      title="Markera som beställd i dag"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Avbryt
          </Button>
          <Button variant="primary" onClick={submit} loading={pending}>
            Beställ
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Väntad leverans"
          type="date"
          min={today}
          value={expectedOn}
          onChange={(e) => setExpectedOn(e.target.value)}
        />
        <FormError message={error} />
      </div>
    </Modal>
  );
}

function CancelDialog({ order, onClose }: { order: PurchaseOrderView; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      const res = await cancelPurchaseOrder({ id: order.id });
      if (!res.ok) return setError(res.error);
      toast({ title: "Inköpsorder avbruten", meta: order.number });
      onClose();
      router.refresh();
    });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      eyebrow={`${order.number} · ${order.supplierName}`}
      title={`Avbryt ordern på ${formatInt(order.totalPacks)} pack?`}
      description="Ordern finns kvar som avbruten och räknas inte längre som beställd."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Behåll
          </Button>
          <Button variant="danger-confirm" onClick={submit} loading={pending}>
            Avbryt ordern
          </Button>
        </>
      }
    >
      <FormError message={error} />
    </Modal>
  );
}

function CloseDialog({ order, onClose }: { order: PurchaseOrderView; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const missing = order.totalPacks - order.receivedPacks;
  const submit = () =>
    start(async () => {
      const res = await closePurchaseOrder({ id: order.id });
      if (!res.ok) return setError(res.error);
      toast({
        title: "Inköpsorder avslutad",
        description: `${formatInt(res.data.missing)} pack räknas inte längre som beställda.`,
        meta: order.number,
      });
      onClose();
      router.refresh();
    });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      eyebrow={`${order.number} · ${order.supplierName}`}
      title={`Avsluta med ${formatInt(missing)} pack i restorder?`}
      description={`${formatInt(order.receivedPacks)} av ${formatInt(order.totalPacks)} pack har kommit. Resten räknas inte längre som beställt, så inköpsförslaget tar med behovet igen. Det som kommit ligger kvar i lagret.`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Behåll öppen
          </Button>
          <Button variant="danger-confirm" onClick={submit} loading={pending}>
            Avsluta ordern
          </Button>
        </>
      }
    >
      <FormError message={error} />
    </Modal>
  );
}
