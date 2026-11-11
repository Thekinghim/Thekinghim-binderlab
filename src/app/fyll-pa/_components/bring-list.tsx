"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { PlaceButtons } from "@/components/stock/place-buttons";
import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/cn";

import { Sheet } from "@/app/(app)/lager/_components/sheet";

import { bringList, defaultBringSelection, type FillMachine, type PlaceStock } from "../_lib/model";

const rise = (i: number) => ({ "--i": Math.min(i, 12) }) as CSSProperties;

/**
 * Ta med-listan (packlistan): innan man åker. Välj automater och se hur många pack av varje
 * produkt som ska med för att fylla dem, totalt och per automat, mot saldot i lagret man tar
 * från. Varnar när lagret inte räcker. Allt räknas i telefonen ur samma data som resten av
 * Fyll på (också det som ligger i kön), så listan fungerar utan nät.
 */
export function BringScreen({
  machines,
  places,
  stock,
  chosen: chosenProp,
  onToggle,
  placeId: placeProp,
  online,
  headerActions,
  onBack,
  onPlace,
}: {
  /** Automaterna som listan visar (som Fyll på: störst behov först). */
  machines: readonly FillMachine[];
  /** Våra lager med antal pack (för "Från: Hemma ▾"). Tomt = inget eget lager. */
  places: readonly { id: string; name: string; count: number }[];
  /** Saldot per lager efter det som ligger i kön. */
  stock: PlaceStock;
  /** Valda automater; null = de som behöver pack (annars alla). */
  chosen: readonly string[] | null;
  /** Markerar eller avmarkerar en automat. */
  onToggle: (id: string) => void;
  /** Lagret man tar från (det föreslagna tills man väljer ett annat). */
  placeId: string | null;
  online: boolean;
  /** Uppdatera och uppkopplingen, till höger om Automater. */
  headerActions?: ReactNode;
  onBack: () => void;
  onPlace: (id: string) => void;
}) {
  const t = useT();
  const chosen = useMemo(
    () => chosenProp ?? defaultBringSelection(machines),
    [chosenProp, machines],
  );
  const placeId = places.some((p) => p.id === placeProp) ? placeProp : (places[0]?.id ?? null);
  const [choosing, setChoosing] = useState(false);
  const place = places.find((p) => p.id === placeId) ?? null;
  const list = useMemo(
    () => bringList(machines, new Set(chosen), place ? (stock[place.id] ?? {}) : null),
    [chosen, machines, place, stock],
  );
  const placeLabel = place ? t.common.placeName(place.name) : "";

  return (
    <div className="flex flex-col gap-6 px-4 pt-[calc(12px+env(safe-area-inset-top))] pb-[calc(32px+env(safe-area-inset-bottom))]">
      <header className="rise flex flex-col gap-3" style={rise(0)}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={onBack}
            className="label inline-flex min-h-11 min-w-11 items-center gap-1 text-subtle hover:text-fg"
          >
            <Icon name="chevronLeft" />
            {t.fill.machines}
          </button>
          {headerActions}
        </div>
        <p className="label text-subtle">{t.fill.bringTitle}</p>
        <h1 className="text-3xl font-medium text-balance text-fg">
          {chosen.length === 0
            ? t.fill.bringPickMachine
            : list.want === 0
              ? t.fill.bringNothing
              : t.fill.bringHeadline(list.bring)}
        </h1>
        {chosen.length > 0 && list.want === 0 ? (
          <p className="text-md text-muted">{t.fill.bringNothingHint}</p>
        ) : null}
        {!online ? <p className="text-sm text-muted">{t.fill.bringOffline}</p> : null}
      </header>

      {list.missing > 0 ? (
        <section
          role="alert"
          className="rise flex flex-col gap-1 rounded-md border border-signal-line bg-signal-soft p-4"
          style={rise(1)}
        >
          <p className="text-lg font-medium text-signal-fg">
            {t.fill.bringShortTitle(list.missing)}
          </p>
          <p className="text-sm text-muted">{t.fill.bringShortHint}</p>
        </section>
      ) : null}

      {places.length > 1 && place ? (
        <button
          type="button"
          onClick={() => setChoosing(true)}
          aria-label={t.fill.fromAria(placeLabel)}
          className="rise inline-flex min-h-11 items-center gap-1 self-start rounded-full border border-line-strong bg-surface px-4 text-md text-fg active:bg-hover"
          style={rise(1)}
        >
          <span className="text-subtle">{t.fill.from}</span>
          <span className="font-medium">{placeLabel}</span>
          <Icon name="chevronDown" size={14} />
        </button>
      ) : null}

      <section
        aria-labelledby="ta-med-automater"
        className="rise flex flex-col gap-3"
        style={rise(2)}
      >
        <h2 id="ta-med-automater" className="text-lg font-medium text-fg">
          {t.fill.bringMachines}
        </h2>
        <ul className="flex flex-col gap-2">
          {machines.map((m) => {
            const on = chosen.includes(m.id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => onToggle(m.id)}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-md border px-4 py-2 text-left text-md transition-colors",
                    on
                      ? "border-fg bg-hover text-fg"
                      : "border-line-strong bg-surface text-muted active:bg-hover",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-sm border",
                      on ? "border-inverse bg-inverse text-on-inverse" : "border-line-strong",
                    )}
                  >
                    {on ? <Icon name="check" size={16} /> : null}
                  </span>
                  <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
                    {m.place}
                  </span>
                  <span className="shrink-0 text-sm text-subtle">{m.code}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {list.totals.length > 0 ? (
        <section
          aria-labelledby="ta-med-totalt"
          className="rise flex flex-col gap-3"
          style={rise(3)}
        >
          <h2 id="ta-med-totalt" className="flex items-baseline justify-between gap-3">
            <span className="text-lg font-medium text-fg">{t.fill.bringTotal}</span>
            <span className="tnum text-md text-muted">{t.common.packs(list.bring)}</span>
          </h2>
          <ul
            aria-label={t.fill.bringTotal}
            className="flex flex-col divide-y divide-line rounded-md border border-line-strong bg-surface"
          >
            {list.totals.map((r) => (
              <li key={r.titleId} className="flex min-h-14 flex-col gap-1 px-4 py-3">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-md font-medium [overflow-wrap:anywhere] text-fg">
                    {r.name}
                  </span>
                  <span className="tnum shrink-0 text-2xl font-medium text-fg">
                    {t.common.int(r.bring)}
                  </span>
                </span>
                {r.have !== null ? (
                  <span
                    className={cn(
                      "tnum flex flex-wrap items-baseline justify-between gap-x-3 text-sm",
                      r.missing > 0 ? "text-signal-fg" : "text-muted",
                    )}
                  >
                    <span>
                      {r.missing > 0 ? `${t.fill.bringNeeds(r.want)} · ` : ""}
                      {t.fill.bringStock(place?.name ?? "", r.have)}
                    </span>
                    {r.missing > 0 ? (
                      <span className="font-medium">{t.fill.bringMissing(r.missing)}</span>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {list.machines.length > 0 ? (
        <section
          aria-labelledby="ta-med-per-automat"
          className="rise flex flex-col gap-3"
          style={rise(4)}
        >
          <h2 id="ta-med-per-automat" className="text-lg font-medium text-fg">
            {t.fill.bringPerMachine}
          </h2>
          <ul className="flex flex-col gap-3">
            {list.machines.map((m) => (
              <li
                key={m.id}
                className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4"
              >
                <p className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-md font-medium [overflow-wrap:anywhere] text-fg">
                    {m.place}
                  </span>
                  <span className="tnum shrink-0 text-md text-fg">
                    {m.want > 0 ? t.common.packs(m.want) : ""}
                  </span>
                </p>
                {m.lines.length === 0 ? (
                  <p className="text-sm text-muted">
                    {m.known ? t.fill.bringMachineFull : t.fill.bringMachineUnknown}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {m.lines.map((l) => (
                      <li
                        key={l.titleId}
                        className="flex items-baseline justify-between gap-3 text-sm text-muted"
                      >
                        <span className="min-w-0 [overflow-wrap:anywhere]">{l.name}</span>
                        <span className="tnum shrink-0 text-fg">{t.common.int(l.want)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Sheet
        open={choosing}
        onClose={() => setChoosing(false)}
        title={t.fill.takeFrom}
        eyebrow={t.fill.bringTitle}
        closeLabel={t.common.close}
      >
        <div className="px-5 pb-5">
          <PlaceButtons
            label={t.fill.takeFrom}
            places={places.map((p) => ({ ...p, name: t.common.placeName(p.name) }))}
            countText={t.common.packs}
            value={placeId}
            onChange={(id) => {
              setChoosing(false);
              onPlace(id);
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}
