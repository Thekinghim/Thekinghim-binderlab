"use client";

/**
 * "Beställt", "Köpt, har dem här" och "Kom fram" direkt på inköpslistan, utan
 * leverantörsregister. Delas av Inköp i hela appen (svenska) och delägarens inköpslista i
 * den enkla vyn (hans språk): texterna kommer från @/i18n (r2.t3).
 *
 * - "Beställt": antalet är förifyllt, packen väntas om ca 7 dagar och listan slutar fråga.
 * - "Köpt, har dem här" och "Kom fram": samma ark som en leverans på Vårt lager, med antal,
 *   lager (senast använda förvalt) och pris per pack (förifyllt med dagens).
 * - "På väg: 36 st, väntas fredag" står kvar tills packen kommit.
 */

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

import { expectedWhen } from "@/analytics/purchasing/on-the-way";
import { PlaceButtons } from "@/components/stock/place-buttons";
import { pickPlace } from "@/components/stock/place-text";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import type { IsoDate } from "@/domain";
import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";
import { rememberKey, useRemembered } from "@/lib/remembered";

import { Sheet } from "../../lager/_components/sheet";
import { ReceiptPriceNote, useReceiptPrice } from "../../vart-lager/_components/receipt-price";
import { markArrived, markOrdered } from "../actions";

export interface BuyTarget {
  readonly titleId: string;
  readonly name: string;
  /** Planens antal, eller det som är på väg. null = okänt (fältet börjar tomt). */
  readonly qty: number | null;
  /** Dagens inköpspris (öre), eller null. */
  readonly unitCostOre: number | null;
}

export interface WayItem extends BuyTarget {
  readonly qty: number;
  readonly expectedOn: string;
  readonly late: boolean;
}

export interface BuyPlace {
  readonly id: string;
  readonly name: string;
}

const FIELD =
  "tnum h-12 w-full min-w-0 rounded-md border border-line-control bg-bg px-3 text-right text-xl text-fg";
const PRIMARY =
  "flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-inverse bg-inverse px-4 text-lg font-medium text-on-inverse active:bg-inverse-hover disabled:border-dashed disabled:text-disabled";
const SMALL =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg active:bg-hover";

function parseQty(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 10_000 ? n : null;
}

type Open = { kind: "ordered" | "arrived"; target: BuyTarget; planned: number | null };

interface Shared {
  readonly places: readonly BuyPlace[];
  /** Nyckel för "senast använda lager" (organisation + användare). */
  readonly scope: string;
}

/** Arken, delade av knapparna på en rad och "På väg"-listan. */
function useBuySheets({ places, scope }: Shared) {
  const [open, setOpen] = useState<Open | null>(null);
  const r2 = useT().r2.t3;
  const node = (
    <Sheet
      open={open !== null}
      onClose={() => setOpen(null)}
      title={open?.target.name ?? ""}
      eyebrow={open?.kind === "ordered" ? r2.ordered : r2.arrived}
      closeLabel={useT().common.close}
    >
      {open?.kind === "ordered" ? (
        <OrderedForm key={open.target.titleId} target={open.target} onDone={() => setOpen(null)} />
      ) : open ? (
        <ArrivedForm
          key={open.target.titleId}
          target={open.target}
          planned={open.planned}
          places={places}
          scope={scope}
          onDone={() => setOpen(null)}
        />
      ) : null}
    </Sheet>
  );
  return { setOpen, node };
}

/** De två knapparna på en rad i inköpslistan. */
export function BuyButtons({
  target,
  places,
  scope,
  className,
}: Shared & { target: BuyTarget; className?: string }) {
  const r2 = useT().r2.t3;
  const { setOpen, node } = useBuySheets({ places, scope });
  return (
    <>
      <span className={cn("flex flex-wrap gap-2", className)}>
        <button
          type="button"
          className={SMALL}
          aria-label={`${r2.ordered}, ${target.name}`}
          onClick={() => setOpen({ kind: "ordered", target, planned: target.qty })}
        >
          {r2.ordered}
        </button>
        <button
          type="button"
          className={SMALL}
          aria-label={`${r2.boughtHere}, ${target.name}`}
          onClick={() => setOpen({ kind: "arrived", target, planned: target.qty })}
        >
          {r2.boughtHere}
        </button>
      </span>
      {node}
    </>
  );
}

