import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { storeFace, type StoreGlyph } from "./visual-math";

/** Symbolerna (24×24, streck i currentColor). card…kiosk är mockens (Butiker). */
const GLYPHS: Record<StoreGlyph, ReactNode> = {
  card: (
    <>
      <rect x="4.5" y="3.5" width="11" height="15" rx="2" transform="rotate(-10 10 11)" />
      <rect x="9" y="5.5" width="11" height="15" rx="2" transform="rotate(8 14.5 13)" />
      <path d="M13.6 11.2l1.2 2.2 2.3.4-1.7 1.6.4 2.3-2.1-1.1" transform="rotate(8 14.5 13)" />
    </>
  ),
  reel: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="7.2" r="1.7" />
      <circle cx="16.6" cy="10.5" r="1.7" />
      <circle cx="14.8" cy="15.9" r="1.7" />
      <circle cx="9.2" cy="15.9" r="1.7" />
      <circle cx="7.4" cy="10.5" r="1.7" />
    </>
  ),
  pin: (
    <>
      <path d="M12 2.8c1.6 0 2.4 1.3 2.4 3 0 1.3-.7 2.2-.7 3.2 0 1.4 2.6 3.6 2.6 7.4 0 2.6-1.3 4.8-4.3 4.8s-4.3-2.2-4.3-4.8c0-3.8 2.6-6 2.6-7.4 0-1-.7-1.9-.7-3.2 0-1.7.8-3 2.4-3z" />
      <path d="M10.1 8.4h3.8M10.3 10.2h3.4" />
    </>
  ),
  bag: (
    <>
      <path d="M5.5 8h13l-1 12.5h-11z" />
      <path d="M9 10V6.5a3 3 0 016 0V10" />
    </>
  ),
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="8.6" cy="8.6" r=".9" fill="currentColor" />
      <circle cx="15.4" cy="8.6" r=".9" fill="currentColor" />
      <circle cx="12" cy="12" r=".9" fill="currentColor" />
      <circle cx="8.6" cy="15.4" r=".9" fill="currentColor" />
      <circle cx="15.4" cy="15.4" r=".9" fill="currentColor" />
    </>
  ),
  blocks: (
    <>
      <rect x="4" y="12" width="7.5" height="7.5" rx="1.2" />
      <rect x="12.5" y="12" width="7.5" height="7.5" rx="1.2" />
      <rect x="8.2" y="4.5" width="7.5" height="7.5" rx="1.2" />
      <path d="M11.9 6.6v3.3M6.6 14.6h2.3M15 14.6h2.4" />
    </>
  ),
  kiosk: (
    <>
      <path d="M4 9.5l1.5-5h13l1.5 5" />
      <path d="M4 9.5c0 1.3 1 2.2 2.7 2.2s2.6-1 2.6-2.2c0 1.3 1 2.2 2.7 2.2s2.7-1 2.7-2.2c0 1.3.9 2.2 2.6 2.2S20 10.8 20 9.5" />
      <path d="M5.5 12v8h13v-8M10 20v-4.5h4V20" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.5c-1.8-1.3-4.3-1.8-7.5-1.5v13c3.2-.3 5.7.2 7.5 1.5 1.8-1.3 4.3-1.8 7.5-1.5V5c-3.2-.3-5.7.2-7.5 1.5z" />
      <path d="M12 6.5v13" />
    </>
  ),
  wave: (
    <>
      <path d="M3.5 10c1.4 0 1.4-1.2 2.8-1.2S7.7 10 9.1 10s1.4-1.2 2.8-1.2S13.3 10 14.7 10s1.4-1.2 2.8-1.2S18.9 10 20.5 10" />
      <path d="M3.5 14.5c1.4 0 1.4-1.2 2.8-1.2s1.4 1.2 2.8 1.2 1.4-1.2 2.8-1.2 1.4 1.2 2.8 1.2 1.4-1.2 2.8-1.2 1.4 1.2 3 1.2" />
      <path d="M3.5 19c1.4 0 1.4-1.2 2.8-1.2S7.7 19 9.1 19s1.4-1.2 2.8-1.2S13.3 19 14.7 19s1.4-1.2 2.8-1.2S18.9 19 20.5 19" />
    </>
  ),
  fuel: (
    <>
      <rect x="4.5" y="4" width="9" height="16" rx="1.5" />
      <path d="M7 7.5h4M13.5 10h2a1.5 1.5 0 011.5 1.5v5a1.5 1.5 0 003 0V9l-2.5-2.5" />
      <path d="M3.5 20h11" />
    </>
  ),
  game: (
    <>
      <path d="M7.5 8h9a4 4 0 014 4.4l-.5 3.6a2.4 2.4 0 01-4.2 1.2L14 15h-4l-1.8 2.2A2.4 2.4 0 014 16l-.5-3.6A4 4 0 017.5 8z" />
      <path d="M8 10.5v3M6.5 12h3" />
      <circle cx="15.5" cy="11" r=".9" fill="currentColor" />
      <circle cx="17" cy="13" r=".9" fill="currentColor" />
    </>
  ),
};

export type StoreFaceSize = "xs" | "sm" | "md" | "lg";

/**
 * Butikens symbol: en mjuk ruta i stadens färg med en symbol för butikstypen, eller två
 * initialer när typen saknas eller är okänd. Samma butik ser alltid likadan ut (stad → färg är
 * en hash, typ → symbol ett nyckelordsval i visual-math.ts). Dekor: namnet står alltid bredvid,
 * så rutan är aria-hidden.
 *
 * Storlekar: xs 22 (små listor), sm 28, md 36 (tabellrader; 42 på telefon), lg 64 (butikskortets
 * huvud, med vit ring).
 */
export function StoreFace({
  name,
  storeType,
  city,
  size = "md",
  className,
}: {
  name: string | null | undefined;
  storeType?: string | null;
  city?: string | null;
  size?: StoreFaceSize;
  className?: string;
}) {
  const face = storeFace({ name, storeType, city });
  return (
    <span
      aria-hidden="true"
      className={cn("v2-sface", size !== "md" && size, className)}
      style={{ "--sf-bg": face.bg, "--sf-fg": face.fg } as CSSProperties}
      data-glyph={face.glyph ?? undefined}
    >
      {face.glyph ? (
        <svg viewBox="0 0 24 24" focusable="false">
          {GLYPHS[face.glyph]}
        </svg>
      ) : (
        <span className="v2-sface-ini">{face.initials}</span>
      )}
    </span>
  );
}
