/**
 * Håller bottenraden i skärmens nederkant på iPhone.
 *
 * Safari (särskilt som hemskärmsapp) kan efter tangentbord, ark eller återkomst från
 * bakgrunden lämna kvar en för kort "layoutvy". Då ritas `position: fixed; bottom: 0`
 * mitt på skärmen, ungefär en tangentbordshöjd för högt. Vi mäter var raden faktiskt
 * hamnar och flyttar den med `transform` till den synliga vyns nederkant.
 */

export type PinInput = {
  /** Radens nederkant enligt getBoundingClientRect, med nuvarande förskjutning inräknad. */
  rectBottom: number;
  /** Förskjutningen som redan ligger på raden (px). */
  currentShift: number;
  /** Radens höjd; 0 betyder dold (dator) och då rör vi inget. */
  rectHeight: number;
  /** visualViewport.offsetTop + visualViewport.height. */
  visibleBottom: number;
  /** visualViewport.scale: inzoomad sida lämnas i fred. */
  scale: number;
  /** Ett textfält har fokus (tangentbordet är uppe): låt raden vara. */
  typing: boolean;
};

/** Förskjutningen (px, heltal) som lägger radens nederkant i den synliga vyns nederkant. */
export function pinShift(i: PinInput): number {
  if (i.rectHeight <= 0 || i.typing || Math.abs(i.scale - 1) > 0.01) return 0;
  const naturalBottom = i.rectBottom - i.currentShift;
  const shift = Math.round(i.visibleBottom - naturalBottom);
  // Små avvikelser (avrundning, gummibandsscroll) rättar vi inte; orimliga värden heller inte.
  if (Math.abs(shift) < 2 || Math.abs(shift) > i.visibleBottom) return 0;
  return shift;
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
