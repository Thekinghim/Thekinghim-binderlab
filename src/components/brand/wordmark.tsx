import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

/**
 * Binderlab-symbolen: en pärmrygg, ett kort i fickan och ringen som
 * fäster kortet i ryggen. Tillsammans bildar de ett gement "b".
 *
 * Ritad på ett 16-rutnät med heltalskoordinater och bara fyllda ytor
 * (inga linjer), så att den blir skarp i 16 px. Vid storlekar som inte
 * är en multipel av 16 avrundas varje kant till närmaste hela pixel,
 * så att symbolen förblir pixelexakt i alla storlekar.
 */
export const SYMBOL_GRID = 16;

/** Symbolens geometri i rutnätsenheter. */
export const SYMBOL_PARTS = {
  /** Ryggrad: 3 × 14, från ascender till baslinje */
  spine: { x: 2, y: 1, w: 3, h: 14 },
  /** Kortet: 7 × 10, samlarkortets proportion (63 × 88 mm ≈ 0,7) */
  card: { x: 7, y: 5, w: 7, h: 10 },
  /** Ringen: 2 × 2, fäster kortet i ryggen. Det enda elementet i signalfärg. */
  ring: { x: 5, y: 5, w: 2, h: 2 },
} as const;

/** Friyta X runt ordmärket, i symbolens rutnätsenheter: halva symbolens höjd. */
export const CLEARSPACE_UNITS = 8;

/** Minsta storlek: symbol 12 px på skärm, 4 mm i tryck. */
export const MIN_SYMBOL_PX = 12;

type Rect = { x: number; y: number; w: number; h: number };

/** Avrundar en rektangels kanter till hela pixlar vid given storlek. */
function snap(r: Rect, size: number): Rect {
  const s = size / SYMBOL_GRID;
  const x0 = Math.round(r.x * s) / s;
  const y0 = Math.round(r.y * s) / s;
  const x1 = Math.round((r.x + r.w) * s) / s;
  const y1 = Math.round((r.y + r.h) * s) / s;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

type SymbolProps = {
  /** Kantlängd i px. Standard 16. */
  size?: number;
  /** Allt i currentColor (svartvitt, enfärgstryck, favicon på ljus flik). */
  mono?: boolean;
  className?: string;
  /** Tillgänglig etikett. Utan titel är symbolen dekorativ. */
  title?: string;
  style?: CSSProperties;
};

export function Symbol({ size = 16, mono = false, className, title, style }: SymbolProps) {
  const spine = snap(SYMBOL_PARTS.spine, size);
  const card = snap(SYMBOL_PARTS.card, size);
  const ring = snap(SYMBOL_PARTS.ring, size);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      shapeRendering="crispEdges"
      className={cn("shrink-0", className)}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <rect x={spine.x} y={spine.y} width={spine.w} height={spine.h} />
      <rect x={card.x} y={card.y} width={card.w} height={card.h} />
      <rect
        x={ring.x}
        y={ring.y}
        width={ring.w}
        height={ring.h}
        fill={mono ? "currentColor" : "var(--bl-signal)"}
      />
    </svg>
  );
}

type WordmarkSize = "sm" | "md" | "lg" | "xl";

/**
 * Storlekar. Symbolen är något högre än versalhöjden: ryggraden når
 * ascenderhöjd (b, d, l), kortets överkant ligger på x-höjd. Texten
 * sitter på symbolens baslinje.
 */
const SIZES: Record<WordmarkSize, { symbol: number; text: number; gap: number }> = {
  /** Sidomeny, mobilhuvud */
  sm: { symbol: 16, text: 15, gap: 7 },
  /** Inloggning, dialoger */
  md: { symbol: 20, text: 19, gap: 8 },
  /** Rapportrubrik */
  lg: { symbol: 24, text: 23, gap: 10 },
  /** Specimen, omslag */
  xl: { symbol: 64, text: 62, gap: 22 },
};

type WordmarkProps = {
  size?: WordmarkSize;
  /** Allt i currentColor: ingen signalfärg, ingen grå "lab". */
  mono?: boolean;
  className?: string;
};

/** Symbol + "Binderlab" i Geist Semibold, -0,03 em. */
export function Wordmark({ size = "sm", mono = false, className }: WordmarkProps) {
  const s = SIZES[size];
  // Symbolens nedersta rutnätsenhet är luft; dra ned den så att kortets
  // underkant ligger exakt på textens baslinje.
  const drop = Math.round(s.symbol / SYMBOL_GRID);
  return (
    <span
      className={cn(
        "inline-flex items-baseline font-sans font-semibold whitespace-nowrap",
        className,
      )}
      style={{ gap: s.gap, fontSize: s.text, lineHeight: 1, letterSpacing: "-0.03em" }}
      role="img"
      aria-label="Binderlab"
    >
      <Symbol size={s.symbol} mono={mono} style={{ transform: `translateY(${drop}px)` }} />
      <span aria-hidden>
        Binder<span className={mono ? undefined : "text-muted"}>lab</span>
      </span>
    </span>
  );
}
