"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

import { Sheet } from "@/app/(app)/lager/_components/sheet";
import { Icon } from "@/components/ui/icon";
import { useSubmitIds } from "@/lib/hooks/use-submit-ids";
import { useToast } from "@/components/ui/toast";
import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";

import { MAX_PACKS } from "../lager/_lib/schemas";
import { addReceipt, setHomeCount } from "../vart-lager/actions";
import { ReceiptPriceNote, useReceiptPrice } from "../vart-lager/_components/receipt-price";
import { parsePackCount, type StockBadge } from "./model";

export interface StockListRow {
  readonly titleId: string;
  readonly name: string;
  /** Pack i alla egna lager tillsammans. */
  readonly home: number;
  /** Pack per lager (lagrets id → pack). */
  readonly byPlace: Readonly<Record<string, number>>;
  readonly inMachines: number;
  readonly sold7: number;
  readonly lastsDays: number | null;
  readonly badge: StockBadge;
  /** Dagens inköpspris (öre), eller null. Förifylls i leveransformuläret. */
  readonly unitCostOre?: number | null;
  /** Egen produkt (mystery pack): packas, så leveransen frågar inte efter pris. */
  readonly own?: boolean;
}

export interface StockPlace {
  readonly id: string;
  readonly name: string;
}

/** Stora knappar och fält: tummen vid lagerhyllan. */
const BIG_BUTTON =
  "flex min-h-12 w-full items-center justify-center gap-2 rounded-md border px-4 text-lg font-medium disabled:border-dashed disabled:text-disabled";
const FIELD =
  "tnum h-12 w-full min-w-0 rounded-md border border-line-control bg-bg px-3 text-right text-xl text-fg";

/** Lagret per titel, med "Ändra" (leverans in eller rätta antalet). */
export function StockList({
  rows,
  places,
  canEdit,
}: {
  rows: readonly StockListRow[];
  places: readonly StockPlace[];
  canEdit: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState<StockListRow | null>(null);
  // Det nyss sparade antalet per titel och lager, tills sidans nya data har kommit
  // (router.refresh): raden och arket visar det direkt.
  const [saved, setSaved] = useState<Record<string, Record<string, number>>>({});
  const [seen, setSeen] = useState(rows);
  if (seen !== rows) {
    setSeen(rows);
    setSaved({});
  }
  const shown = rows.map((r) => withSaved(r, saved[r.titleId], places));
  return (
    <>
      <ul
        aria-label={t.stock.title}
        className="flex flex-col divide-y divide-line rounded-md border border-line"
      >
        {shown.map((r) => (
          <li key={r.titleId} className="flex flex-col gap-2 px-4 py-3">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-base font-medium [overflow-wrap:anywhere] text-fg">
                {r.name}
              </span>
              <span
                className={cn(
                  "tnum shrink-0 text-2xl font-medium",
                  r.home < 0 ? "text-signal-fg" : "text-fg",
                )}
              >
                {t.common.int(r.home)}
              </span>
            </span>
            <span className="tnum text-sm [overflow-wrap:anywhere] text-muted">
              {[
                ...(places.length > 1
                  ? places.map((p) => t.stock.placeLine(p.name, r.byPlace[p.id] ?? 0))
                  : []),
                t.stock.inMachines(r.inMachines),
                ...(r.sold7 > 0 ? [t.stock.soldWeek(r.sold7)] : []),
                ...(r.lastsDays !== null ? [t.stock.lasts(r.lastsDays)] : []),
              ].join(" · ")}
            </span>
            {r.badge || canEdit ? (
              <span className="flex items-center justify-between gap-3">
                <Badge badge={r.badge} />
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setOpen(r)}
                    aria-label={t.stock.updateAria(r.name)}
                    className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg active:bg-hover"
                  >
                    <Icon name="plus" size={16} />
                    {t.stock.update}
                  </button>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <StockSheet
          row={open}
          places={places}
          onClose={() => setOpen(null)}
          onSaved={(titleId, placeId, onHand) =>
            setSaved((prev) => ({
              ...prev,
              [titleId]: { ...prev[titleId], [placeId ?? ""]: onHand },
            }))
          }
        />
      ) : null}
    </>
  );
}

function Badge({ badge }: { badge: StockBadge }) {
  const t = useT();
  if (!badge) return <span />;
  const text = badge === "count" ? t.stock.countAgain : badge === "out" ? t.stock.out : t.stock.low;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-medium",
        badge === "low" ? "text-fg" : "text-signal-fg",
      )}
    >
      <Icon name="alert" size={14} />
      {text}
    </span>
  );
}

