"use client";

import { useMemo, useRef, useState, useTransition } from "react";

import { PlaceButtons } from "@/components/stock/place-buttons";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/cn";

import { packMystery, undoMysteryPack } from "../actions";
import {
  MAX_BATCHES,
  maxBatches,
  packPlan,
  shortages,
  type Place,
  type Recipe,
} from "../_lib/model";

/** Ett nytt v4-id (randomUUID finns bara i säkra sammanhang; getRandomValues överallt). */
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Packa (mobil först): välj lager (förval: flest delar), antal omgångar (1–10), se vad som
 * tas ut och läggs till, tryck Packa. Saknas en del går det inte (vilka och hur många står
 * i rutan). Allt sparas i en transaktion; samma tryck två gånger ger en packning (id per
 * försök). Toasten har Ångra.
 */
export function PackFlow({
  titleId,
  name,
  recipe,
  places,
  byPlace,
  defaultPlaceId,
  initialBatches,
}: {
  titleId: string;
  name: string;
  recipe: Recipe;
  places: readonly Place[];
  byPlace: Readonly<Record<string, Readonly<Record<string, number>>>>;
  defaultPlaceId: string | null;
  initialBatches: number;
}) {
  const toast = useToast();
  const t = useT();
  const [pending, start] = useTransition();
  const [placeId, setPlaceId] = useState<string | null>(defaultPlaceId ?? places[0]?.id ?? null);
  const [batches, setBatches] = useState(initialBatches);
  const [done, setDone] = useState<{ packingId: string; text: string; undone: boolean } | null>(
    null,
  );
  // Samma id tills packningen lyckats: ett nytt tryck efter ett nätverksfel blir inte dubbelt.
  const clientId = useRef<string>(newId());

  const place = places.find((p) => p.id === placeId) ?? null;
  const stock = useMemo(() => (placeId ? (byPlace[placeId] ?? {}) : {}), [byPlace, placeId]);
  const plan = packPlan(recipe, batches);
  const missing = shortages(recipe, batches, stock);
  const cap = maxBatches(recipe, stock);
  const ready = place !== null && missing.length === 0 && !pending;
  const placeLabel = place?.name ?? "";

  function submit() {
    if (!ready || !place) return;
    start(async () => {
      const res = await packMystery({
        titleId,
        placeId: place.id,
        batches,
        recipeId: recipe.id,
        clientId: clientId.current,
      }).catch(() => ({ ok: false as const, error: t.common.offlineRetry }));
      if (!res.ok) {
        toast({
          title: t.mystery.notPacked,
          description: t.serverError(res.error),
          tone: "critical",
        });
        return;
      }
      clientId.current = newId();
      // Nästa packning börjar om på en omgång (saldot har minskat).
      setBatches(1);
      // "+14 …": det som lades till, inte saldot (hemma kan stå på 0 efter ett rättat minus).
      const text = `+${t.mystery.addsLine(res.data.packs, name, placeLabel)}`;
      setDone({ packingId: res.data.packingId, text, undone: false });
      toast({
        title: t.mystery.doneToast(text),
        description: t.mystery.packedBatches(batches),
        tone: "ok",
        duration: 10_000,
        action: { label: t.common.undo, onClick: () => undo(res.data.packingId) },
      });
    });
  }

  function undo(packingId: string) {
    start(async () => {
      const u = await undoMysteryPack({ packingId }).catch(() => ({
        ok: false as const,
        error: t.common.offlineRetry,
      }));
      if (!u.ok) {
        toast({
          title: t.mystery.undoFailed,
          description: t.serverError(u.error),
          tone: "critical",
        });
        return;
      }
      setDone((d) => (d && d.packingId === packingId ? { ...d, undone: true } : d));
      toast({ title: t.mystery.undone, tone: "neutral" });
    });
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {places.length > 1 ? (
        <div className="flex flex-col gap-2">
          <span className="label text-subtle">{t.mystery.packIn}</span>
          <PlaceButtons
            label={t.mystery.packIn}
            places={places.map((p) => ({ id: p.id, name: t.common.placeName(p.name) }))}
            value={placeId}
            onChange={setPlaceId}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor={`omgangar-${titleId}`} className="label text-subtle">
          {t.mystery.batchesLabel}
        </label>
        <div className="grid grid-cols-[56px_1fr_56px] items-center gap-2">
          <button
            type="button"
            aria-label={t.mystery.lessBatch}
            onClick={() => setBatches((b) => Math.max(1, b - 1))}
            disabled={batches <= 1}
            className="flex size-14 items-center justify-center rounded-md border border-line-strong bg-raised text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
          >
            <Icon name="minus" size={24} />
          </button>
          <input
            id={`omgangar-${titleId}`}
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            min={1}
            max={MAX_BATCHES}
            value={batches}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) =>
              setBatches(
                Math.min(MAX_BATCHES, Math.max(1, Math.trunc(Number(e.target.value)) || 1)),
              )
            }
            className="tnum h-14 w-full min-w-0 [appearance:textfield] rounded-md border border-line-control bg-bg text-center text-3xl font-medium text-fg [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            style={{ fontSize: 28 }}
          />
          <button
            type="button"
            aria-label={t.mystery.moreBatch}
            onClick={() => setBatches((b) => Math.min(MAX_BATCHES, b + 1))}
            disabled={batches >= MAX_BATCHES}
            className="flex size-14 items-center justify-center rounded-md border border-line-strong bg-raised text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
          >
            <Icon name="plus" size={24} />
          </button>
        </div>
        <span className="meta text-subtle">
          {t.mystery.planLine(plan.packs, cap.batches, placeLabel)}
        </span>
      </div>

      <div
        className={cn(
          "flex flex-col gap-3 rounded-md border px-4 py-3",
          missing.length > 0
            ? "border-signal-line bg-signal-soft"
            : "border-line-strong bg-surface",
        )}
        aria-live="polite"
      >
        {missing.length > 0 ? (
          <p className="text-base text-fg">
            <span className="label block text-signal-fg">{t.mystery.missingIn(placeLabel)}</span>
            {t.mystery.list(missing)}.
          </p>
        ) : null}
        <p className="text-base text-fg">
          <span className="label block text-subtle">{t.mystery.takesFrom(placeLabel)}</span>
          {t.mystery.list(plan.takes)}
        </p>
        <p className="text-base text-fg">
          <span className="label block text-subtle">{t.mystery.adds}</span>
          {t.mystery.addsLine(plan.packs, name, placeLabel)}
        </p>
      </div>

      <button
        type="submit"
        disabled={!ready}
        className={cn(
          "flex h-14 w-full items-center justify-center gap-2 rounded-md border text-lg font-medium transition-colors",
          !ready
            ? "border-dashed border-line-strong text-disabled"
            : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
        )}
      >
        {missing.length > 0 ? null : <Icon name="check" size={20} />}
        {pending
          ? t.mystery.packing
          : missing.length > 0
            ? t.mystery.missingParts
            : t.mystery.packBatches(batches)}
      </button>

      {done ? (
        <p className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line px-4 py-2 text-base">
          <span className={cn("min-w-0", done.undone ? "text-muted line-through" : "text-fg")}>
            {done.undone ? t.mystery.undoneLabel : t.mystery.packedLabel}
            {done.text}
          </span>
          {done.undone ? null : (
            <button
              type="button"
              onClick={() => undo(done.packingId)}
              disabled={pending}
              className="inline-flex h-11 shrink-0 items-center rounded-sm border border-line-strong px-3 text-sm font-medium text-fg hover:bg-hover"
            >
              {t.common.undo}
            </button>
          )}
        </p>
      ) : null}
    </form>
  );
}
