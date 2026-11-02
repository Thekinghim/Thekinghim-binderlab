"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

/** Läser det faktiska värdet av en CSS-variabel i sitt lägessammanhang. */
function useCssVar(name: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setValue(getComputedStyle(el).getPropertyValue(name).trim());
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [name]);
  return [ref, value] as const;
}

function Swatch({ token, name, note }: { token: string; name: string; note?: string }) {
  const [ref, value] = useCssVar(token);
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-line py-2.5 last:border-b-0">
      <span
        ref={ref}
        className="size-8 shrink-0 rounded-xs border border-line-strong"
        style={{ background: `var(${token})` }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base">{name}</span>
        <span className="label truncate tracking-normal text-subtle normal-case">{token}</span>
      </div>
      <span className="label tnum shrink-0 text-muted">{value || " "}</span>
      {note ? <span className="sr-only">{note}</span> : null}
    </div>
  );
}

const colorGroups: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "Ytor",
    items: [
      ["--bl-bg", "Bakgrund"],
      ["--bl-surface", "Yta"],
      ["--bl-surface-raised", "Upphöjd yta"],
      ["--bl-surface-hover", "Hover"],
    ],
  },
  {
    title: "Linjer",
    items: [
      ["--bl-line", "Hårfin"],
      ["--bl-line-strong", "Stark"],
      ["--bl-line-control", "Formulärkant 3:1"],
      ["--bl-grid", "Rutnät"],
    ],
  },
  {
    title: "Text",
    items: [
      ["--bl-fg", "Primär"],
      ["--bl-fg-muted", "Dämpad"],
      ["--bl-fg-subtle", "Diskret"],
      ["--bl-fg-faint", "Dekor (ej text)"],
    ],
  },
  {
    title: "Signal",
    items: [
      ["--bl-signal", "Signal"],
      ["--bl-signal-fg", "Signal som text"],
      ["--bl-signal-soft", "Signal, svag"],
      ["--bl-focus", "Fokus"],
    ],
  },
];

export function ColorSpecimen({ theme }: { theme: "dark" | "light" }) {
  return (
    <div data-theme={theme} className="rounded-md border border-line bg-bg p-4 md:p-5">
      <div className="mb-4 flex items-center justify-between">
        <span className="label text-fg">{theme === "dark" ? "Mörkt läge" : "Ljust läge"}</span>
        <span className="label text-subtle">{theme === "dark" ? "Primärt" : "Sekundärt"}</span>
      </div>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {colorGroups.map((g) => (
          <div key={g.title}>
            <p className="label mb-1 text-subtle">{g.title}</p>
            {g.items.map(([t, n]) => (
              <Swatch key={t} token={t} name={n} />
            ))}
          </div>
        ))}
      </div>
      <p className="label mt-5 mb-2 text-subtle">Dataramp</p>
      <div className="flex gap-1">
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex h-8">
            {[
              "--bl-data-0",
              "--bl-data-5",
              "--bl-data-4",
              "--bl-data-3",
              "--bl-data-2",
              "--bl-data-1",
            ].map((t) => (
              <span
                key={t}
                className="flex-1 border-y border-line first:border-l last:border-r"
                style={{ background: `var(${t})` }}
              />
            ))}
          </div>
          <div className="flex justify-between">
            <span className="label text-[10px] text-subtle">data-0 · lägst</span>
            <span className="label text-[10px] text-subtle">data-1 · högst</span>
          </div>
        </div>
        <div className="flex w-14 shrink-0 flex-col gap-1">
          <span className="h-8" style={{ background: "var(--bl-signal)" }} />
          <span className="label text-right text-[10px] text-signal-fg">signal</span>
        </div>
      </div>
    </div>
  );
}

