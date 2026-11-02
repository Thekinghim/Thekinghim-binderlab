"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";
import { StatusGlyph, type Status } from "./status-tag";

type ToastInput = {
  title: string;
  description?: string;
  tone?: Extract<Status, "ok" | "neutral" | "critical">;
  /** Monospace-metadata, t.ex. maskin-id eller tid */
  meta?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
};

type ToastItem = ToastInput & { id: number };

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast måste användas inuti <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setItems((xs) => [...xs.slice(-2), { ...t, id }]);
  }, []);
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <section
        aria-label="Notiser"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[380px]"
      >
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const duration = item.duration ?? 5000;

  useEffect(() => {
    if (paused) return;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [paused, duration, onDismiss]);

  const tone = item.tone ?? "neutral";
  return (
    <div
      role={tone === "critical" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        "pointer-events-auto relative w-full overflow-hidden rounded-md border bg-raised p-3.5 pr-10",
        tone === "critical" ? "border-signal/60" : "border-line-strong",
      )}
      style={{ animation: "bl-enter var(--bl-dur-slow) var(--bl-ease)" }}
    >
      <div className="flex gap-3">
        <span className={cn("mt-1.5", tone === "critical" ? "" : "text-muted")}>
          <StatusGlyph status={tone} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-base font-medium">{item.title}</p>
          {item.description ? <p className="text-sm text-muted">{item.description}</p> : null}
          {item.meta || item.action ? (
            <div className="mt-1 flex items-center gap-3">
              {item.meta ? <span className="label tnum text-subtle">{item.meta}</span> : null}
              {item.action ? (
                <button
                  type="button"
                  onClick={() => {
                    item.action?.onClick();
                    onDismiss();
                  }}
                  className="label text-fg underline decoration-line-control underline-offset-4 hover:decoration-fg"
                >
                  {item.action.label}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Stäng notis"
        className="absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-xs text-subtle hover:bg-hover hover:text-fg"
      >
        <Icon name="close" size={12} />
      </button>
      {!paused ? (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-px bg-line-control"
          style={{ animation: `bl-progress ${duration}ms linear forwards` }}
        />
      ) : null}
    </div>
  );
}
