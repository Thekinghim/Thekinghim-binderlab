import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Små korsmarkeringar i hörnen, som ett ritbord. Placeras i ett relativt element. */
export function CornerMarks({ inset = -4, size = 7 }: { inset?: number; size?: number }) {
  const pos = [
    { top: inset, left: inset },
    { top: inset, right: inset },
    { bottom: inset, left: inset },
    { bottom: inset, right: inset },
  ];
  return (
    <>
      {pos.map((p, i) => (
        <svg
          key={i}
          aria-hidden
          width={size}
          height={size}
          viewBox="0 0 7 7"
          className="pointer-events-none absolute text-[color:var(--bl-grid-mark)]"
          style={p}
        >
          <path d="M3.5 0v7M0 3.5h7" stroke="currentColor" strokeWidth="1" />
        </svg>
      ))}
    </>
  );
}

type PanelProps = HTMLAttributes<HTMLDivElement> & {
  /** Visa koordinatnät i bakgrunden */
  grid?: boolean | "fine";
  /** Visa korsmarkeringar i hörnen */
  marks?: boolean;
  padded?: boolean;
  children?: ReactNode;
};

/** Grundyta: 1px kant, liten radie, ingen skugga. */
export function Panel({ grid, marks, padded = true, className, children, ...rest }: PanelProps) {
  return (
    <div
      className={cn(
        "relative min-w-0 rounded-md border border-line bg-surface",
        grid && "grid-field",
        grid === "fine" && "grid-field-fine",
        padded && "p-4 md:p-5",
        className,
      )}
      {...rest}
    >
      {marks ? <CornerMarks /> : null}
      {children}
    </div>
  );
}

/** Rubrikrad inuti en panel: monospace-etikett till vänster, metadata till höger. */
export function PanelHeader({
  label,
  meta,
  children,
  className,
}: {
  label: string;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="label text-muted">{label}</span>
      {meta ? <span className="label tnum text-subtle">{meta}</span> : null}
      {children}
    </div>
  );
}