/** "På väg: 36 st, väntas fredag" med "Kom fram", en rad per titel. */
export function OnTheWayList({
  items,
  today,
  canEdit,
  places,
  scope,
}: Shared & { items: readonly WayItem[]; today: string; canEdit: boolean }) {
  const t = useT();
  const r2 = t.r2.t3;
  const f = useFormat();
  const { setOpen, node } = useBuySheets({ places, scope });
  const headingId = useId();
  if (items.length === 0) return null;
  const when = (item: WayItem) => {
    const w = expectedWhen(item.expectedOn as IsoDate, today as IsoDate);
    if (w.kind === "today") return r2.wayToday;
    if (w.kind === "weekday" && !item.late) return r2.weekdays[w.day - 1] ?? "";
    return f.date(new Date(`${item.expectedOn}T12:00:00`), {
      year: "auto",
      now: new Date(`${today}T12:00:00`),
    });
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="label text-subtle">
        {r2.wayTitle}
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {items.map((item) => (
          <li
            key={item.titleId}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-base font-medium [overflow-wrap:anywhere] text-fg">
                {item.name}
              </span>
              <span className={cn("tnum text-base", item.late ? "text-signal-fg" : "text-muted")}>
                {item.late
                  ? r2.wayLineLate(item.qty, when(item))
                  : r2.wayLine(item.qty, when(item))}
              </span>
            </span>
            {canEdit ? (
              <button
                type="button"
                className={SMALL}
                aria-label={`${r2.arrived}, ${item.name}`}
                onClick={() => setOpen({ kind: "arrived", target: item, planned: item.qty })}
              >
                <Icon name="check" size={16} className="mr-2" />
                {r2.arrived}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {node}
    </section>
  );
}

function QtyField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="label text-subtle">
        {t.stock.packsLabel}
      </label>
      <input
        id={id}
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-msg` : undefined}
        className={FIELD}
      />
      {error ? (
        <p id={`${id}-msg`} role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function OrderedForm({ target, onDone }: { target: BuyTarget; onDone: () => void }) {
  const t = useT();
  const r2 = t.r2.t3;
  const router = useRouter();
  const toast = useToast();
  const id = useId();
  const [qty, setQty] = useState(target.qty === null ? "" : String(target.qty));
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseQty(qty);
    if (n === null) {
      setError(t.stock.qtyMin1);
      return;
    }
    start(async () => {
      const res = await markOrdered({ titleId: target.titleId, quantity: n }).catch(() => ({
        ok: false as const,
        error: t.common.offlineRetry,
      }));
      if (!res.ok) {
        setError(t.serverError(res.error));
        return;
      }
      toast({ title: r2.orderedToast(n, target.name), tone: "ok" });
      router.refresh();
      onDone();
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 px-5 pb-5">
      <p className="text-base text-muted">{r2.orderedHint}</p>
      <QtyField
        id={`${id}-qty`}
        value={qty}
        onChange={(v) => {
          setQty(v);
          setError(undefined);
        }}
        error={error}
      />
      <button type="submit" disabled={pending} className={PRIMARY}>
        {pending ? t.common.saving : r2.orderedSave}
      </button>
    </form>
  );
}

function ArrivedForm({
  target,
  planned,
  places,
  scope,
  onDone,
}: Shared & { target: BuyTarget; planned: number | null; onDone: () => void }) {
  const t = useT();
  const r2 = t.r2.t3;
  const f = useFormat();
  const router = useRouter();
  const toast = useToast();
  const id = useId();
  const [qty, setQty] = useState(planned === null ? "" : String(planned));
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  // Samma minne som "+ Inköp" på Vårt lager: senast använda lager är förvalt.
  const [last, setLast] = useRemembered(rememberKey(scope, "inkop-lager"));
  const [chosen, setChosen] = useState<string | null>(null);
  const placeId = places.length > 1 ? pickPlace(places, chosen, undefined, last) : null;
  const price = useReceiptPrice(target.unitCostOre, true);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseQty(qty);
    if (n === null) {
      setError(t.stock.qtyMin1);
      return;
    }
    if (price.state.kind === "invalid") return;
    // Med frågan framme (konstigt pris) är knappen "Ja, spara ändå".
    const confirmed = price.doubt !== null;
    start(async () => {
      const res = await markArrived({
        titleId: target.titleId,
        quantity: n,
        ...(placeId ? { warehouseId: placeId } : {}),
        ...(price.ore === undefined ? {} : { unitCostOre: price.ore, confirmed }),
      }).catch(() => ({ ok: false as const, error: t.common.offlineRetry }));
      if ("doubt" in res) {
        price.setDoubt(res.doubt);
        return;
      }
      if (!res.ok) {
        setError(t.serverError(res.error));
        return;
      }
      if (placeId) setLast(placeId);
      const d = res.data;
      const kr = (ore: number) => (ore % 100 === 0 ? f.sek(ore / 100) : f.kronor(ore / 100));
      const notes = [
        // Färre än planerat: säg att listan ber om resten.
        planned !== null && n < planned ? r2.gotFewer(planned, n) : null,
        d.price.status === "saved" && d.price.unitCostOre !== undefined
          ? r2.receiptPriceSaved(kr(d.price.unitCostOre))
          : null,
      ].filter((x): x is string => x !== null);
      toast({
        title: t.stock.added(n, d.placeName ?? t.common.homeFallback),
        ...(notes.length > 0 ? { description: notes.join(" ") } : {}),
        tone: "ok",
        duration: notes.length > 0 ? 10_000 : undefined,
      });
      if (d.price.status === "failed") {
        toast({
          title: r2.receiptPriceFailedTitle,
          description: r2.receiptPriceFailed(t.serverError(d.price.error ?? "")),
          tone: "critical",
          duration: 12_000,
        });
      }
      router.refresh();
      onDone();
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 px-5 pb-5">
      <p className="text-base text-muted">{r2.arrivedHint}</p>
      <QtyField
        id={`${id}-qty`}
        value={qty}
        onChange={(v) => {
          setQty(v);
          setError(undefined);
        }}
        error={error}
      />
      {places.length > 1 ? (
        <PlaceButtons
          label={t.stock.placeLabel}
          places={places.map((p) => ({ id: p.id, name: p.name }))}
          value={placeId}
          onChange={setChosen}
        />
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-price`} className="label text-subtle">
          {r2.receiptPriceLabel}
        </label>
        <div className="relative">
          <input
            id={`${id}-price`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={price.text}
            onChange={(e) => price.setText(e.target.value)}
            aria-invalid={price.state.kind === "invalid" ? true : undefined}
            className={cn(FIELD, "pr-12")}
          />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-base text-subtle">
            kr
          </span>
        </div>
        <ReceiptPriceNote
          titleId={target.titleId}
          currentOre={target.unitCostOre}
          price={price}
          className="text-base"
        />
      </div>
      <button type="submit" disabled={pending} className={PRIMARY}>
        {pending ? t.common.saving : price.doubt ? r2.priceSaveAnyway : r2.arrivedSave}
      </button>
    </form>
  );
}
