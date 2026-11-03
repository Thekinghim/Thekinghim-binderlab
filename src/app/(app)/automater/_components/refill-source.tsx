"use client";

import { useState, useTransition } from "react";

import { PlaceButtons } from "@/components/stock/place-buttons";
import { useToast } from "@/components/ui/toast";

import { setRefillSource } from "@/app/(app)/vart-lager/actions";

/**
 * Automatens "Fylls på från": vilket av våra lager påfyllningarna (och Awish-uttagen) dras
 * ur. Ett tryck sparar; toasten har Ångra. Ägare och admin väljer, andra ser lagret.
 */
export function RefillSourcePicker({
  machineId,
  machineLabel,
  places,
  current,
  defaultPlaceId,
  canEdit,
}: {
  machineId: string;
  machineLabel: string;
  places: readonly { id: string; name: string }[];
  /** Valt lager, null = standardlagret. */
  current: string | null;
  defaultPlaceId: string | null;
  canEdit: boolean;
}) {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(current ?? defaultPlaceId);
  const [pending, start] = useTransition();
  const name = places.find((p) => p.id === value)?.name ?? "";

  if (!canEdit || places.length < 2) {
    return name ? <p className="text-md text-muted">{`Fylls på från ${name}.`}</p> : null;
  }

  const save = (next: string, previous: string | null, undo = false) =>
    start(async () => {
      setValue(next);
      const res = await setRefillSource({ machineId, placeId: next });
      if (!res.ok) {
        setValue(previous);
        toast({ title: "Sparades inte", description: res.error, tone: "critical" });
        return;
      }
      if (undo) {
        toast({ title: `Ångrat. Fylls på från ${res.data.name ?? ""}`, tone: "neutral" });
        return;
      }
      toast({
        title: `Klart! ${machineLabel} fylls på från ${res.data.name ?? ""}`,
        tone: "ok",
        duration: 10_000,
        ...(previous
          ? { action: { label: "Ångra", onClick: () => save(previous, next, true) } }
          : {}),
      });
    });

  return (
    <div className="flex max-w-md flex-col gap-2">
      <span className="label text-subtle">Fylls på från</span>
      <PlaceButtons
        compact
        label="Fylls på från"
        places={places.map((p) => ({ id: p.id, name: p.name, disabled: pending }))}
        value={value}
        onChange={(id) => {
          if (id !== value) save(id, value);
        }}
      />
    </div>
  );
}
