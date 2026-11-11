"use client";

import { useMemo, useState, useTransition } from "react";

import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { fuzzyRank } from "@/lib/fuzzy";
import { formatInt, formatMarginBp, NBSP } from "@/lib/format";

import { saveMysteryRecipe } from "../actions";
import {
  checkDraft,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MAX_ITEMS,
  mysteryCalc,
  shareBp,
  type DraftItem,
  type Recipe,
} from "../_lib/model";
import { Calculator } from "./calculator";
import type { CalcContext } from "./mystery-actions";

/**
 * Ändra innehållet: storleken på en omgång (förval 14), en rad per titel med antal och HIT,
 * och en sökruta för att lägga till titlar. Spara går först när antalen blir omgången.
 * Varje sparning blir en ny version från i dag (gamla packningar behåller sin version).
 * Med `calc` räknas kalkylen om för varje ändring, innan något är sparat ("vad händer om").
 */
export function RecipeEditor({
  titleId,
  recipe,
  choices,
  calc = null,
  onDone,
}: {
  titleId: string;
  recipe: Recipe | null;
  choices: ReadonlyArray<{ id: string; name: string }>;
  calc?: CalcContext | null;
  onDone?: () => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [batchSize, setBatchSize] = useState(recipe?.batchSize ?? DEFAULT_BATCH_SIZE);
  const [rows, setRows] = useState<DraftItem[]>(
    () =>
      recipe?.items.map((i) => ({ titleId: i.titleId, quantity: i.quantity, hit: i.hit })) ?? [],
  );
  const [note, setNote] = useState(recipe?.note ?? "");
  const [query, setQuery] = useState("");
  const names = useMemo(() => new Map(choices.map((c) => [c.id, c.name])), [choices]);
  const check = checkDraft(batchSize, rows);
  const used = new Set(rows.map((r) => r.titleId));
  // Kalkylen med utkastet: samma räkning som den sparade kalkylen på sidan.
  const draftCalc =
    calc && rows.length > 0
      ? mysteryCalc(
          batchSize,
          rows.map((r) => ({ ...r, name: names.get(r.titleId) ?? "Okänd titel" })),
          calc.prices,
          calc.salePriceOre,
          calc.fees,
        )
      : null;
  const hits = query.trim()
    ? fuzzyRank(
        choices.filter((c) => !used.has(c.id)),
        query,
        (c) => ({ label: c.name }),
      )
        .slice(0, 8)
        .map((r) => r.item)
    : [];

  const update = (i: number, patch: Partial<DraftItem>) =>
    setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  function add(id: string) {
    // Förval: det som saknas för att fylla omgången, minst 1.
    const left = Math.max(1, batchSize - rows.reduce((n, r) => n + r.quantity, 0));
    setRows((list) => [...list, { titleId: id, quantity: left, hit: false }]);
    setQuery("");
  }

  function save() {
    if (!check.ok) return;
    start(async () => {
      const res = await saveMysteryRecipe({
        titleId,
        batchSize,
        items: rows,
        note: note.trim() || undefined,
      });
      if (!res.ok) {
        toast({ title: "Sparades inte", description: res.error, tone: "critical" });
        return;
      }
      toast({ title: "Innehållet är sparat.", tone: "ok" });
      onDone?.();
    });
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="flex items-center justify-between gap-3">
        <span className="text-base text-fg">Pack per omgång</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_BATCH_SIZE}
          value={batchSize}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setBatchSize(Math.trunc(Number(e.target.value)) || 0)}
          className="tnum h-11 w-24 rounded-sm border border-line-control bg-bg px-3 text-right text-lg text-fg"
        />
      </label>

      {rows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line-strong">
          {rows.map((r, i) => (
            <li
              key={r.titleId}
              className="flex flex-col gap-2 px-3 py-3 md:flex-row md:items-center"
            >
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="truncate text-base text-fg">
                  {names.get(r.titleId) ?? "Okänd titel"}
                </span>
                <span className="meta tnum shrink-0 text-subtle">
                  {formatMarginBp(shareBp(r.quantity, batchSize), 0)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={`En mindre ${names.get(r.titleId) ?? ""}`}
                  onClick={() => update(i, { quantity: Math.max(1, r.quantity - 1) })}
                  className="flex size-11 items-center justify-center rounded-sm border border-line-strong text-fg active:bg-hover"
                >
                  <Icon name="minus" size={16} />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  aria-label={`Antal ${names.get(r.titleId) ?? ""}`}
                  min={1}
                  value={r.quantity}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => update(i, { quantity: Math.trunc(Number(e.target.value)) || 0 })}
                  className="tnum h-11 w-14 [appearance:textfield] rounded-sm border border-line-control bg-bg text-center text-lg text-fg [&::-webkit-inner-spin-button]:appearance-none"
                />
                <button
                  type="button"
                  aria-label={`En till ${names.get(r.titleId) ?? ""}`}
                  onClick={() => update(i, { quantity: r.quantity + 1 })}
                  className="flex size-11 items-center justify-center rounded-sm border border-line-strong text-fg active:bg-hover"
                >
                  <Icon name="plus" size={16} />
                </button>
                <button
                  type="button"
                  aria-pressed={r.hit}
                  onClick={() => update(i, { hit: !r.hit })}
                  className={cn(
                    "label h-11 rounded-sm border px-3",
                    r.hit
                      ? "border-signal-line bg-signal-soft text-signal-fg"
                      : "border-dashed border-line-strong text-subtle",
                  )}
                >
                  HIT
                </button>
                <button
                  type="button"
                  aria-label={`Ta bort ${names.get(r.titleId) ?? ""}`}
                  onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
                  className="ml-auto flex size-11 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg"
                >
                  <Icon name="close" size={16} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {rows.length < MAX_ITEMS ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`sok-${titleId}`} className="label text-subtle">
            Lägg till titel
          </label>
          <input
            id={`sok-${titleId}`}
            type="search"
            autoComplete="off"
            placeholder="Sök, t.ex. Surging"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits[0]) {
                e.preventDefault();
                add(hits[0].id);
              }
            }}
            className="h-11 rounded-sm border border-line-control bg-bg px-3 text-base text-fg"
          />
          {hits.length > 0 ? (
            <ul className="flex flex-col rounded-md border border-line-strong">
              {hits.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => add(c.id)}
                    className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-base text-fg hover:bg-hover"
                  >
                    <Icon name="plus" size={12} className="text-subtle" />
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : query.trim() ? (
            <p className="meta text-subtle">Ingen titel heter så.</p>
          ) : null}
        </div>
      ) : null}

      <label className="flex flex-col gap-2">
        <span className="label text-subtle">Notering (valfri)</span>
        <input
          type="text"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="h-11 rounded-sm border border-line-control bg-bg px-3 text-base text-fg"
        />
      </label>

      <p className={cn("text-base", check.ok ? "text-up" : "text-fg")} aria-live="polite">
        <span className="tnum font-medium">
          {formatInt(check.sum)}
          {NBSP}av{NBSP}
          {formatInt(batchSize)}
        </span>
        {check.ok ? " · klart att spara" : check.error ? ` · ${check.error}` : ""}
      </p>

      {draftCalc ? <Calculator calc={draftCalc} draft /> : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={!check.ok || pending}
          className={cn(
            "flex h-12 min-w-40 items-center justify-center gap-2 rounded-md border px-5 text-base font-medium",
            !check.ok || pending
              ? "border-dashed border-line-strong text-disabled"
              : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
          )}
        >
          <Icon name="check" size={16} />
          {pending ? "Sparar…" : "Spara innehållet"}
        </button>
        {onDone && recipe ? (
          <button
            type="button"
            onClick={onDone}
            className="h-12 rounded-md border border-line-strong px-5 text-base text-fg hover:bg-hover"
          >
            Avbryt
          </button>
        ) : null}
      </div>
    </form>
  );
}
