"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { formatDate, formatMonth } from "@/lib/format";
import { addDays, endOfMonth, isSameDay, normalizePeriod, startOfMonth } from "@/lib/period";
import { Button, IconButton } from "@/components/ui/button";
import { inclusiveDays, type DateRange } from "./period-state";

const WEEKDAYS = ["M", "T", "O", "T", "F", "L", "S"] as const;
const WEEKDAYS_LONG = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

/** Måndag = 0 … söndag = 6 */
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

function monthGrid(month: Date): Array<Date | null> {
  const first = startOfMonth(month);
  const last = endOfMonth(month);
  const lead = weekdayIndex(first);
  const cells: Array<Date | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= last.getDate(); d++)
    cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function clamp(d: Date, min: Date | undefined, max: Date): Date {
  if (min && d < min) return min;
  if (d > max) return max;
  return d;
}

type DateRangePickerProps = {
  /** Startvärde. */
  value: DateRange | null;
  /** Sista valbara dag (i dag). */
  max: Date;
  /** Första valbara dag, t.ex. första dagen med data. */
  min?: Date;
  onApply: (range: DateRange) => void;
  onCancel: () => void;
  className?: string;
};

/**
 * Enkel intervallväljare: en månad i taget, två klick (start, slut).
 * Piltangenter flyttar en dag eller en vecka, PageUp/PageDown en månad,
 * Enter eller mellanslag väljer. Bara den fokuserade dagen ligger i
 * tabbordningen. Valt intervall markeras med form (fylld start/slut, ton
 * mellan), inte med signalfärg.
 */
