"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/v2/button";
import { Sheet } from "@/components/v2/sheet";
import { Stepper } from "@/components/v2/stepper";
import { toastV2 } from "@/components/v2/toast";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";
import type { RouteLimits } from "@/server/data/v2/types";

import { saveRouteLimits } from "../actions";
import { reach } from "../_lib/reach";

const DAYS = [
  [1, "Mån"],
  [2, "Tis"],
  [3, "Ons"],
  [4, "Tor"],
  [5, "Fre"],
  [6, "Lör"],
  [7, "Sön"],
] as const;

/**
 * Dagens gräns (ägare och admin): högst så många stopp och pack per dag, och vilka dagar
 * rutten körs. Samma gräns för Rutt, Hem, Att göra, Lager och Drift (en plan överallt).
 */
export function LimitsSheet({ limits }: { limits: RouteLimits }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stops, setStops] = useState(limits.maxStops);
  const [packs, setPacks] = useState(limits.maxPacks);
  const [days, setDays] = useState<ReadonlySet<number>>(new Set(limits.weekdays));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset(next: boolean) {
    if (next) {
      setStops(limits.maxStops);
      setPacks(limits.maxPacks);
      setDays(new Set(limits.weekdays));
      setError(null);
    }
    setOpen(next);
  }

  function save() {
    start(async () => {
      const r = await reach(() =>
        saveRouteLimits({ maxStops: stops, maxPacks: packs, weekdays: [...days] }),
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOpen(false);
      toastV2("Dagens gräns sparad", {
        detail: `Max ${stops} stopp och ${formatInt(packs)} pack per dag.`,
      });
      router.refresh();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={reset}
      dismissible={!pending}
      trigger={
        <button type="button" className="hd-note hd-link">
          Max {limits.maxStops} stopp · {formatInt(limits.maxPacks)} pack/dag
        </button>
      }
      title="Dagens gräns"
      description="Rutten fylls med det som brådskar mest, upp till gränsen. Det som inte får plats kommer en annan dag."
      footer={
        <>
          <Button onClick={() => setOpen(false)} disabled={pending} size="lg">
            Avbryt
          </Button>
          <Button variant="act" size="lg" onClick={save} pending={pending}>
            Spara
          </Button>
        </>
      }
    >
      <div className="v2-rutt-limits">
        <div className="lim">
          <span>Stopp per dag</span>
          <Stepper value={stops} onChange={setStops} min={1} max={30} label="Stopp per dag" />
        </div>
        <div className="lim">
          <span>Pack per dag</span>
          <Stepper
            value={packs}
            onChange={setPacks}
            min={10}
            max={5000}
            step={10}
            label="Pack per dag"
          />
        </div>
        <div className="lim col">
          <span>Dagar med rutt</span>
          <div className="days" role="group" aria-label="Dagar med rutt">
            {DAYS.map(([d, label]) => {
              const on = days.has(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  className={cn("day", on && "on")}
                  onClick={() =>
                    setDays((prev) => {
                      const next = new Set(prev);
                      if (next.has(d)) next.delete(d);
                      else next.add(d);
                      return next;
                    })
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