/** Raden med nyss sparade antal (lagrets id → pack; "" = utan lagerval). */
function withSaved(
  r: StockListRow,
  saved: Record<string, number> | undefined,
  places: readonly StockPlace[],
): StockListRow {
  if (!saved) return r;
  if (places.length === 0) return { ...r, home: saved[""] ?? r.home };
  const byPlace = { ...r.byPlace };
  for (const [id, n] of Object.entries(saved)) if (id) byPlace[id] = n;
  return { ...r, byPlace, home: places.reduce((sum, p) => sum + (byPlace[p.id] ?? 0), 0) };
}

/** Arket för en titel: välj lager, sedan leverans in eller rätta antalet. */
function StockSheet({
  row,
  places,
  onClose,
  onSaved,
}: {
  row: StockListRow | null;
  places: readonly StockPlace[];
  onClose: () => void;
  onSaved: (titleId: string, placeId: string | null, onHand: number) => void;
}) {
  const t = useT();
  return (
    <Sheet
      open={row !== null}
      onClose={onClose}
      title={row?.name ?? ""}
      eyebrow={t.stock.sheetEyebrow}
      closeLabel={t.common.close}
    >
      {row ? (
        <StockForms
          key={row.titleId}
          row={row}
          places={places}
          onDone={(placeId, onHand) => {
            onSaved(row.titleId, placeId, onHand);
            onClose();
          }}
        />
      ) : null}
    </Sheet>
  );
}

