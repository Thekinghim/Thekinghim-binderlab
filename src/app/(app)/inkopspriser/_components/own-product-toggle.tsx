"use client";

import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { setOwnProduct } from "../actions";

/**
 * "Egen produkt" på eller av för en titel: vi packar den själva, så Vårt lager och Inköp
 * säger "Packa" i stället för "Beställ". Ett tryck, med Ångra i bekräftelsen.
 */
export function OwnProductToggle({
  titleId,
  titleName,
  initial,
  canEdit,
}: {
  titleId: string;
  titleName: string;
  initial: boolean;
  canEdit: boolean;
}) {
  const toast = useToast();
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();

  function save(next: boolean, undo: boolean) {
    setOn(next);
    start(async () => {
      const res = await setOwnProduct({ titleId, ownProduct: next });
      if (!res.ok) {
        setOn(!next);
        toast({ title: "Sparades inte", description: res.error, tone: "critical" });
        return;
      }
      toast(
        undo
          ? { title: "Ångrat.", tone: "neutral" }
          : {
              title: next ? `Klart! ${titleName} är egen produkt.` : `Klart! ${titleName} köps in.`,
              tone: "ok",
              duration: 10_000,
              action: { label: "Ångra", onClick: () => save(!next, true) },
            },
      );
    });
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-line-strong px-4 py-3">
      <span className="flex flex-col">
        <span className="text-base text-fg">Egen produkt</span>
        <span className="meta text-subtle">{on ? "Vi packar den" : "Köps in"}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Egen produkt, ${titleName}`}
        disabled={!canEdit || pending}
        onClick={() => save(!on, false)}
        className={cn(
          "relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors duration-fast ease-instrument disabled:opacity-60",
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
  );
}
