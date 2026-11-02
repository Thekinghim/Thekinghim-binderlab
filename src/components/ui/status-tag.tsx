import { cn } from "@/lib/cn";

export type Status = "ok" | "warning" | "critical" | "offline" | "neutral";

const labels: Record<Status, string> = {
  ok: "I drift",
  warning: "Varning",
  critical: "Kritisk",
  offline: "Offline",
  neutral: "Info",
};

/**
 * Statusetikett. Status bärs av form + text, inte bara färg:
 * fylld kvadrat = i drift, halvfylld = varning, signalfärgad
 * fylld kvadrat + kant = kritisk, streckad = offline.
 */
export function StatusTag({
  status,
  children,
  className,
}: {
  status: Status;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "label inline-flex h-6 items-center gap-1.5 rounded-xs border px-1.5 whitespace-nowrap",
        status === "critical"
          ? "border-signal/60 bg-signal-soft text-signal-fg"
          : status === "offline"
            ? "border-dashed border-line-control text-subtle"
            : "border-line-strong text-muted",
        className,
      )}
    >
      <StatusGlyph status={status} />
      {children ?? labels[status]}
    </span>
  );
}

export function StatusGlyph({ status, size = 8 }: { status: Status; size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 8 8" aria-hidden className="shrink-0">
      {status === "ok" ? <rect x="0" y="0" width="8" height="8" fill="currentColor" /> : null}
      {status === "warning" ? (
        <>
          <rect x="0.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" />
          <path d="M0.5 7.5 L7.5 0.5 L7.5 7.5Z" fill="currentColor" />
        </>
      ) : null}
      {status === "critical" ? (
        <rect x="0" y="0" width="8" height="8" fill="var(--bl-signal)" />
      ) : null}
      {status === "offline" ? (
        <rect
          x="0.5"
          y="0.5"
          width="7"
          height="7"
          fill="none"
          stroke="currentColor"
          strokeDasharray="2 1.5"
        />
      ) : null}
      {status === "neutral" ? <rect x="2" y="2" width="4" height="4" fill="currentColor" /> : null}
    </svg>
  );
}