function StockForms({
  row,
  places,
  onDone,
}: {
  row: StockListRow;
  places: readonly StockPlace[];
  /** Efter en lyckad sparning: lagret och dess nya antal. */
  onDone: (placeId: string | null, onHand: number) => void;
}) {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const [placeId, setPlaceId] = useState<string | null>(places[0]?.id ?? null);
  const place = places.find((p) => p.id === placeId) ?? places[0] ?? null;
  const current = place ? (row.byPlace[place.id] ?? 0) : row.home;
  const [delivery, setDelivery] = useState("");
  const [count, setCount] = useState(String(Math.max(0, current)));
  const [deliveryError, setDeliveryError] = useState<string>();
  const [countError, setCountError] = useState<string>();
  const [busy, setBusy] = useState<"add" | "count" | null>(null);
  const [pending, start] = useTransition();
  const placeName = place?.name ?? t.common.homeFallback;
  const r2 = t.r2.t3;
  const f = useFormat();
  // Leveransen frågar vad packen kostade (förifyllt med dagens pris); inte för egna produkter.
  const price = useReceiptPrice(row.unitCostOre ?? null, row.own !== true);
  const submitIds = useSubmitIds();

  const fail = (error: string | undefined) =>
    toast({
      title: t.stock.notSaved,
      description: t.serverError(error ?? ""),
      tone: "critical",
    });

  const add = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parsePackCount(delivery, 1);
    if (!parsed.ok) {
      setDeliveryError(parsed.error === "max" ? t.stock.qtyMax(MAX_PACKS) : t.stock.qtyMin1);
      return;
    }
    if (price.state.kind === "invalid") return;
    setDeliveryError(undefined);
    setBusy("add");
    // Med frågan framme (konstigt pris) är knappen "Ja, spara ändå".
    const confirmed = price.doubt !== null;
    start(async () => {
      const res = await addReceipt({
        titleId: row.titleId,
        ...(place ? { warehouseId: place.id } : {}),
        quantity: parsed.n,
        ...(price.ore === undefined ? {} : { unitCostOre: price.ore, confirmed }),
        // Samma id tills svaret kommit: ett nytt försök lägger aldrig in packen igen.
        clientId: submitIds.idFor(`${parsed.n}|${place?.id ?? ""}`),
      }).catch(() => ({ ok: false as const, error: t.common.offlineRetry }));
      setBusy(null);
      if ("doubt" in res) {
        price.setDoubt(res.doubt);
        return;
      }
      if (!res.ok) return fail(res.error);
      submitIds.done();
      const p = res.data.price;
      const kr = (ore: number) => (ore % 100 === 0 ? f.sek(ore / 100) : f.kronor(ore / 100));
      const notes = [
        p.status === "saved" && p.unitCostOre !== undefined
          ? r2.receiptPriceSaved(kr(p.unitCostOre))
          : null,
        // En del räknades av från det som var beställt: säg vad som fortfarande väntas.
        (res.data.stillOnTheWay ?? 0) > 0 ? r2.stillOnWay(res.data.stillOnTheWay!) : null,
      ].filter((x): x is string => x !== null);
      toast({
        title: t.stock.added(parsed.n, placeName),
        ...(notes.length > 0 ? { description: notes.join(" ") } : {}),
        tone: "ok",
      });
      // Packen är sparade men priset gick inte att spara: säg det tydligt.
      if (p.status === "failed") {
        toast({
          title: r2.receiptPriceFailedTitle,
          description: r2.receiptPriceFailed(t.serverError(p.error ?? "")),
          tone: "critical",
          duration: 12_000,
        });
      }
      router.refresh();
      onDone(place?.id ?? null, res.data.onHand);
    });
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parsePackCount(count, 0);
    if (!parsed.ok) {
      setCountError(parsed.error === "max" ? t.stock.qtyMax(MAX_PACKS) : t.stock.qtyMin0);
      return;
    }
    setCountError(undefined);
    setBusy("count");
    start(async () => {
      const res = await setHomeCount({
        titleId: row.titleId,
        ...(place ? { warehouseId: place.id } : {}),
        counted: parsed.n,
      }).catch(() => ({ ok: false as const, error: t.common.offlineRetry }));
      setBusy(null);
      if (!res.ok) return fail(res.error);
      toast({ title: t.stock.counted(parsed.n, placeName), tone: "ok" });
      router.refresh();
      onDone(place?.id ?? null, res.data.onHand);
    });
  };

  return (
    <div className="flex flex-col gap-6 px-5 pb-5">
      {places.length > 1 ? (
        <section className="flex flex-col gap-2">
          <p id={`${ids}-place`} className="label text-subtle">
            {t.stock.placeLabel}
          </p>
          <div
            role="radiogroup"
            aria-labelledby={`${ids}-place`}
            className="grid grid-cols-2 gap-2"
          >
            {places.map((p) => {
              const on = p.id === place?.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setPlaceId(p.id);
                    setCount(String(Math.max(0, row.byPlace[p.id] ?? 0)));
                    setCountError(undefined);
                  }}
                  className={cn(
                    "flex min-h-12 min-w-0 flex-col items-center justify-center rounded-md border px-2 text-base font-medium [overflow-wrap:anywhere]",
                    on
                      ? "border-inverse bg-inverse text-on-inverse"
                      : "border-line-strong bg-surface text-fg active:bg-hover",
                  )}
                >
                  {t.stock.placeLine(p.name, row.byPlace[p.id] ?? 0)}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <form onSubmit={add} noValidate className="flex flex-col gap-2">
        <h3 className="text-lg font-medium text-fg">{t.stock.delivery}</h3>
        <p className="text-sm text-muted">{t.stock.deliveryHint}</p>
        <label htmlFor={`${ids}-add`} className="label text-subtle">
          {t.stock.packsLabel}
        </label>
        <div className="flex flex-col gap-2">
          <input
            id={`${ids}-add`}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            placeholder="0"
            value={delivery}
            onChange={(e) => {
              setDelivery(e.target.value);
              setDeliveryError(undefined);
            }}
            aria-invalid={deliveryError ? true : undefined}
            aria-describedby={deliveryError ? `${ids}-add-msg` : undefined}
            className={FIELD}
          />
          {row.own === true ? null : (
            <>
              <label htmlFor={`${ids}-price`} className="label text-subtle">
                {r2.receiptPriceLabel}
              </label>
              <div className="relative">
                <input
                  id={`${ids}-price`}
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
                titleId={row.titleId}
                currentOre={row.unitCostOre ?? null}
                price={price}
                className="text-base"
              />
            </>
          )}
          <button
            type="submit"
            disabled={pending}
            className={cn(
              BIG_BUTTON,
              "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
            )}
          >
            {price.doubt ? null : <Icon name="plus" size={18} />}
            {busy === "add" ? t.common.saving : price.doubt ? r2.priceSaveAnyway : t.stock.add}
          </button>
        </div>
        {deliveryError ? (
          <p id={`${ids}-add-msg`} role="alert" className="text-sm text-signal-fg">
            {deliveryError}
          </p>
        ) : null}
      </form>

      <form onSubmit={save} noValidate className="flex flex-col gap-2 border-t border-line pt-5">
        <h3 className="text-lg font-medium text-fg">{t.stock.count}</h3>
        <p className="text-sm text-muted">{t.stock.countHint}</p>
        <label htmlFor={`${ids}-count`} className="label text-subtle">
          {t.stock.countIn(placeName)}
        </label>
        <div className="flex flex-col gap-2">
          <input
            id={`${ids}-count`}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={count}
            onChange={(e) => {
              setCount(e.target.value);
              setCountError(undefined);
            }}
            aria-invalid={countError ? true : undefined}
            aria-describedby={countError ? `${ids}-count-msg` : undefined}
            className={FIELD}
          />
          <button
            type="submit"
            disabled={pending}
            className={cn(BIG_BUTTON, "border-line-strong bg-surface text-fg active:bg-hover")}
          >
            <Icon name="check" size={18} />
            {busy === "count" ? t.common.saving : t.stock.saveCount}
          </button>
        </div>
        {countError ? (
          <p id={`${ids}-count-msg`} role="alert" className="text-sm text-signal-fg">
            {countError}
          </p>
        ) : null}
      </form>
    </div>
  );
}
