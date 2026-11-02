import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

/**
 * Binderlab-symbolen: en pärmrygg, ett kort i fickan och ringen som
 * fäster kortet i ryggen vid baslinjen. Tillsammans bildar de ett gement
 * "b": stammen och bågen möts nedtill, öppningen mellan dem pekar uppåt.
 *
 * Ritad på ett 16-rutnät med heltalskoordinater och bara fyllda ytor
 * (inga linjer), så att den blir skarp i 16 px. Vid storlekar som inte
 * är en multipel av 16 avrundas varje kant till närmaste hela pixel,
 * så att symbolen förblir pixelexakt i alla storlekar.
 */
export const SYMBOL_GRID = 16;

/** Symbolens geometri i rutnätsenheter. */
export const SYMBOL_PARTS = {
  /** Ryggrad: 3 × 13, från ascenderhöjd till baslinje */
  spine: { x: 2, y: 2, w: 3, h: 13 },
  /** Kortet: 7 × 10, samlarkortets proportion (63 × 88 mm ≈ 0,7). Överkant på x-höjd. */
  card: { x: 7, y: 5, w: 7, h: 10 },
  /**
   * Ringen: 2 × 2 vid baslinjen, fäster kortet i ryggen och sluter b:et
   * nedtill. Enda elementet i signalfärg; i enfärg får den samma färg som
   * resten och formen är oförändrad.
   */
  ring: { x: 5, y: 13, w: 2, h: 2 },
} as const;

/** Friyta X runt ordmärket, i symbolens rutnätsenheter: halva symbolens höjd. */
export const CLEARSPACE_UNITS = 8;

/** Minsta storlek: symbol 12 px på skärm, 4 mm i tryck. */
export const MIN_SYMBOL_PX = 12;

/**
 * Ringen ritas i signalfärg först från 28 px (rapporthuvud, omslag). Mindre
 * än så blir den en orange fläck på 1–2 px som läses som ett larm bredvid
 * menyns räknare, så under gränsen är hela symbolen i textfärgen.
 */
export const SIGNAL_RING_MIN_PX = 28;

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
  /** Allt i currentColor, även ringen (svartvitt, enfärgstryck). Alltid så under 28 px. */
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
        fill={mono || size < SIGNAL_RING_MIN_PX ? "currentColor" : "var(--bl-signal)"}
      />
    </svg>
  );
}

type WordmarkSize = "sm" | "md" | "lg" | "xl";

/**
 * Storlekar i px. Textstorleken är vald efter symbolen så att de linjerar
 * optiskt i Geist Semibold (versal- och ascenderhöjd 0,71 em, x-höjd
 * 0,54 em): ryggradens överkant når ascenderhöjden (B, b, l), kortets
 * överkant ligger på x-höjden och kortets underkant på baslinjen.
 * text ≈ symbol × (13 / 16) / 0,71 ≈ symbol × 1,14.
 */
export const WORDMARK_SIZES: Record<
  WordmarkSize,
  { symbol: number; text: number; gap: number; use: string }
> = {
  sm: { symbol: 16, text: 18, gap: 7, use: "Sidomeny" },
  md: { symbol: 20, text: 23, gap: 8, use: "Inloggning, e-post" },
  lg: { symbol: 24, text: 28, gap: 10, use: "Rapportrubrik" },
  xl: { symbol: 64, text: 73, gap: 24, use: "Omslag" },
};

type WordmarkProps = {
  size?: WordmarkSize;
  /** Allt i currentColor: ingen signalfärg, ingen grå "lab". */
  mono?: boolean;
  className?: string;
};

/** Symbol + "Binderlab" i Geist Semibold, -0,03 em. */
export function Wordmark({ size = "sm", mono = false, className }: WordmarkProps) {
  const s = WORDMARK_SIZES[size];
  // Symbolens baslinje (kortets underkant) efter avrundning till hel pixel.
  // Raden under den är luft; dra ned symbolen så att baslinjerna sammanfaller.
  const { card } = SYMBOL_PARTS;
  const bottom = Math.round(((card.y + card.h) * s.symbol) / SYMBOL_GRID);
  const drop = s.symbol - bottom;
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
