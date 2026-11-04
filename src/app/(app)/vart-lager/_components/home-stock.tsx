"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type React from "react";

import { PlaceButtons } from "@/components/stock/place-buttons";
import { inPlace, pickPlace } from "@/components/stock/place-text";
import { KpiStrip } from "@/components/ui/kpi-strip";
import { Icon } from "@/components/ui/icon";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, formatSek, MINUS, NBSP } from "@/lib/format";
import { rememberKey, useRemembered } from "@/lib/remembered";

import { Sheet } from "../../lager/_components/sheet";
import { addReceipt, moveStock, setHomeCount, undoMove } from "../actions";
import { lastsText, type Place, type VartLagerModel, type VartLagerRow } from "../_lib/model";
import { PlaceBar } from "./place-bar";

const GRID =
  "grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1 md:grid-cols-[minmax(0,1fr)_88px_80px_72px_132px_var(--act,auto)]";
/** Knappkolumnens bredd: samma på alla rader (Inköp/Packat, och Flytta med flera lager). */
const actWidth = (multi: boolean, canEdit: boolean) =>
  ({ "--act": canEdit ? (multi ? "184px" : "104px") : "0px" }) as React.CSSProperties;

/** Värdet "alla lager" i platsväljaren. */
const ALL = "alla";

function parseCount(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, "");
  if (!/^\d{1,5}$/.test(s)) return null;
  return Number(s);
}

const signedInt = (n: number) => (n < 0 ? `${MINUS}${formatInt(-n)}` : formatInt(n));

/**
 * Pack per titel i vårt lager, med uppräknade nyckeltal överst. Flera lager: raden
 * "Alla · Hemma · Kontoret" väljer vad som visas; antalet man skriver gäller valt lager
 * (med Alla valt frågar sidan "Vilket lager?"). Inköp frågar vilket lager packen kom
 * till (senaste valet minns), Flytta flyttar mellan lagren med Ångra.
 */
