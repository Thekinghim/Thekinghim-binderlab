"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { setStorePowerHours } from "../actions";

/** Förslaget när brytaren slås på: vanligast är av på kvällen och på vid öppning. */
const DEFAULT_HOURS = { on: "10:00", off: "21:00" } as const;

/**
 * "Strömmen till automaten" för en butik (ägare och admin): butiken stänger av strömmen på
 * natten. Av (standard): strömmen är alltid på. På: tiderna då strömmen går på och av. Då
 * larmar inte offline medan strömmen är av (plus en halvtimme efter att den gått på), Drift
 * och Automater visar "Strömmen av", och Fyll på påminner om att starta om automaten.
 */
export function PowerHoursSetting({
  storeId,
  storeName,
  initial,
  canEdit,
}: {
  storeId: string;
  storeName: string;
  initial: { on: string; off: string } | null;
  canEdit: boolean;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState(initial);
  const [on, setOn] = useState(initial !== null);
  const [hours, setHours] = useState<{ on: string; off: string }>(initial ?? DEFAULT_HOURS);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = on
    ? saved === null || saved.on !== hours.on || saved.off !== hours.off
    : saved !== null;

  function save(next: { on: string; off: string } | null) {
    setError(null);
    start(async () => {
      const res = await setStorePowerHours({ storeId, hours: next });
      if (!res.ok) {
        setError(res.error);
        toast({ title: "Sparades inte", description: res.error, tone: "critical" });
        return;
      }
      setSaved(next);
      toast({
        title: next
          ? `Klart! Strömmen av ${next.off}–${next.on}.`
          : "Klart! Strömmen är alltid på.",
        description: next ? "Ingen offline-varning medan strömmen är av." : undefined,
        tone: "ok",
      });
    });
  }

  function toggle() {
    const next = !on;
    setOn(next);
    // Av: sparas direkt (strömmen alltid på). På: välj tiderna och tryck Spara.
    if (!next && saved !== null) save(null);
  }

  return (
    <div
      id="strom"
      className="flex scroll-mt-24 flex-col gap-3 rounded-md border border-line-strong px-4 py-3"
    >
      <div className="flex items-center justify-between gap-4">
        <span className="flex min-w-0 flex-col">
          <span className="text-base text-fg">Strömmen till automaten</span>
          <span className="meta text-subtle">
            {on
              ? "Butiken stänger av strömmen till automaten på natten."
              : "Alltid på. Slå på om butiken stänger av strömmen på natten."}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`Butiken stänger av strömmen till automaten på natten, ${storeName}`}
          disabled={!canEdit || pending}
          onClick={toggle}
          className={cn(
            "relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors duration-fast ease-instrument disabled:opacity-60 max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-1.5 max-md:before:content-['']",
            on ? "border-up bg-up" : "border-line-control bg-raised",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "shadow inline-block size-6 rounded-full bg-fg transition-transform duration-fast ease-instrument",
              on ? "translate-x-7 bg-bg" : "translate-x-1",
            )}
          />
        </button>
      </div>
      {on ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save(hours);
          }}
        >
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <Input
              label="Strömmen av"
              type="time"
              name="powerOff"
              required
              disabled={!canEdit || pending}
              value={hours.off}
              onChange={(e) => setHours((h) => ({ ...h, off: e.target.value }))}
            />
            <Input
              label="Strömmen på"
              type="time"
              name="powerOn"
              required
              disabled={!canEdit || pending}
              value={hours.on}
              onChange={(e) => setHours((h) => ({ ...h, on: e.target.value }))}
            />
          </div>
          <p className="text-xs text-subtle">
            Ingen offline-varning medan strömmen är av, och en halvtimme efter att den gått på.
            Efter påfyllning påminner Fyll på om att starta om automaten.
          </p>
          {error ? <p className="text-xs text-signal-fg">{error}</p> : null}
          {canEdit && dirty ? (
            <div>
              <Button
                type="submit"
                variant="primary"
                size="md"
                loading={pending}
                className="max-sm:w-full"
              >
                Spara tiderna
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
