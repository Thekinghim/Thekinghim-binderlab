"use client";

import { useState, useTransition } from "react";
import type React from "react";

import { inPlace } from "@/components/stock/place-text";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import { MobileMore } from "../../_mobil/mobile-more";
import { Sheet } from "../../lager/_components/sheet";
import { archivePlace, createPlace, renamePlace } from "../actions";
import type { Place } from "../_lib/model";

/**
 * Raden över listan: "Alla · Hemma · Kontoret" (bara med flera lager) och, för ägare och
 * admin, "+ Nytt lager" och "Ändra". Stora knappar, ett val i taget.
 */
export function PlaceBar({
  places,
  totals,
  selected,
  onSelect,
  canEdit,
}: {
  places: readonly Place[];
  /** Pack per lager. */
  totals: Readonly<Record<string, number>>;
  /** Valt lager, null = alla. */
  selected: string | null;
  /** Utelämnad: ingen vy att växla (sidan utan lager). */
  onSelect?: (id: string | null) => void;
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const multi = places.length > 1;
  if (!multi && !canEdit) return null;

  const chip = (on: boolean) =>
    cn(
      "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-md transition-colors duration-fast ease-instrument",
      on
        ? "border-inverse bg-inverse font-medium text-on-inverse"
        : "border-line-strong bg-surface text-fg hover:bg-hover",
    );

  return (
    <div
      className="rise flex flex-wrap items-center gap-2"
      style={{ "--i": 2 } as React.CSSProperties}
    >
      {multi ? (
        <div role="radiogroup" aria-label="Visa lager" className="flex flex-wrap gap-2">
          <button
            type="button"
            role="radio"
            aria-checked={selected === null}
            onClick={() => onSelect?.(null)}
            className={chip(selected === null)}
          >
            Alla
          </button>
          {places.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected === p.id}
              onClick={() => onSelect?.(p.id)}
              className={chip(selected === p.id)}
            >
              {p.name}
              <span
                className={cn(
                  "tnum text-sm",
                  selected === p.id ? "text-on-inverse/80" : "text-subtle",
                )}
              >
                {formatInt(totals[p.id] ?? 0)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {canEdit ? (
        // Mobil, med flera lager: "Nytt lager" och "Ändra" bakom "⋯" i slutet av raden.
        <MaybeMore more={multi}>
          <div className="flex flex-wrap gap-1 max-md:flex-col">
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex min-h-11 items-center gap-1 rounded-sm px-3 text-md text-muted hover:bg-hover hover:text-fg"
            >
              <Icon name="plus" size={12} />
              Nytt lager
            </button>
            {multi ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex min-h-11 items-center rounded-sm px-3 text-md text-muted hover:bg-hover hover:text-fg"
              >
                Ändra
              </button>
            ) : null}
          </div>
        </MaybeMore>
      ) : null}

      {adding ? (
        <NewPlaceSheet
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            onSelect?.(id);
          }}
        />
      ) : null}
      {editing ? (
        <EditPlacesSheet
          places={places}
          totals={totals}
          onClose={() => setEditing(false)}
          onArchived={(id) => {
            if (selected === id) onSelect?.(null);
          }}
        />
      ) : null}
    </div>
  );
}

function NewPlaceSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ready = name.trim().length > 0;
  return (
    <Sheet open onClose={onClose} title="Nytt lager" eyebrow="Vårt lager">
      <form
        className="flex flex-col gap-4 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          start(async () => {
            const res = await createPlace({ name });
            if (!res.ok) {
              setError(res.error);
              return;
            }
            toast({ title: `Klart! ${res.data.name} finns nu`, tone: "ok" });
            onCreated(res.data.id);
          });
        }}
      >
        <label htmlFor="nytt-lager" className="label text-subtle">
          Namn
        </label>
        <input
          id="nytt-lager"
          autoFocus
          autoComplete="off"
          maxLength={60}
          placeholder="Kontoret"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          className="h-14 rounded-md border border-line-control bg-bg px-4 text-lg text-fg"
          style={{ fontSize: 18 }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "nytt-lager-fel" : undefined}
        />
        {error ? (
          <p id="nytt-lager-fel" className="text-sm text-signal-fg">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!ready || pending}
          className={cn(
            "flex h-14 w-full items-center justify-center gap-2 rounded-md border text-lg font-medium",
            !ready || pending
              ? "border-dashed border-line-strong text-disabled"
              : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
          )}
        >
          <Icon name="check" size={20} />
          {pending ? "Skapar…" : "Skapa lager"}
        </button>
      </form>
    </Sheet>
  );
}

