"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { formatDate, formatMonth } from "@/lib/format";
import { addDays, endOfMonth, isSameDay, normalizePeriod, startOfMonth } from "@/lib/period";
import type { DateRange } from "@/components/shell/period-state";

const WEEKDAYS = ["M", "T", "O", "T", "F", "L", "S"] as const;
const WEEKDAYS_LONG = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

/** Måndag = 0 … söndag = 6. */
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Alltid sex veckor (42 rutor): kalendern har samma höjd varje månad, så att arket och
 *  knapparna under den inte hoppar när man bläddrar. */
export function monthGrid(month: Date): Array<Date | null> {
  const first = startOfMonth(month);
  const last = endOfMonth(month);
  const cells: Array<Date | null> = Array.from({ length: weekdayIndex(first) }, () => null);
  for (let d = 1; d <= last.getDate(); d++) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  }
  while (cells.length < 42) cells.push(null);
  return cells;
}

function clamp(d: Date, min: Date, max: Date): Date {
  return d < min ? min : d > max ? max : d;
}

/** Ett utkast till intervall: start vald, slut ännu inte (null) eller båda. */
export type RangeDraft = { start: Date | null; end: Date | null };

/**
 * Intervallkalender i V2: en månad i taget, två tryck (första och sista dagen, i valfri
 * ordning). Piltangenter flyttar en dag eller vecka, PageUp/PageDown en månad, Home/End till
 * veckans början och slut. Bara den fokuserade dagen ligger i tabbordningen. Kontrollerad:
 * `value` och `onChange` (föräldern äger utkastet, så att datumfälten och kalendern följs åt).
 */
export function RangeCalendar({
  value,
  onChange,
  min,
  max,
  className,
}: {
  value: RangeDraft;
  onChange: (next: RangeDraft) => void;
  /** Första valbara dag. */
  min: Date;
  /** Sista valbara dag (i dag). */
  max: Date;
  className?: string;
}) {
  const { start, end } = value;
  const [hover, setHover] = useState<Date | null>(null);
  const [focus, setFocus] = useState<Date>(() => end ?? start ?? max);
  const [month, setMonth] = useState<Date>(() => startOfMonth(end ?? start ?? max));
  const gridRef = useRef<HTMLTableElement>(null);
  // Ett nytt värde utifrån (datumfälten, ett snabbval) visar sin månad.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    const target = value.end ?? value.start;
    if (
      target &&
      (target.getMonth() !== month.getMonth() || target.getFullYear() !== month.getFullYear())
    ) {
      setMonth(startOfMonth(target));
      setFocus(target);
    }
  }

  const cells = useMemo(() => monthGrid(month), [month]);
  const pendingEnd = start && !end ? hover : null;
  const shown = start ? normalizePeriod({ start, end: end ?? pendingEnd ?? start }) : null;
  const disabled = (d: Date) => d > max || d < min;

  const pick = (d: Date) => {
    if (disabled(d)) return;
    if (!start || end) onChange({ start: d, end: null });
    else onChange(normalizePeriod({ start, end: d }));
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
      const target = new Date(
        focus.getFullYear(),
        focus.getMonth() + (e.key === "PageUp" ? -1 : 1),
        1,
      );
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
  const canPrev = endOfMonth(prevMonth) >= min;
  const canNext = nextMonth <= max;
  const focusInMonth =
    focus.getMonth() === month.getMonth() && focus.getFullYear() === month.getFullYear();
  const tabDay = focusInMonth ? focus : clamp(startOfMonth(month), min, max);

  return (
    <div className={cn("v2-cal", className)}>
      <div className="v2-cal-hd">
        <button
          type="button"
          className="v2-btn ico quiet"
          aria-label="Föregående månad"
          disabled={!canPrev}
          onClick={() => setMonth(prevMonth)}
        >
          <Chevron dir="left" />
        </button>
        <p aria-live="polite">{formatMonth(month)}</p>
        <button
          type="button"
          className="v2-btn ico quiet"
          aria-label="Nästa månad"
          disabled={!canNext}
          onClick={() => setMonth(nextMonth)}
        >
          <Chevron dir="right" />
        </button>
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-label={`Välj intervall, ${formatMonth(month)}`}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setHover(null)}
      >
        <thead>
          <tr>
            {WEEKDAYS.map((w, i) => (
              <th key={i} scope="col" abbr={WEEKDAYS_LONG[i]}>
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
                const today = isSameDay(d, max);
                return (
                  <td
                    key={i}
                    role="gridcell"
                    aria-selected={isStart || isEnd || inside}
                    className={cn(
                      inside && "in",
                      isStart && "s",
                      isEnd && "e",
                      shown && !isSameDay(shown.start, shown.end) && (isStart || isEnd) && "span",
                    )}
                  >
                    <button
                      type="button"
                      data-day={d.getTime()}
                      tabIndex={isSameDay(d, tabDay) ? 0 : -1}
                      disabled={off}
                      aria-label={`${WEEKDAYS_LONG[weekdayIndex(d)]} ${formatDate(d)}${today ? ", i dag" : ""}`}
                      aria-current={today ? "date" : undefined}
                      onClick={() => pick(d)}
                      // Förhandsvisningen följer bara musen: på en pekskärm skickar WebKit
                      // låtsade mushändelser vid tryck, och då fastnade visningen.
                      onPointerEnter={(e) => {
                        if (e.pointerType === "mouse") setHover(d);
                      }}
                      onFocus={() => {
                        setFocus(d);
                        setHover(d);
                      }}
                    >
                      {d.getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

/** Intervallet i utkastet, eller null när slutdagen saknas. */
export function draftRange(d: RangeDraft): DateRange | null {
  return d.start && d.end ? normalizePeriod({ start: d.start, end: d.end }) : null;
}
