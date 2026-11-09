"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

import { Sheet } from "@/app/(app)/lager/_components/sheet";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";

import { addPurchasePrice, correctPurchasePrice } from "../inkopspriser/actions";
import { parsePrice, type PriceRow } from "./model";

const day = (iso: string) => new Date(`${iso}T12:00:00`);

/** Produkterna med dagens inköpspris och "Ändra" (ägare och admin). */
export function PriceList({
  rows,
  canEdit,
  today,
}: {
  rows: readonly PriceRow[];
  canEdit: boolean;
  today: string;
}) {
  const t = useT();
  const f = useFormat();
  const [open, setOpen] = useState<PriceRow | null>(null);
  return (
    <>
      <ul
        aria-label={t.stock.pricesTitle}
        className="flex flex-col divide-y divide-line rounded-md border border-line"
      >
        {rows.map((r) => (
          <li key={r.titleId} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-base font-medium [overflow-wrap:anywhere] text-fg">
                {r.name}
              </span>
              {r.unitCostOre !== null ? (
                <span className="tnum text-base text-fg">
                  {t.stock.perPack(f.kronor(r.unitCostOre / 100))}
                  {r.validFrom ? (
                    <span className="text-sm text-muted">
                      {` · ${t.stock.since(f.date(day(r.validFrom), { year: "auto", now: day(today) }))}`}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-base font-medium text-signal-fg">
                  <Icon name="alert" size={14} />
                  {t.stock.missingPrice}
                </span>
              )}
              {r.own ? <span className="text-sm text-muted">{t.stock.ownProduct}</span> : null}
            </span>
            {canEdit ? (
              <button
                type="button"
                onClick={() => setOpen(r)}
                aria-label={t.stock.editAria(r.name)}
                className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg active:bg-hover"
              >
                {t.stock.edit}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <Sheet
          open={open !== null}
          onClose={() => setOpen(null)}
          title={open?.name ?? ""}
          eyebrow={t.stock.priceEyebrow}
          closeLabel={t.common.close}
        >
          {open ? (
            <PriceForm key={open.titleId} row={open} today={today} onDone={() => setOpen(null)} />
          ) : null}
        </Sheet>
      ) : null}
    </>
  );
}

/** Nytt pris med ägarens två val: Rätta priset (all försäljning) eller från i dag. */
function PriceForm({
  row,
  today,
  onDone,
}: {
  row: PriceRow;
  /** Dagens affärsdatum i organisationens tidszon (från servern), som Inköpspriser. */
  today: string;
  onDone: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const router = useRouter();
  const toast = useToast();
  const id = useId();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"fix" | "today" | null>(null);
  const [pending, start] = useTransition();

  const read = (): number | null => {
    const p = parsePrice(amount);
    if (p.ok) {
      setError(undefined);
      return p.ore;
    }
    setError(
      p.error === "required"
        ? t.stock.priceRequired
        : p.error === "tooHigh"
          ? t.stock.priceTooHigh
          : t.stock.priceInvalid,
    );
    return null;
  };

  const save = (kind: "fix" | "today") => {
    const ore = read();
    if (ore === null) return;
    setBusy(kind);
    start(async () => {
      const offline = { ok: false as const, error: t.common.offlineRetry };
      const res =
        kind === "fix"
          ? await correctPurchasePrice({ titleId: row.titleId, unitCostOre: ore }).catch(
              () => offline,
            )
          : await addPurchasePrice({
              titleId: row.titleId,
              unitCostOre: ore,
              validFrom: today,
            }).catch(() => offline);
      setBusy(null);
      if (!res.ok) {
        setError(t.serverError(res.error ?? ""));
        return;
      }
      toast({
        title: kind === "fix" ? t.stock.fixedToast : t.stock.savedToast,
        description: t.stock.priceLine(row.name, f.kronor(ore / 100)),
        tone: "ok",
      });
      router.refresh();
      onDone();
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pending) save("fix");
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 px-5 pb-5">
      <p className="text-base text-muted">
        {row.unitCostOre !== null
          ? t.stock.nowPrice(f.kronor(row.unitCostOre / 100))
          : t.stock.nowMissing}
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-price`} className="label text-subtle">
          {t.stock.newPrice}
        </label>
        <div className="relative">
          <input
            id={`${id}-price`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(undefined);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-msg` : undefined}
            className="tnum h-12 w-full min-w-0 rounded-md border border-line-control bg-bg pr-12 pl-3 text-right text-xl text-fg"
          />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-base text-subtle">
            kr
          </span>
        </div>
        {error ? (
          <p id={`${id}-msg`} role="alert" className="text-sm text-signal-fg">
            {error}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={pending}
        className={cn(
          "flex min-h-14 w-full flex-col items-start justify-center gap-0.5 rounded-md border px-4 py-2 text-left disabled:border-dashed disabled:text-disabled",
          "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
        )}
      >
        <span className="text-lg font-medium">
          {busy === "fix" ? t.common.saving : t.stock.fixAll}
        </span>
        <span className="text-sm opacity-80">{t.stock.fixAllSub}</span>
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => save("today")}
        className="flex min-h-14 w-full flex-col items-start justify-center gap-0.5 rounded-md border border-line-strong bg-surface px-4 py-2 text-left text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
      >
        <span className="text-lg font-medium">
          {busy === "today" ? t.common.saving : t.stock.fromToday}
        </span>
        <span className="text-sm text-muted">{t.stock.fromTodaySub}</span>
      </button>
    </form>
  );
}