const typeScale: Array<{
  token: string;
  spec: string;
  className: string;
  sample: string;
  mono?: boolean;
}> = [
  {
    token: "display",
    spec: "64 / 64 / −4 %",
    className: "text-display font-medium",
    sample: "128 640 kr",
  },
  {
    token: "3xl",
    spec: "44 / 48 / −3 %",
    className: "text-3xl font-medium",
    sample: "Försäljning per automat",
  },
  {
    token: "2xl",
    spec: "32 / 36 / −2,5 %",
    className: "text-2xl font-medium",
    sample: "Intäkt per dag.",
  },
  {
    token: "xl",
    spec: "24 / 32 / −2 %",
    className: "text-xl font-medium",
    sample: "Lagret räcker 9 dagar till.",
  },
  {
    token: "lg",
    spec: "20 / 28 / −1,5 %",
    className: "text-lg font-medium",
    sample: "Påfyllning BL-010 Westfield Arninge",
  },
  {
    token: "md",
    spec: "16 / 24",
    className: "text-md",
    sample: "Brödtext för förklaringar och beskrivningar.",
  },
  {
    token: "base",
    spec: "14 / 20",
    className: "text-base",
    sample: "Standard i tabeller, formulär och menyer.",
  },
  {
    token: "sm",
    spec: "13 / 20",
    className: "text-sm text-muted",
    sample: "Sekundär text och hjälptexter.",
  },
  {
    token: "label",
    spec: "11 / 16 / +8 % MONO",
    className: "label text-muted",
    sample: "01 / Försäljning · Senast synk 14:32",
    mono: true,
  },
];

export function TypeSpecimen() {
  return (
    <div className="flex flex-col">
      {typeScale.map((t) => (
        <div
          key={t.token}
          className="grid grid-cols-1 items-baseline gap-1 border-b border-line py-4 first:pt-0 md:grid-cols-[160px_1fr] md:gap-6"
        >
          <div className="flex items-baseline gap-3 md:flex-col md:gap-0.5">
            <span className="label text-fg">{t.token}</span>
            <span className="label tnum text-subtle">{t.spec}</span>
          </div>
          <p className={cn(t.className, "min-w-0 truncate")}>{t.sample}</p>
        </div>
      ))}
    </div>
  );
}

export function SpacingSpecimen() {
  const steps = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20];
  return (
    <div className="flex flex-col gap-2">
      {steps.map((s) => (
        <div key={s} className="grid grid-cols-[56px_48px_1fr] items-center gap-3">
          <span className="label tnum text-fg">{s}</span>
          <span className="label tnum text-subtle">{s * 4}px</span>
          <span className="h-2 bg-data-3" style={{ width: s * 4 }} />
        </div>
      ))}
      <p className="mt-2 text-sm text-muted">
        Bas 4px, rytm i 8px. Halvsteg (4, 12) endast inuti komponenter. Sektioner skiljs med
        64–80px.
      </p>
    </div>
  );
}

export function RadiusSpecimen() {
  const radii: Array<[string, string]> = [
    ["xs", "2px · etiketter, markörer"],
    ["sm", "4px · knappar, fält"],
    ["md", "6px · paneler, modaler"],
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {radii.map(([r, d]) => (
        <div key={r} className="flex flex-col gap-2">
          <span
            className={cn(
              "h-16 border border-line-control bg-raised",
              r === "xs" ? "rounded-xs" : r === "sm" ? "rounded-sm" : "rounded-md",
            )}
          />
          <span className="label text-fg">{r}</span>
          <span className="text-xs text-subtle">{d}</span>
        </div>
      ))}
    </div>
  );
}

export function MotionSpecimen() {
  const [on, setOn] = useState(false);
  const rows: Array<[string, string, string]> = [
    ["fast", "120ms", "Hover, färgbyten"],
    ["base", "150ms", "Segment, växlar"],
    ["slow", "180ms", "Modal, toast in"],
    ["count", "420ms", "Siffror vid periodbyte"],
  ];
  return (
    <div className="flex flex-col gap-3">
      {rows.map(([n, ms, use]) => (
        <div key={n} className="grid grid-cols-[56px_56px_1fr] items-center gap-3">
          <span className="label text-fg">{n}</span>
          <span className="label tnum text-subtle">{ms}</span>
          <div className="relative h-5 border-b border-line">
            <span
              className="absolute bottom-0 size-2.5 bg-fg"
              style={{
                left: on ? "calc(100% - 10px)" : 0,
                transition: `left ${ms} var(--bl-ease)`,
              }}
            />
            <span className="absolute -bottom-5 left-0 text-xs text-subtle">{use}</span>
          </div>
        </div>
      ))}
      <div className="mt-6 flex items-center gap-3">
        <Button size="sm" onClick={() => setOn((v) => !v)}>
          Spela upp
        </Button>
        <span className="label text-subtle">ease cubic-bezier(0.2, 0, 0, 1)</span>
      </div>
    </div>
  );
}