export function DateRangePicker({
  value,
  max,
  min,
  onApply,
  onCancel,
  className,
}: DateRangePickerProps) {
  const [start, setStart] = useState<Date | null>(value?.start ?? null);
  const [end, setEnd] = useState<Date | null>(value?.end ?? null);
  const [hover, setHover] = useState<Date | null>(null);
  const [focus, setFocus] = useState<Date>(() => value?.end ?? max);
  const [month, setMonth] = useState<Date>(() => startOfMonth(value?.end ?? max));
  const gridRef = useRef<HTMLTableElement>(null);

  const cells = useMemo(() => monthGrid(month), [month]);
  const pendingEnd = start && !end ? hover : null;
  const shown = start ? normalizePeriod({ start, end: end ?? pendingEnd ?? start }) : null;

  const disabled = (d: Date) => d > max || (min ? d < min : false);

  const pick = (d: Date) => {
    if (disabled(d)) return;
    if (!start || end) {
      setStart(d);
      setEnd(null);
    } else {
      const r = normalizePeriod({ start, end: d });
      setStart(r.start);
      setEnd(r.end);
    }
    setFocus(d);
  };

  const moveFocus = (d: Date) => {
    const next = clamp(d, min, max);
    setFocus(next);
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) {
      setMonth(startOfMonth(next));
    }
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${next.getTime()}"]`)?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in step) {
      e.preventDefault();
      moveFocus(addDays(focus, step[e.key] ?? 0));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const delta = e.key === "PageUp" ? -1 : 1;
      const target = new Date(focus.getFullYear(), focus.getMonth() + delta, 1);
      const day = Math.min(focus.getDate(), endOfMonth(target).getDate());
      moveFocus(new Date(target.getFullYear(), target.getMonth(), day));
    } else if (e.key === "Home") {
      e.preventDefault();
      moveFocus(addDays(focus, -weekdayIndex(focus)));
    } else if (e.key === "End") {
      e.preventDefault();
      moveFocus(addDays(focus, 6 - weekdayIndex(focus)));
    }
  };

  const prevMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
  const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const canPrev = !min || endOfMonth(prevMonth) >= min;
  const canNext = nextMonth <= max;
  // Fokuserad dag måste ligga i visad månad för att vara tabbstopp.
  const focusInMonth =
    focus.getMonth() === month.getMonth() && focus.getFullYear() === month.getFullYear();
  const tabDay = focusInMonth ? focus : clamp(startOfMonth(month), min, max);

  return (
    <div className={cn("w-full max-w-[320px]", className)}>
      <div className="flex items-center justify-between">
        <IconButton
          icon="chevronLeft"
          label="Föregående månad"
          size="sm"
          disabled={!canPrev}
          onClick={() => setMonth(prevMonth)}
        />
        <p className="label text-fg" aria-live="polite">
          {formatMonth(month)}
        </p>
        <IconButton
          icon="chevronRight"
          label="Nästa månad"
          size="sm"
          disabled={!canNext}
          onClick={() => setMonth(nextMonth)}
        />
      </div>

      <table
        ref={gridRef}
        role="grid"
        aria-label={`Välj intervall, ${formatMonth(month)}`}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setHover(null)}
        className="mt-2 w-full table-fixed border-collapse"
      >
        <thead>
          <tr>
            {WEEKDAYS.map((w, i) => (
              <th
                key={i}
                scope="col"
                abbr={WEEKDAYS_LONG[i]}
                className="label h-8 font-normal text-subtle"
              >
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: cells.length / 7 }, (_, row) => (
            <tr key={row}>
              {cells.slice(row * 7, row * 7 + 7).map((d, i) => {
                if (!d) return <td key={i} />;
                const off = disabled(d);
                const isStart = shown ? isSameDay(d, shown.start) : false;
                const isEnd = shown ? isSameDay(d, shown.end) : false;
                const inside = shown ? d > shown.start && d < shown.end : false;
                const edge = isStart || isEnd;
                const today = isSameDay(d, max);
                return (
                  <td
                    key={i}
                    role="gridcell"
                    aria-selected={edge || inside}
                    className={cn("h-10 p-0", inside && "bg-hover")}
                  >
                    <button
                      type="button"
                      data-day={d.getTime()}
                      tabIndex={isSameDay(d, tabDay) ? 0 : -1}
                      disabled={off}
                      aria-label={`${WEEKDAYS_LONG[weekdayIndex(d)]} ${formatDate(d)}${today ? ", i dag" : ""}`}
                      onClick={() => pick(d)}
                      onMouseEnter={() => setHover(d)}
                      onFocus={() => {
                        setFocus(d);
                        setHover(d);
                      }}
                      className={cn(
                        "tnum relative flex size-10 w-full items-center justify-center rounded-xs text-sm transition-colors focus-visible:-outline-offset-2",
                        edge
                          ? "bg-inverse font-medium text-on-inverse"
                          : off
                            ? "cursor-not-allowed text-faint"
                            : "text-muted hover:text-fg",
                        inside && "text-fg",
                      )}
                    >
                      {d.getDate()}
                      {today ? (
                        <span
                          aria-hidden
                          className={cn(
                            "absolute bottom-1.5 left-1/2 h-px w-3 -translate-x-1/2",
                            edge ? "bg-on-inverse" : "bg-fg",
                          )}
                        />
                      ) : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-3 grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 gap-y-1 border-t border-line pt-3">
        <dt className="label text-subtle">Från</dt>
        <dd className="meta tnum text-fg">{start ? formatDate(start) : "–"}</dd>
        <dd className="row-span-2 self-center text-right">
          <span className="tnum text-md font-medium text-fg">
            {shown && (end || pendingEnd) ? inclusiveDays(shown.start, shown.end) : "–"}
          </span>
          <span className="label ml-1.5 text-subtle">dagar</span>
        </dd>
        <dt className="label text-subtle">Till</dt>
        <dd className="meta tnum text-fg">
          {end ? formatDate(end) : start ? "välj slutdag" : "–"}
        </dd>
      </dl>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!start || !end}
          onClick={() => start && end && onApply({ start, end })}
        >
          Använd
        </Button>
      </div>
    </div>
  );
}
