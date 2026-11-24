/**
 * Håller bottenraden (och det som står ovanför den) i skärmens nederkant på iPhone.
 *
 * WebKit i hemskärmsappen (display: standalone) kan efter tangentbord, systemark (t.ex.
 * frågan om notiser), en tel:-länk eller återkomst från bakgrunden lämna kvar en för kort
 * layoutvy: `window.innerHeight` stannar ungefär en tangentbordshöjd för lågt, och
 * `position: fixed; bottom: 0` ritas då mitt på skärmen. `visualViewport` är ofta lika fel
 * i det läget, så den räcker inte som facit.
 *
 * Därför minns vi den största friska höjden för fönsterbredden (bredden ändras bara när
 * telefonen vrids, och då glöms höjden; se HealthyTracker) och flyttar det fasta innehållet dit med `--v2-vp-shift` (transform, så
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
  innerWidth: number;
  innerHeight: number;
  /** visualViewport.width: skiljer den sig från innerWidth håller vyn på att vridas. */
  vvWidth: number;
  visibleBottom: number;
  naturalBottom: number;
  typing: boolean;
  scale: number;
  /** Skärmens kortaste och längsta sida (screen.width/height, i stående läge på iPhone). */
  screenMin: number;
  screenMax: number;
};

/**
 * Skärmsidan som är höjd i det läge vyn har nu: i liggande läge (bredare än den korta sidan)
 * den korta, annars den långa. 0 när skärmmåtten saknas.
 */
export function screenHeightFor(innerWidth: number, screenMin: number, screenMax: number): number {
  if (!(screenMin > 0) || !(screenMax > 0)) return 0;
  return innerWidth > screenMin + 1 ? screenMin : screenMax;
}

/**
 * En enskild avläsning av vyns höjd, eller null när den inte går att lita på: medan man skriver
 * eller zoomar, och mitt i en vridning (innerWidth och visualViewport.width är inte överens).
 * Avläsningen kapas vid skärmsidan för det aktuella läget, så att en kvarglömd stående höjd
 * aldrig kan bli den friska höjden i liggande läge.
 */
export function healthyReading(s: HealthySample): number | null {
  if (s.typing || Math.abs(s.scale - 1) > 0.01) return null;
  if (Math.round(s.innerWidth) !== Math.round(s.vvWidth)) return null;
  const seen = Math.max(s.innerHeight, s.visibleBottom, s.naturalBottom);
  if (!Number.isFinite(seen) || seen <= 0) return null;
  const side = screenHeightFor(s.innerWidth, s.screenMin, s.screenMax);
  return Math.round(side > 0 ? Math.min(seen, side) : seen);
}

/**
 * Minns den största friska höjden för nuvarande bredd. Höjden kan bara växa, och bara av en
 * avläsning som är likadan två bildrutor i rad (en ensam felaktig bildruta under en vridning
 * lärs alltså aldrig in). Ny bredd, eller `reset()`, glömmer allt.
 */
export class HealthyTracker {
  private value = 0;
  private pending: number | null = null;
  private width = -1;

  /** Den friska höjden för bredden, 0 om vi inte vet. */
  get(innerWidth: number): number {
    return Math.round(innerWidth) === this.width ? this.value : 0;
  }

  reset(): void {
    this.value = 0;
    this.pending = null;
    this.width = -1;
  }

  /**
   * Lägger till en avläsning. `confirm` är sant när en högre höjd väntar på bekräftelse i nästa
   * bildruta: då ska anroparen mäta en gång till.
   */
  sample(s: HealthySample): { healthy: number; confirm: boolean } {
    const w = Math.round(s.innerWidth);
    if (w !== this.width) {
      this.reset();
      this.width = w;
    }
    const r = healthyReading(s);
    if (r === null || r <= this.value) {
      this.pending = null;
      return { healthy: this.value, confirm: false };
    }
    if (this.pending === r) {
      this.value = r;
      this.pending = null;
      return { healthy: this.value, confirm: false };
    }
    this.pending = r;
    return { healthy: this.value, confirm: true };
  }
}

/**
 * Ska den friska höjden glömmas vid den här händelsen? Bara när fönsterbredden faktiskt bytts.
 * En orientationchange med oförändrad bredd (t.ex. medan vyn är fast) får inte glömma: nästa
 * avläsning vore då den fastnade höjden, och den skulle läras in som frisk.
 */
export function forgetsHealthy(
  event: "orientationchange" | "resize",
  lastWidth: number,
  innerWidth: number,
): boolean {
  if (event === "orientationchange") return false;
  return Math.round(lastWidth) !== Math.round(innerWidth);
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
