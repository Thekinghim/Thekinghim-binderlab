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
      className="mys-edit"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="flex items-center justify-between gap-3">
        <span className="text-v2-md font-[550] text-v2-ink">Pack per omgång</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_BATCH_SIZE}
          value={batchSize}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setBatchSize(Math.trunc(Number(e.target.value)) || 0)}
          className="v2-input num !w-24"
        />
      </label>

      {rows.length > 0 ? (
        <ul className="mys-contents rowsed">
          {rows.map((r, i) => (
            <li key={r.titleId}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="truncate text-v2-md text-v2-ink">
                  {names.get(r.titleId) ?? "Okänd titel"}
                </span>
                <span className="tnum shrink-0 text-v2-xs text-v2-mute">
                  {formatMarginBp(shareBp(r.quantity, batchSize), 0)}
                </span>
              </span>
              <span className="ctl">
                <button
                  type="button"
                  aria-label={`En mindre ${names.get(r.titleId) ?? ""}`}
                  onClick={() => update(i, { quantity: Math.max(1, r.quantity - 1) })}
                  className="v2-btn ico"
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
                  className="v2-input"
                />
                <button
                  type="button"
                  aria-label={`En till ${names.get(r.titleId) ?? ""}`}
                  onClick={() => update(i, { quantity: r.quantity + 1 })}
                  className="v2-btn ico"
                >
                  <Icon name="plus" size={16} />
                </button>
                <button
                  type="button"
                  aria-pressed={r.hit}
                  onClick={() => update(i, { hit: !r.hit })}
                  className="v2-btn lg hit"
                >
                  HIT
                </button>
                <button
                  type="button"
                  aria-label={`Ta bort ${names.get(r.titleId) ?? ""}`}
                  onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
                  className="v2-btn quiet ico ml-auto"
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
          <label htmlFor={`sok-${titleId}`} className="text-v2-sm font-[550] text-v2-ink">
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
            className="v2-input"
          />
          {hits.length > 0 ? (
            <ul className="hits">
              {hits.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => add(c.id)}>
                    <Icon name="plus" size={12} className="text-v2-faint" />
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : query.trim() ? (
            <p className="text-v2-sm text-v2-mute">Ingen titel heter så.</p>
          ) : null}
        </div>
      ) : null}

      <label className="flex flex-col gap-2">
        <span className="text-v2-sm font-[550] text-v2-ink">Notering (valfri)</span>
        <input
          type="text"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="v2-input"
        />
      </label>

      <p className={cn("sumline", check.ok && "ok")} aria-live="polite">
        <span className="tnum font-medium">
          {formatInt(check.sum)}
          {NBSP}av{NBSP}
          {formatInt(batchSize)}
        </span>
        {check.ok ? " · klart att spara" : check.error ? ` · ${check.error}` : ""}
      </p>

      {draftCalc ? <Calculator calc={draftCalc} draft /> : null}

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!check.ok || pending} className="v2-btn act lg min-w-40">
          <Icon name="check" size={16} />
          {pending ? "Sparar…" : "Spara innehållet"}
        </button>
        {onDone && recipe ? (
          <button type="button" onClick={onDone} className="v2-btn lg">
            Avbryt
          </button>
        ) : null}
      </div>
    </form>
  );
}
