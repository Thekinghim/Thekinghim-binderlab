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
      className="mys-pack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {places.length > 1 ? (
        <div className="fld">
          <span className="v2-lab">{t.mystery.packIn}</span>
          <PlaceButtons
            label={t.mystery.packIn}
            places={places.map((p) => ({ id: p.id, name: t.common.placeName(p.name) }))}
            value={placeId}
            onChange={setPlaceId}
          />
        </div>
      ) : null}

      <div className="fld">
        <label htmlFor={`omgangar-${titleId}`} className="v2-lab">
          {t.mystery.batchesLabel}
        </label>
        <div className="stepper">
          <button
            type="button"
            aria-label={t.mystery.lessBatch}
            onClick={() => setBatches((b) => Math.max(1, b - 1))}
            disabled={batches <= 1}
            className="v2-btn lg"
          >
            <Icon name="minus" size={18} />
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
            className="v2-input"
          />
          <button
            type="button"
            aria-label={t.mystery.moreBatch}
            onClick={() => setBatches((b) => Math.min(MAX_BATCHES, b + 1))}
            disabled={batches >= MAX_BATCHES}
            className="v2-btn lg"
          >
            <Icon name="plus" size={18} />
          </button>
        </div>
        <span className="mys-mute tnum">
          {t.mystery.planLine(plan.packs, cap.batches, placeLabel)}
        </span>
      </div>

      <div className={cn("mys-plan", missing.length > 0 && "short")} aria-live="polite">
        {missing.length > 0 ? (
          <p>
            <span className="v2-lab no">{t.mystery.missingIn(placeLabel)}</span>
            {t.mystery.list(missing)}.
          </p>
        ) : null}
        <p>
          <span className="v2-lab">{t.mystery.takesFrom(placeLabel)}</span>
          {t.mystery.list(plan.takes)}
        </p>
        <p>
          <span className="v2-lab">{t.mystery.adds}</span>
          {t.mystery.addsLine(plan.packs, name, placeLabel)}
        </p>
      </div>

      <button type="submit" disabled={!ready} className="v2-btn act lg w-full">
        {missing.length > 0 ? null : <Icon name="check" size={16} />}
        {pending
          ? t.mystery.packing
          : missing.length > 0
            ? t.mystery.missingParts
            : t.mystery.packBatches(batches)}
      </button>

      {done ? (
        <p className={cn("mys-done", done.undone && "undone")}>
          <span className="min-w-0">
            {done.undone ? t.mystery.undoneLabel : t.mystery.packedLabel}
            {done.text}
          </span>
          {done.undone ? null : (
            <button
              type="button"
              onClick={() => undo(done.packingId)}
              disabled={pending}
              className="v2-btn touch shrink-0"
            >
              {t.common.undo}
            </button>
          )}
        </p>
      ) : null}
    </form>
  );
}