export function HomeStock({ model, scope }: { model: VartLagerModel; scope: string }) {
  const places = model.places;
  const multi = places.length > 1;
  const [stored, setStored] = useRemembered(rememberKey(scope, "vart-lager-vy"));
  // Valt lager i vyn (null = alla). Med ett lager: alltid det lagret.
  const selected =
    places.length === 1
      ? places[0]!.id
      : stored && stored !== ALL && places.some((p) => p.id === stored)
        ? stored
        : null;
  const place = selected ? (places.find((p) => p.id === selected) ?? null) : null;
  const [chooseFor, setChooseFor] = useState<VartLagerRow | null>(null);
  const [focusTitle, setFocusTitle] = useState<string | null>(null);
  const [moveRow, setMoveRow] = useState<VartLagerRow | null>(null);

  const t = model.totals;
  const countHeader = place && multi ? place.name : multi ? "Alla lager" : "Antal";
  const out = model.rows.filter((r) => r.runsOut && !r.negative);
  const packOnly = out.length > 0 && out.every((r) => r.own);

  return (
    <div className="flex flex-col gap-8">
      <div className="rise" style={{ "--i": 1 } as React.CSSProperties}>
        <KpiStrip
          ariaLabel="Vårt lager i siffror"
          items={[
            // Totalen står i sidans rubrik; här bara valt lager.
            ...(place && multi
              ? [
                  {
                    id: "home",
                    label: `Pack ${inPlace(place.name)}`,
                    value: t.byPlace[place.id] ?? 0,
                    format: formatInt,
                    primary: true,
                  },
                ]
              : []),
            {
              id: "value",
              label: "Värde, inköpspris",
              value: t.valueOre,
              format: (v) => formatSek(v / 100),
              ...(t.unpriced > 0 ? { note: `${formatInt(t.unpriced)} utan pris` } : {}),
            },
            {
              id: "out",
              label: `Tar slut inom ${formatInt(model.lowDays)} d`,
              value: t.runsOut,
              format: (v) => `${formatInt(v)}${NBSP}${v === 1 ? "titel" : "titlar"}`,
              ...(t.runsOut > 0 ? { alert: true, alertText: packOnly ? "Packa" : "Beställ" } : {}),
            },
            {
              id: "machines",
              label: "I automaterna",
              value: t.inMachines,
              format: formatInt,
            },
            // Titlar som gått ur automaterna men ligger hemma: pengar som står still.
            ...(t.idle.packs > 0
              ? [
                  {
                    id: "idle",
                    label: "Ligger still",
                    value: t.idle.packs,
                    format: (v: number) => `${formatInt(v)}${NBSP}pack`,
                    note: `${formatInt(t.idle.titles)}${NBSP}${t.idle.titles === 1 ? "titel utgår" : "titlar utgår"}${
                      t.idle.valueOre > 0 ? ` · ${formatSek(t.idle.valueOre / 100)}` : ""
                    }`,
                  },
                ]
              : []),
          ]}
        />
      </div>

      <PlaceBar
        places={places}
        totals={t.byPlace}
        selected={multi ? selected : null}
        onSelect={(id) => setStored(id ?? ALL)}
        canEdit={model.canEdit}
      />

      <div className="rise flex flex-col" style={{ "--i": 2 } as React.CSSProperties}>
        <div
          className={cn(GRID, "border-b border-line-strong pb-2")}
          style={actWidth(multi, model.canEdit)}
        >
          <span className="label text-subtle">Titel</span>
          <span className="label hidden text-right text-subtle md:block">I automater</span>
          <span className="label hidden text-right text-subtle md:block">Sålt 7 d</span>
          <span className="label hidden text-right text-subtle md:block">Räcker</span>
          <span className="label truncate text-right text-subtle">{countHeader}</span>
          <span aria-hidden />
        </div>
        <ul aria-label="Pack per titel">
          {model.rows.map((r, i) => (
            <StockRow
              key={r.titleId}
              row={r}
              index={i}
              canEdit={model.canEdit}
              places={places}
              place={place}
              scope={scope}
              focus={focusTitle === r.titleId && place !== null}
              onFocused={() => setFocusTitle(null)}
              onChoosePlace={() => setChooseFor(r)}
              onMove={() => setMoveRow(r)}
            />
          ))}
        </ul>
      </div>

      <Sheet
        open={chooseFor !== null}
        onClose={() => setChooseFor(null)}
        title="Vilket lager?"
        eyebrow={chooseFor?.name}
      >
        {chooseFor ? (
          <div className="flex flex-col gap-3 px-5 pb-5">
            <PlaceButtons
              label="Vilket lager?"
              places={places.map((p) => ({
                id: p.id,
                name: p.name,
                count: chooseFor.byPlace[p.id] ?? 0,
              }))}
              value={null}
              onChange={(id) => {
                setStored(id);
                setFocusTitle(chooseFor.titleId);
                setChooseFor(null);
              }}
            />
          </div>
        ) : null}
      </Sheet>

      {moveRow ? (
        <MoveSheet
          key={moveRow.titleId}
          row={moveRow}
          places={places}
          from={place?.id ?? null}
          onClose={() => setMoveRow(null)}
        />
      ) : null}
    </div>
  );
}

