"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";
import { StatusGlyph, type Status } from "./status-tag";

export type ToastInput = {
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

/** Skärmläsartexterna (regionen och krysset); rotlayouten ger språket ur kakan. */
const LABELS = {
  sv: { region: "Notiser", close: "Stäng notis" },
  en: { region: "Notifications", close: "Close notification" },
} as const;

export function ToastProvider({
  children,
  locale = "sv",
}: {
  children: ReactNode;
  locale?: keyof typeof LABELS;
}) {
  const labels = LABELS[locale];
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
        aria-label={labels.region}
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[380px]"
      >
        {items.map((t) => (
          <ToastView
            key={t.id}
            item={t}
            onDismiss={() => dismiss(t.id)}
            closeLabel={labels.close}
          />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

function ToastView({
  item,
  onDismiss,
  closeLabel,
}: {
  item: ToastItem;
  onDismiss: () => void;
  closeLabel: string;
}) {
  const [paused, setPaused] = useState(false);
  const duration = item.duration ?? 5000;
  // onDismiss är en ny funktion vid varje rendering av listan (t.ex. när sidan räknas om
  // efter en server action). Den läses via en ref så att timern inte startar om då.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => dismissRef.current(), duration);
    return () => clearTimeout(t);
  }, [paused, duration]);

  return (
    <ToastCard
      item={item}
      onDismiss={onDismiss}
      progressMs={paused ? undefined : duration}
      onPause={setPaused}
      closeLabel={closeLabel}
    />
  );
}

/**
 * Notisens yta. ToastProvider ritar den med tidtagning; som statiskt exempel
 * (t.ex. på /design) ritas den utan förlopp och utan stängknapp.
 */
export function ToastCard({
  item,
  onDismiss,
  progressMs,
  onPause,
  className,
  closeLabel = "Stäng notis",
}: {
  item: ToastInput;
  onDismiss?: () => void;
  /** Förloppslinjens längd. Utelämnas: ingen linje. */
  progressMs?: number;
  onPause?: (paused: boolean) => void;
  className?: string;
  /** Krysset (skärmläsare). Standard svenska. */
  closeLabel?: string;
}) {
  const tone = item.tone ?? "neutral";
  const live = Boolean(onDismiss);
  return (
    <div
      role={live ? (tone === "critical" ? "alert" : "status") : undefined}
      onMouseEnter={onPause ? () => onPause(true) : undefined}
      onMouseLeave={onPause ? () => onPause(false) : undefined}
      onFocus={onPause ? () => onPause(true) : undefined}
      onBlur={onPause ? () => onPause(false) : undefined}
      className={cn(
        "pointer-events-auto relative w-full overflow-hidden rounded-md border bg-raised p-3.5",
        live && "animate-enter pr-10",
        tone === "critical" ? "border-signal-line" : "border-line-strong",
        className,
      )}
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
              {item.meta ? <span className="meta tnum text-subtle">{item.meta}</span> : null}
              {item.action ? (
                <button
                  type="button"
                  onClick={() => {
                    item.action?.onClick();
                    onDismiss?.();
                  }}
                  // Mobil: osynlig träffyta på minst 44 px runt ordet (t.ex. "Ångra"), som krysset.
                  className="label relative text-fg underline decoration-line-control underline-offset-4 transition-[text-decoration-color] duration-fast hover:decoration-fg max-md:after:absolute max-md:after:-inset-x-2 max-md:after:-inset-y-3.5 max-md:after:content-['']"
                >
                  {item.action.label}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={closeLabel}
          // Mobil: osynlig träffyta på 44 px runt krysset.
          className="absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-xs text-subtle transition-colors duration-fast hover:bg-hover hover:text-fg max-md:after:absolute max-md:after:-inset-2.5 max-md:after:content-['']"
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
      {progressMs !== undefined ? (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-px origin-left animate-toast-progress bg-line-control"
          style={{ "--toast-dur": `${progressMs}ms` } as CSSProperties}
        />
      ) : null}
    </div>
  );
}
