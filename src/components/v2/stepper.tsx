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
  lessLabel,
  moreLabel,
  inputId,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Vad som räknas ("Black Bolt"), för skärmläsare. */
  label: string;
  className?: string;
  /** Knapparnas namn (standard "Ett mindre: <label>" / "Ett till: <label>"). */
  lessLabel?: string;
  moreLabel?: string;
  /**
   * Med id: talet är ett inmatningsfält (siffror från tangentbordet, namn = label), annars
   * bara visning. Tillagt för Fyll på (G2); utan det ritas stegaren som förut.
   */
  inputId?: string;
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
      aria-label={
        dir < 0 ? (lessLabel ?? `Ett mindre: ${label}`) : (moreLabel ?? `Ett till: ${label}`)
      }
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
      {inputId ? (
        <StepperInput
          id={inputId}
          value={value}
          min={min}
          max={max}
          label={label}
          onChange={(n) => {
            valueRef.current = n;
            onChange(n);
          }}
        />
      ) : (
        <output aria-live="polite" aria-label={label} data-zero={value === 0 ? "" : undefined}>
          {value}
        </output>
      )}
      {button(1)}
    </span>
  );
}

/**
 * Det man skrivit i fältet, städat: bara siffror, inga inledande nollor ("007" → "7"), och ett
 * tal över max blir max. `value` är talet att skicka vidare, eller null när fältet är tomt (då
 * ändras inget förrän man skriver en siffra; lämnar man det tomt gäller det förra talet).
 */
export function stepperDraft(
  raw: string,
  min: number,
  max: number,
): { draft: string; value: number | null } {
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (digits === "") return { draft: "", value: null };
  const n = Math.max(min, Math.min(max, Number(digits)));
  return { draft: n === Number(digits) ? digits : String(n), value: n };
}

/**
 * Stegarens sifferfält. Textfält med sifferknappsats (inputMode numeric), inte type="number":
 * där blev "05" kvar, tomt blev 0 direkt medan man suddade, och iPhone markerade inte talet
 * vid fokus. Medan man skriver får fältet vara tomt; när man lämnar det visas talet igen.
 */
function StepperInput({
  id,
  value,
  min,
  max,
  label,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
}) {
  // null: man skriver inte just nu, fältet visar talet.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      enterKeyHint="done"
      value={draft ?? String(value)}
      aria-label={label}
      data-zero={value === 0 && !draft ? "" : undefined}
      onFocus={(e) => {
        // Markera talet så att nästa siffra ersätter det (select() direkt räcker inte på iPhone).
        const el = e.currentTarget;
        requestAnimationFrame(() => {
          if (document.activeElement === el) el.setSelectionRange(0, el.value.length);
        });
      }}
      onChange={(e) => {
        const next = stepperDraft(e.target.value, min, max);
        setDraft(next.draft);
        if (next.value !== null && next.value !== value) onChange(next.value);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