function StockRow({
  row,
  index,
  canEdit,
  places,
  place,
  scope,
  focus,
  onFocused,
  onChoosePlace,
  onMove,
}: {
  row: VartLagerRow;
  index: number;
  canEdit: boolean;
  places: readonly Place[];
  /** Valt lager, eller null för alla. */
  place: Place | null;
  scope: string;
  /** Sätt fokus på antalet (efter "Vilket lager?"). */
  focus: boolean;
  onFocused: () => void;
  onChoosePlace: () => void;
  onMove: () => void;
}) {
  const toast = useToast();
  const multi = places.length > 1;
  const count = place && multi ? (row.byPlace[place.id] ?? 0) : row.home;
  // Det man skriver, eller null: då visas antalet från servern (synken, ett inköp, en annan flik).
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(count);
  // Esc ångrar: blur som följer ska inte spara.
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(0);
  const [pending, start] = useTransition();
  const [buyOpen, setBuyOpen] = useState(false);
  const [buy, setBuy] = useState("");
  const buyRef = useRef<HTMLInputElement>(null);
  const [lastBuy, setLastBuy] = useRemembered(rememberKey(scope, "inkop-lager"));
  const [buyPlace, setBuyPlace] = useState<string | null>(null);
  const buyTo = pickPlace(places, buyPlace, place?.id, lastBuy);

  useEffect(() => {
    if (buyOpen) buyRef.current?.focus();
  }, [buyOpen]);

  useEffect(() => {
    if (!focus) return;
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    onFocused();
  }, [focus, onFocused]);

  function save() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft === null) return;
    const n = parseCount(draft);
    if (n === null || n === count) {
      setDraft(null);
      if (n === null && draft.trim() !== "") {
        toast({ title: "Ange ett heltal, 0 eller mer.", tone: "critical" });
      }
      return;
    }
    start(async () => {
      const res = await setHomeCount({
        titleId: row.titleId,
        counted: n,
        ...(place ? { warehouseId: place.id } : {}),
      });
      setDraft(null);
      if (!res.ok) {
        toast({ title: "Sparades inte", description: res.error, tone: "critical" });
        return;
      }
      setSaved((k) => k + 1);
    });
  }

  function receive() {
    const n = parseCount(buy);
    if (n === null || n < 1) {
      toast({ title: "Ange antal pack, minst 1.", tone: "critical" });
      return;
    }
    start(async () => {
      const res = await addReceipt({
        titleId: row.titleId,
        quantity: n,
        ...(buyTo ? { warehouseId: buyTo } : {}),
      });
      if (!res.ok) {
        toast({ title: "Inköpet sparades inte", description: res.error, tone: "critical" });
        return;
      }
      if (buyTo) setLastBuy(buyTo);
      setBuy("");
      setBuyPlace(null);
      setBuyOpen(false);
      setSaved((k) => k + 1);
      toast({
        title: `Klart! +${formatInt(n)} ${row.name}`,
        description: `${formatInt(res.data.onHand)} pack ${inPlace(res.data.placeName ?? "hemma")}.`,
        tone: "ok",
      });
    });
  }

  const latest = place && multi ? (row.latestByPlace[place.id] ?? null) : row.latest;
  const tone = row.negative ? "critical" : row.home <= 0 && row.runsOut ? "critical" : "warning";
  const negativeHere = count < 0;
  return (
    <li
      id={`rad-${row.titleId}`}
      className="rise scroll-mt-32 border-b border-line target:bg-hover"
      style={{ "--i": Math.min(index, 16) + 3 } as React.CSSProperties}
      data-title={row.name}
    >
      <div className={cn(GRID, "min-h-16 py-2.5")} style={actWidth(multi, canEdit)}>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base text-fg">{row.name}</span>
            {row.negative || negativeHere ? (
              <StatusTag status="critical">Räkna om</StatusTag>
            ) : row.retired ? (
              <StatusTag status="offline">Utgår</StatusTag>
            ) : row.runsOut ? (
              <StatusTag status={tone}>
                {row.own ? "Packa" : row.home <= 0 ? "Slut" : "Tar slut"}
              </StatusTag>
            ) : null}
          </span>
          <span className="meta truncate text-subtle">
            {latest ? (
              <>
                <span
                  className={cn(
                    "tnum",
                    latest.delta !== null && latest.delta < 0 && "text-muted",
                    latest.delta !== null && latest.delta > 0 && "text-fg",
                  )}
                >
                  {latest.text}
                </span>
                {latest.automatic ? " (Awish)" : ""}, {latest.when}
              </>
            ) : (
              "Inget räknat än"
            )}
          </span>
          <span className="meta text-subtle md:hidden">
            {formatInt(row.inMachines)} i automater · {formatInt(row.sold7)} sålda 7 d · räcker{" "}
            {lastsText(row)}
          </span>
        </span>
        <span className="tnum hidden text-right text-sm text-muted md:block">
          {formatInt(row.inMachines)}
        </span>
        <span className="tnum hidden text-right text-sm text-muted md:block">
          {formatInt(row.sold7)}
        </span>
        <span
          className={cn(
            "tnum hidden text-right text-sm md:block",
            row.runsOut ? "text-signal-fg" : "text-muted",
          )}
        >
          {lastsText(row)}
        </span>
        <span className="flex items-center justify-end gap-2">
          <span className="relative inline-flex w-5 justify-center" aria-hidden>
            {pending ? (
              <span className="live-dot size-1.5 rounded-full bg-muted text-muted" />
            ) : saved > 0 ? (
              <span key={saved} className="fade-in text-muted">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          {canEdit && place ? (
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              aria-label={`Antal ${inPlace(place.name)}, ${row.name}`}
              className={cn(
                "tnum h-12 w-24 rounded-sm border bg-bg px-3 text-right text-2xl font-medium text-fg transition-[border-color,background-color] duration-fast ease-instrument hover:border-muted",
                negativeHere ? "border-signal text-signal-fg" : "border-line-control",
              )}
              value={value}
              disabled={pending}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  cancelled.current = true;
                  setDraft(null);
                  e.currentTarget.blur();
                }
              }}
            />
          ) : canEdit ? (
            // Alla lager valda: antalet är summan; ett klick frågar vilket lager som räknas.
            <button
              type="button"
              onClick={onChoosePlace}
              aria-label={`Ändra antal, ${row.name}`}
              className={cn(
                "tnum h-12 w-24 rounded-sm border border-line-control bg-bg px-3 text-right text-2xl font-medium hover:border-muted",
                row.negative ? "text-signal-fg" : "text-fg",
              )}
            >
              {signedInt(row.home)}
            </button>
          ) : (
            <span
              className={cn(
                "tnum text-2xl font-medium",
                negativeHere ? "text-signal-fg" : "text-fg",
              )}
            >
              {signedInt(count)}
            </span>
          )}
        </span>
        {canEdit ? (
          <span className="col-span-3 flex flex-wrap items-center justify-end gap-1 md:col-span-1">
            {buyOpen ? (
              <form
                className="fade-in flex flex-col items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  receive();
                }}
              >
                {multi ? (
                  <div className="w-64 max-w-full">
                    <PlaceButtons
                      compact
                      label={`${row.own ? "Packat till" : "Inköp till"}, ${row.name}`}
                      places={places.map((p) => ({ id: p.id, name: p.name }))}
                      value={buyTo}
                      onChange={setBuyPlace}
                    />
                  </div>
                ) : null}
                <span className="flex items-center gap-1">
                  <input
                    ref={buyRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    aria-label={`Antal ${row.own ? "packade" : "köpta"} pack, ${row.name}`}
                    placeholder="+"
                    className="tnum h-11 w-16 rounded-sm border border-line-control bg-bg px-2 text-right text-base text-fg"
                    value={buy}
                    disabled={pending}
                    onChange={(e) => setBuy(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setBuy("");
                        setBuyOpen(false);
                      }
                    }}
                  />
                  <button
                    type="submit"
                    disabled={pending}
                    aria-label={`Lägg till ${row.own ? "packade" : "inköp"}, ${row.name}`}
                    className="inline-flex size-11 items-center justify-center rounded-sm border border-inverse bg-inverse text-on-inverse hover:bg-inverse-hover"
                  >
                    <Icon name="check" size={14} />
                  </button>
                </span>
              </form>
            ) : (
              <>
                {multi ? (
                  <button
                    type="button"
                    onClick={onMove}
                    aria-label={`Flytta, ${row.name}`}
                    className="inline-flex h-11 items-center gap-1 rounded-sm px-2 text-sm text-muted transition-colors duration-fast ease-instrument hover:bg-hover hover:text-fg"
                  >
                    <Icon name="chevronRight" size={12} />
                    <span>Flytta</span>
                  </button>
                ) : null}
                {/* Utgången titel köps inte in: den ligger still tills den säljs eller flyttas. */}
                {row.retired ? null : (
                  <button
                    type="button"
                    onClick={() => setBuyOpen(true)}
                    aria-label={`${row.own ? "Packat" : "Inköp"}, ${row.name}`}
                    className="inline-flex h-11 items-center gap-1 rounded-sm px-2 text-sm text-muted transition-colors duration-fast ease-instrument hover:bg-hover hover:text-fg"
                  >
                    <Icon name="plus" size={12} />
                    <span>{row.own ? "Packat" : "Inköp"}</span>
                  </button>
                )}
              </>
            )}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Flytta en titel mellan två lager i ett steg: från, till, antal, Flytta. Toasten har
 * Ångra (samma antal tillbaka).
 */
