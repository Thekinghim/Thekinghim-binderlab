/** Sidan på den kvadratiska bild som skickas till Awish (Awish visar högst 600×600). */
export const SQUARE_SIDE = 600;

/**
 * Var bilden ska ritas i en kvadrat utan att sträckas: hela bilden syns, i mitten, med samma
 * proportioner. Awish gör alltid om bilden till en kvadrat (400×400); en avlång bild blir annars
 * utdragen.
 */
export function fitInSquare(
  width: number,
  height: number,
  side: number = SQUARE_SIDE,
): { x: number; y: number; w: number; h: number } {
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, w: side, h: side };
  const scale = Math.min(side / width, side / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { x: Math.floor((side - w) / 2), y: Math.floor((side - h) / 2), w, h };
}
