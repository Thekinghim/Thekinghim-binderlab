/**
 * Håller bottenraden (och det som står ovanför den) i skärmens nederkant på iPhone.
 *
 * WebKit i hemskärmsappen (display: standalone) kan efter tangentbord, systemark (t.ex.
 * frågan om notiser), en tel:-länk eller återkomst från bakgrunden lämna kvar en för kort
 * layoutvy: `window.innerHeight` stannar ungefär en tangentbordshöjd för lågt, och
 * `position: fixed; bottom: 0` ritas då mitt på skärmen. `visualViewport` är ofta lika fel
 * i det läget, så den räcker inte som facit.
 *
 * Därför minns vi den största friska höjden per fönsterbredd (bredden ändras bara när
 * telefonen vrids) och flyttar det fasta innehållet dit med `--v2-vp-shift` (transform, så
 * att träffytan följer det som ritas). I vanliga Safari ändrar verktygsraden höjden på riktigt,
 * så där används bara visualViewport som förut.
 */

export type PinInput = {
  /** Var `position: fixed; bottom: 0` hamnar just nu (en osynlig mätpunkt, utan förskjutning). */
  naturalBottom: number;
  /** visualViewport.offsetTop + visualViewport.height. */
  visibleBottom: number;
  /** Den friska höjden för den här bredden (hemskärmsapp på telefon), annars 0. */
  healthyBottom: number;
  /** visualViewport.scale: inzoomad sida lämnas i fred. */
  scale: number;
  /** Ett textfält har fokus (tangentbordet är uppe): låt raden vara. */
  typing: boolean;
};

/** Förskjutningen (px, heltal) som lägger det fasta innehållets nederkant i skärmens nederkant. */
export function pinShift(i: PinInput): number {
  if (i.naturalBottom <= 0 || i.typing || Math.abs(i.scale - 1) > 0.01) return 0;
  const target = Math.max(i.visibleBottom, i.healthyBottom);
  const shift = Math.round(target - i.naturalBottom);
  // Små avvikelser (avrundning, gummibandsscroll) rättar vi inte; orimliga värden heller inte.
  if (Math.abs(shift) < 2 || Math.abs(shift) > target * 0.6) return 0;
  return shift;
}

export type HealthySample = {
  innerHeight: number;
  visibleBottom: number;
  naturalBottom: number;
  typing: boolean;
  scale: number;
  /** Skärmens längsta sida (screen.width/height): högre än så kan vyn aldrig vara. */
  screenMax: number;
};

/**
 * Nästa friska höjd: den största höjden vi sett för bredden medan ingen skriver. Höjden kan
 * bara växa; en fastnad (för kort) vy ändrar den alltså aldrig.
 */
export function nextHealthy(prev: number, s: HealthySample): number {
  if (s.typing || Math.abs(s.scale - 1) > 0.01) return prev;
  const seen = Math.max(s.innerHeight, s.visibleBottom, s.naturalBottom);
  if (!Number.isFinite(seen) || seen <= 0) return prev;
  const capped = s.screenMax > 0 ? Math.min(seen, s.screenMax) : seen;
  return Math.max(prev, Math.round(capped));
}

/** Sant när vyn är för kort (eller förskjuten) fast ingen skriver: då puffar vi WebKit. */
export function looksStuck(i: {
  innerHeight: number;
  healthyBottom: number;
  offsetTop: number;
  typing: boolean;
}): boolean {
  if (i.typing || i.healthyBottom <= 0) return false;
  return i.innerHeight < i.healthyBottom - 1 || i.offsetTop > 1;
}

/** Sant när tangentbordet syns: man skriver och den synliga vyn är klart kortare än den hela. */
export function keyboardUp(i: { typing: boolean; visibleHeight: number; fullHeight: number }) {
  return i.typing && i.fullHeight > 0 && i.visibleHeight < i.fullHeight - 120;
}

/** Sant när fokus ligger i något man skriver i, då tangentbordet är uppe. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(
      el.type,
    );
  }
  return el instanceof HTMLElement && el.isContentEditable;
}
