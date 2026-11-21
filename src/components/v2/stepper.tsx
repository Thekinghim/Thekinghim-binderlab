"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

/**
 * −/+ med håll-för-att-upprepa (Fyll på, Räkna lagret). Ett tryck = ett steg; håll kvar och
 * det upprepas efter 400 ms, allt snabbare. Knapparna är 44 × 44 px (tryckyta).
 */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  label,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Vad som räknas ("Black Bolt"), för skärmläsare. */
  label: string;
  className?: string;
}) {
  const [held, setHeld] = useState<-1 | 1 | null>(null);
  const valueRef = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHeld(null);
  }, []);
  useEffect(() => stop, [stop]);

  const bump = useCallback(
    (dir: -1 | 1) => {
      const next = Math.max(min, Math.min(max, valueRef.current + dir * step));
      if (next === valueRef.current) return false;
      valueRef.current = next;
      onChange(next);
      return true;
    },
    [min, max, step, onChange],
  );

  const start = (dir: -1 | 1) => {
    if (!bump(dir)) return;
    setHeld(dir);
    let delay = 400;
    const tick = () => {
      if (!bump(dir)) return stop();
      delay = Math.max(50, delay * 0.8);
      timer.current = setTimeout(tick, delay);
    };
    timer.current = setTimeout(tick, delay);
  };

  const button = (dir: -1 | 1) => (
    <button
      type="button"
      aria-label={`${dir < 0 ? "Ett mindre" : "Ett till"}: ${label}`}
      disabled={dir < 0 ? value <= min : value >= max}
      data-held={held === dir ? "" : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start(dir);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          bump(dir);
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {dir < 0 ? "−" : "+"}
    </button>
  );

  return (
    <span className={cn("v2-step", className)}>
      {button(-1)}
      <output aria-live="polite" aria-label={label} data-zero={value === 0 ? "" : undefined}>
        {value}
      </output>
      {button(1)}
    </span>
  );
}