function MoveSheet({
  row,
  places,
  from: preferred,
  onClose,
}: {
  row: VartLagerRow;
  places: readonly Place[];
  /** Valt lager i vyn, eller null. */
  from: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const fullest = useMemo(
    () =>
      [...places].sort((a, b) => (row.byPlace[b.id] ?? 0) - (row.byPlace[a.id] ?? 0))[0]?.id ??
      null,
    [places, row.byPlace],
  );
  const [from, setFrom] = useState<string | null>(preferred ?? fullest);
  const [to, setTo] = useState<string | null>(
    () => places.find((p) => p.id !== (preferred ?? fullest))?.id ?? null,
  );
  const available = from ? Math.max(0, row.byPlace[from] ?? 0) : 0;
  const [qty, setQty] = useState<number>(() => Math.min(available, 1));
  const amount = Math.max(0, Math.min(qty, available));
  const fromName = places.find((p) => p.id === from)?.name ?? "";
  const toName = places.find((p) => p.id === to)?.name ?? "";
  const ready = from !== null && to !== null && from !== to && amount >= 1;

  function submit() {
    if (!ready || !from || !to) return;
    start(async () => {
      const res = await moveStock({ titleId: row.titleId, from, to, quantity: amount });
      if (!res.ok) {
        toast({ title: "Flyttades inte", description: res.error, tone: "critical" });
        return;
      }
      const d = res.data;
      onClose();
      toast({
        title: `Klart! ${formatInt(amount)}${NBSP}pack till ${d.toName}`,
        description: `${row.name}: ${d.fromName} ${signedInt(d.fromOnHand)} · ${d.toName} ${signedInt(d.toOnHand)}`,
        tone: "ok",
        duration: 10_000,
        action: {
          label: "Ångra",
          onClick: () => {
            void undoMove({ transferId: d.transferId }).then((u) => {
              toast(
                u.ok
                  ? {
                      title: `Ångrat. ${formatInt(amount)}${NBSP}pack tillbaka ${inPlace(d.fromName)}`,
                      tone: "neutral",
                    }
                  : { title: "Kunde inte ångra", description: u.error, tone: "critical" },
              );
            });
          },
        },
      });
    });
  }

  return (
    <Sheet open onClose={onClose} title={`Flytta ${row.name}`} eyebrow="Vårt lager">
      <form
        className="flex flex-col gap-5 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-2">
          <span className="label text-subtle">Från</span>
          <PlaceButtons
            label="Från"
            places={places.map((p) => ({ id: p.id, name: p.name, count: row.byPlace[p.id] ?? 0 }))}
            value={from}
            onChange={(id) => {
              setFrom(id);
              if (id === to) setTo(places.find((p) => p.id !== id)?.id ?? null);
              setQty((q) => Math.min(Math.max(q, 1), Math.max(0, row.byPlace[id] ?? 0)));
            }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="label text-subtle">Till</span>
          <PlaceButtons
            label="Till"
            places={places.map((p) => ({
              id: p.id,
              name: p.name,
              count: row.byPlace[p.id] ?? 0,
              disabled: p.id === from,
            }))}
            value={to}
            onChange={setTo}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={`flytta-${row.titleId}`} className="label text-subtle">
            Antal pack
          </label>
          <div className="grid grid-cols-[56px_1fr_56px] items-center gap-2">
            <button
              type="button"
              aria-label="En mindre"
              onClick={() => setQty(Math.max(1, amount - 1))}
              disabled={amount <= 1}
              className="flex size-14 items-center justify-center rounded-md border border-line-strong bg-raised text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
            >
              <Icon name="minus" size={24} />
            </button>
            <input
              id={`flytta-${row.titleId}`}
              type="number"
              inputMode="numeric"
              pattern="[0-9]*"
              min={1}
              max={available}
              value={amount}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setQty(Math.trunc(Number(e.target.value)) || 0)}
              className="tnum h-14 w-full min-w-0 [appearance:textfield] rounded-md border border-line-control bg-bg text-center text-3xl font-medium text-fg [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              style={{ fontSize: 28 }}
            />
            <button
              type="button"
              aria-label="En till"
              onClick={() => setQty(Math.min(available, amount + 1))}
              disabled={amount >= available}
              className="flex size-14 items-center justify-center rounded-md border border-line-strong bg-raised text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
            >
              <Icon name="plus" size={24} />
            </button>
          </div>
          <span className="meta text-subtle">
            {available > 0
              ? `${formatInt(available)}${NBSP}pack ${inPlace(fromName)}`
              : `Inga pack ${inPlace(fromName)}`}
          </span>
        </div>
        <button
          type="submit"
          disabled={!ready || pending}
          className={cn(
            "flex h-14 w-full items-center justify-center gap-2 rounded-md border text-lg font-medium transition-colors",
            !ready || pending
              ? "border-dashed border-line-strong text-disabled"
              : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
          )}
        >
          <Icon name="check" size={20} />
          {pending
            ? "Flyttar…"
            : ready
              ? `Flytta ${formatInt(amount)}${NBSP}pack till ${toName}`
              : "Flytta"}
        </button>
      </form>
    </Sheet>
  );
}