function EditPlacesSheet({
  places,
  totals,
  onClose,
  onArchived,
}: {
  places: readonly Place[];
  totals: Readonly<Record<string, number>>;
  onClose: () => void;
  onArchived: (id: string) => void;
}) {
  return (
    <Sheet open onClose={onClose} title="Ändra lager" eyebrow="Vårt lager">
      <ul className="flex flex-col gap-4 px-5 pb-5">
        {places.map((p) => (
          <EditPlaceRow
            key={p.id}
            place={p}
            packs={totals[p.id] ?? 0}
            last={places.length <= 1}
            onArchived={() => onArchived(p.id)}
          />
        ))}
      </ul>
    </Sheet>
  );
}

function EditPlaceRow({
  place,
  packs,
  last,
  onArchived,
}: {
  place: Place;
  packs: number;
  last: boolean;
  onArchived: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(place.name);
  const [pending, start] = useTransition();
  const changed = name.trim() !== place.name && name.trim().length > 0;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!changed) return;
          start(async () => {
            const res = await renamePlace({ id: place.id, name });
            if (!res.ok) {
              toast({ title: "Namnet sparades inte", description: res.error, tone: "critical" });
              return;
            }
            toast({ title: `Klart! Heter nu ${res.data.name}`, tone: "ok" });
          });
        }}
      >
        <input
          aria-label={`Namn på ${place.name}`}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className="h-11 min-w-0 flex-1 rounded-sm border border-line-control bg-bg px-3 text-md text-fg"
          style={{ fontSize: 16 }}
        />
        <button
          type="submit"
          disabled={!changed || pending}
          className={cn(
            "h-11 rounded-sm border px-4 text-md font-medium",
            changed && !pending
              ? "border-inverse bg-inverse text-on-inverse"
              : "border-dashed border-line-strong text-disabled",
          )}
        >
          Spara
        </button>
      </form>
      <div className="flex items-center justify-between gap-2">
        <span className="meta tnum text-subtle">
          {packs !== 0 ? `${formatInt(packs)}${NBSP}pack ${inPlace(place.name)}` : "Tomt"}
        </span>
        {last ? null : packs !== 0 ? (
          <span className="meta text-subtle">Flytta packen för att ta bort</span>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await archivePlace({ id: place.id, archived: true });
                if (!res.ok) {
                  toast({ title: "Togs inte bort", description: res.error, tone: "critical" });
                  return;
                }
                onArchived();
                toast({
                  title: `${res.data.name} borttaget`,
                  tone: "neutral",
                  duration: 10_000,
                  action: {
                    label: "Ångra",
                    onClick: () => {
                      void archivePlace({ id: place.id, archived: false }).then((u) =>
                        toast(
                          u.ok
                            ? { title: `${u.data.name} är tillbaka`, tone: "ok" }
                            : { title: "Kunde inte ångra", description: u.error, tone: "critical" },
                        ),
                      );
                    },
                  },
                });
              })
            }
            className="min-h-11 rounded-sm px-3 text-md text-muted hover:bg-hover hover:text-fg"
          >
            Ta bort
          </button>
        )}
      </div>
    </li>
  );
}

function MaybeMore({ more, children }: { more: boolean; children: React.ReactNode }) {
  return more ? (
    <MobileMore label="Fler val för lagren" className="max-md:ml-auto">
      {children}
    </MobileMore>
  ) : (
    <>{children}</>
  );
}
