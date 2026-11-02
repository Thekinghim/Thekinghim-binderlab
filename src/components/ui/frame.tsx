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

/**
 * Ytans form.
 * - "panel": 1px kant, radie 6 px, bg-surface. En verklig gruppering.
 * - "bare": ingen kant, radie eller fyllning; bara padding. Standard för
 *   komponentexempel och för allt som redan står i en panel.
 */
export type PanelVariant = "panel" | "bare";

type PanelProps = HTMLAttributes<HTMLDivElement> & {
  variant?: PanelVariant;
  /** Visa koordinatnät i bakgrunden. Bara på utvalda ytor. */
  grid?: boolean | "fine";
  /** Visa korsmarkeringar i hörnen (kräver variant="panel") */
  marks?: boolean;
  padded?: boolean;
  children?: ReactNode;
};

/*
 * Regler mot ramar i ramar:
 * 1. Högst en kant per djupnivå och högst två nivåer kanter totalt.
 * 2. En panel inuti en panel ritar ingen egen ram: den blir en avdelning
 *    med en 1px linje överst, utan radie, fyllning eller sidopadding.
 *    Det sker automatiskt via data-frame="panel" på närmaste förälder.
 * 3. Linjen överst ritas bara när den skiljer två innehåll åt. Den
 *    utelämnas när den inre panelen
 *    - står i en PanelSection: PanelSection är avdelaren, inre Panel
 *      ritar ingen egen linje,
 *    - är första barnet i panelen (panelens kant ligger redan där),
 *    - följer direkt efter en PanelHeader (rubriken är avgränsningen).
 * 4. Underavsnitt i en panel skrivs med PanelSection, inte med nya paneler.
 * 5. KpiCard släpper sin kant i en panel. KpiStrip som står direkt i en
 *    panel går ut till panelens kanter, så att avdelarna möter ramen; dess
 *    linje överst/underst utelämnas när den är första/sista barnet.
 */
const nestedPanel = [
  "in-data-[frame=panel]:rounded-none in-data-[frame=panel]:border-x-0 in-data-[frame=panel]:border-b-0 in-data-[frame=panel]:bg-transparent",
  "in-data-[frame=panel]:px-0 in-data-[frame=panel]:pb-0 md:in-data-[frame=panel]:px-0 md:in-data-[frame=panel]:pb-0",
  // Regel 3. Selektorerna har attributspecificitet och vinner över p-4/md:p-5.
  "[[data-frame=panel]_[data-frame=section]_&]:border-t-0 [[data-frame=panel]_[data-frame=section]_&]:pt-0",
  "[[data-frame=panel]>&:first-child]:border-t-0 [[data-frame=panel]>&:first-child]:pt-0",
  "[[data-frame=panel]>svg+&]:border-t-0 [[data-frame=panel]>svg+&]:pt-0",
  "[[data-frame=panel]>[data-slot=panel-header]+&]:border-t-0",
].join(" ");

/** Grundyta: 1px kant, radie 6 px, ingen skugga. variant="bare" för ytor utan kant. */
export function Panel({
  variant = "panel",
  grid,
  marks,
  padded = true,
  className,
  children,
  ...rest
}: PanelProps) {
  const framed = variant === "panel";
  return (
    <div
      data-frame={framed ? "panel" : "bare"}
      data-padded={padded ? "" : undefined}
      className={cn(
        "relative min-w-0",
        framed && "rounded-md border border-line bg-surface",
        framed && nestedPanel,
        grid && "grid-field",
        grid === "fine" && "grid-field-fine",
        padded && "p-4 md:p-5",
        className,
      )}
      {...rest}
    >
      {marks && framed ? <CornerMarks /> : null}
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
    <div
      data-slot="panel-header"
      className={cn("flex items-center justify-between gap-3", className)}
    >
      <span className="label text-muted">{label}</span>
      {meta ? <span className="label tnum text-subtle">{meta}</span> : null}
      {children}
    </div>
  );
}

/**
 * Underavsnitt utan egen ram: står direkt på ytan, skiljs från föregående
 * avsnitt av en 1px linje och 32 px luft (40 px från md). Det första
 * avsnittet i en grupp ritar ingen linje. PanelSection är avdelaren: en
 * Panel inuti den ritar varken ram eller egen linje.
 */
export function PanelSection({
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
    <section
      data-frame="section"
      className={cn(
        "flex min-w-0 flex-col gap-4 border-t border-line pt-4",
        "not-first:mt-8 first:border-t-0 first:pt-0 md:not-first:mt-10",
        className,
      )}
    >
      <PanelHeader label={label} meta={meta} />
      {children}
    </section>
  );
}
