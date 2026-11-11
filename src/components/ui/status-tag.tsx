import { cn } from "@/lib/cn";

export type Status = "ok" | "warning" | "critical" | "offline" | "neutral";

const labels: Record<Status, string> = {
  ok: "I drift",
  warning: "Varning",
  critical: "Kritisk",
  offline: "Ur drift",
  neutral: "Info",
};

/*
 * Tyngden följer allvaret. Normalläget är tyst så att avvikelserna syns
 * i en kolumn där tio av fjorton rader är "I drift".
 * - ok:       ingen ram, liten kvadrat i subtle, text i muted
 * - neutral:  ingen ram, liten kvadrat, text i muted
 * - warning:  1px ram (kontrollkant), halvfylld kvadrat, text i fg
 * - offline:  streckad ram, streckad kvadrat, text i muted
 * - critical: 1px ram i --bl-signal-line och signalkvadrat, text i fg.
 *             Signalen sitter i ramen och glyfen; texten är vanlig fg
 *             (högsta kontrast). Ingen fyllning och ingen signaltext.
 * Status bärs alltid av form + text, aldrig bara av färg.
 */
const tone: Record<Status, string> = {
  ok: "border-transparent text-muted",
  neutral: "border-transparent text-muted",
  warning: "border-line-control text-fg",
  offline: "border-dashed border-line-control text-muted",
  critical: "border-signal-line text-fg",
};

/** Statusetikett. Höjd 24 px och samma inre luft i alla lägen, så glyferna linjerar i en kolumn. */
export function StatusTag({
  status,
  children,
  className,
  wrap = false,
}: {
  status: Status;
  children?: React.ReactNode;
  className?: string;
  /** Lång text får radbrytas (t.ex. en hel mening i en smal kolumn på mobilen). */
  wrap?: boolean;
}) {
  const quiet = status === "ok" || status === "neutral";
  return (
    <span
      className={cn(
        "label inline-flex items-center gap-1.5 rounded-xs border px-1.5",
        // cn() slår bara ihop klassnamn: en "whitespace-normal" utifrån vinner inte över
        // "whitespace-nowrap" här, så radbrytningen väljs med en egen prop.
        wrap ? "min-h-6 w-fit max-w-full py-0.5 whitespace-normal" : "h-6 whitespace-nowrap",
        tone[status],
        className,
      )}
    >
      <span className={cn("inline-flex w-2 justify-center", quiet && "text-subtle")}>
        <StatusGlyph status={status} size={status === "ok" ? 6 : 8} />
      </span>
      {children ?? labels[status]}
    </span>
  );
}

/**
 * Formen bär status: fylld kvadrat = i drift, halvfylld = varning,
 * signalkvadrat = kritisk, streckad = offline, liten kvadrat = info.
 */
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
