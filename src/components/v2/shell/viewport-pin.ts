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
 * telefonen vrids, och då glöms höjden; se HealthyTracker) och flyttar det fasta innehållet dit
 * med `--v2-vp-shift` (transform, så att träffytan följer det som ritas), men bara när glappet
 * är stort som ett tangentbord (STUCK_MIN_GAP). En felaktig avläsning i storlek med statusraden
 * kan alltså aldrig skjuta raden under skärmkanten. I vanliga Safari ändrar verktygsraden
 * höjden på riktigt, så där används bara visualViewport som förut.
 */

/**
 * Minsta glapp (px) mellan den friska höjden och var det fasta innehållet hamnar som räknas som
 * en fastnad vy. Felet vi rättar är en tangentbordshöjd (250–350 px). Glapp i storlek med
 * statusraden (~60 px) eller hemindikatorn (34 px) kommer i stället av en felaktig avläsning,
 * och att följa dem skjuter raden under skärmkanten: dem rättar vi aldrig.
 */
export const STUCK_MIN_GAP = 100;

/**
 * Så länge (ms) samstämmiga avläsningar ska hålla i sig innan en lägre frisk höjd lärs om
 * (se HealthyTracker).
 */
export const RELEARN_MS = 1500;

export type PinInput = {
  /** Var `position: fixed; bottom: 0` hamnar just nu (en osynlig mätpunkt, utan förskjutning). */
  naturalBottom: number;
  /** visualViewport.offsetTop + visualViewport.height. */
  visibleBottom: number;
  /** visualViewport.offsetTop (används bara i hemskärmsappen). */
  visibleTop: number;
  /** Den friska höjden för den här bredden (hemskärmsapp på telefon), annars 0. */
  healthyBottom: number;
  /** visualViewport.scale: inzoomad sida lämnas i fred. */
  scale: number;
  /** Ett textfält har fokus (tangentbordet är uppe): låt raden vara. */
  typing: boolean;
  /**
   * Hemskärmsapp på telefon (den friska höjden lärs in). Då flyttas raden bara nedåt, och bara
   * när glappet är stort som ett tangentbord. Annars (vanliga Safari) gäller visualViewport.
   */
  learned: boolean;
  /** Sidan gummibandsscrollar förbi kanten: offsetTop säger då inget om en fastnad vy. */
  overscroll: boolean;
};

export type PinDecision = {
  /** Förskjutningen som sätts (px, heltal). */
  shift: number;
  /** Hur långt ovanför målet det fasta innehållet hamnar (px), även när inget flyttas. */
  gap: number;
};

/** Förskjutningen (px, heltal) som lägger det fasta innehållets nederkant i skärmens nederkant. */
export function pinShift(i: PinInput): number {
  return pinDecision(i).shift;
}

/**
 * Som pinShift, men säger också hur stort glappet var. Hemskärmsappen: målet är den friska
 * höjden (eller visualViewport.height om den är högre). offsetTop räknas bara med när den är
 * stor som ett tangentbord och sidan inte gummibandsscrollar: en liten offsetTop (t.ex. 59 px
 * efter återkomst eller ett gummiband) sköt annars raden under skärmen. Ett glapp mindre än
 * STUCK_MIN_GAP flyttas aldrig, så en för stor inlärd höjd (852 i stället för 793) kan inte
 * trycka ut raden.
 */
export function pinDecision(i: PinInput): PinDecision {
  if (i.naturalBottom <= 0 || i.typing || Math.abs(i.scale - 1) > 0.01) return { shift: 0, gap: 0 };
  if (!i.learned) {
    // Vanliga Safari (och iPad): som förut.
    const target = Math.max(i.visibleBottom, i.healthyBottom);
    const shift = Math.round(target - i.naturalBottom);
    // Små avvikelser (avrundning, gummibandsscroll) rättar vi inte; orimliga värden heller inte.
    if (Math.abs(shift) < 2 || Math.abs(shift) > target * 0.6) return { shift: 0, gap: shift };
    return { shift, gap: shift };
  }
  const top = Number.isFinite(i.visibleTop) ? i.visibleTop : 0;
  const offsetCounts = !i.overscroll && top >= STUCK_MIN_GAP;
  const visible = offsetCounts ? i.visibleBottom : i.visibleBottom - top;
  const target = Math.max(visible, i.healthyBottom);
  const gap = Math.round(target - i.naturalBottom);
  if (gap < STUCK_MIN_GAP || gap > target * 0.6) return { shift: 0, gap };
  return { shift: gap, gap };
}

export type HealthySample = {
  innerWidth: number;
  innerHeight: number;
  /** visualViewport.width: skiljer den sig från innerWidth håller vyn på att vridas. */
  vvWidth: number;
  /**
   * visualViewport.height, utan offsetTop: vi lär oss höjder, inte var den synliga vyn slutar.
   * En kvarglömd offsetTop efter tangentbordet skulle annars läras in som en för stor höjd.
   */
  vvHeight: number;
  /** visualViewport.offsetTop: bara samstämmiga avläsningar utan offset får sänka höjden. */
  vvTop: number;
  naturalBottom: number;
  typing: boolean;
  scale: number;
  /**
   * Ett ark (vaul) är öppet eller body är position: fixed: mätningen kan ändras av arket, så
   * inget lärs in eller om medan det pågår.
   */
  blocked: boolean;
  /** Tidpunkt (ms, t.ex. performance.now()). */
  now: number;
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
 * eller zoomar, medan ett ark är öppet, och mitt i en vridning (innerWidth och
 * visualViewport.width är inte överens). Höjden är den största av innerHeight,
 * visualViewport.height och mätpunkten som minst en av de andra håller med om (inom 2 px): en
 * ensam avvikande källa lärs aldrig in. Avläsningen kapas vid skärmsidan för det aktuella
 * läget, så att en kvarglömd stående höjd aldrig kan bli den friska höjden i liggande läge.
 */
export function healthyReading(s: HealthySample): number | null {
  if (s.typing || s.blocked || Math.abs(s.scale - 1) > 0.01) return null;
  if (Math.round(s.innerWidth) !== Math.round(s.vvWidth)) return null;
  const xs = [s.innerHeight, s.vvHeight, s.naturalBottom].map((n) =>
    Number.isFinite(n) && n > 0 ? n : 0,
  );
  let seen = 0;
  xs.forEach((a, i) => {
    if (a > seen && xs.some((b, j) => j !== i && b > 0 && Math.abs(a - b) <= 2)) seen = a;
  });
  if (seen <= 0) return null;
  const side = screenHeightFor(s.innerWidth, s.screenMin, s.screenMax);
  return Math.round(side > 0 ? Math.min(seen, side) : seen);
}

/**
 * Höjden när vyn uppenbart står still och mår bra: alla tre källorna är överens (inom 2 px),
 * ingen offsetTop, ingen skriver eller zoomar, inget ark. Annars null.
 */
export function calmReading(s: HealthySample): number | null {
  const r = healthyReading(s);
  if (r === null || Math.abs(s.vvTop) > 1) return null;
  const xs = [s.innerHeight, s.vvHeight, s.naturalBottom];
  if (Math.max(...xs) - Math.min(...xs) > 2) return null;
  return r;
}

/**
 * Minns den största friska höjden för nuvarande bredd. Höjden växer bara av en avläsning som
 * är likadan två bildrutor i rad (en ensam felaktig bildruta under en vridning lärs alltså
 * aldrig in). Ny bredd, eller `reset()`, glömmer allt.
 *
 * Höjden kan också sjunka, men bara till en lugn avläsning (calmReading) som legat stilla i
 * RELEARN_MS och ligger mindre än STUCK_MIN_GAP under den inlärda. En fastnad vy (en
 * tangentbordshöjd för kort) lärs alltså aldrig in, medan en för stor höjd från en enstaka
 * avläsning vid återkomst (852 i stället för 793) glöms inom ett par sekunder.
 */
export class HealthyTracker {
  private value = 0;
  private pending: number | null = null;
  private width = -1;
  private calm: number | null = null;
  private calmSince = 0;

  /** Den friska höjden för bredden, 0 om vi inte vet. */
  get(innerWidth: number): number {
    return Math.round(innerWidth) === this.width ? this.value : 0;
  }

  reset(): void {
    this.value = 0;
    this.pending = null;
    this.width = -1;
    this.calm = null;
    this.calmSince = 0;
  }

  /**
   * Lägger till en avläsning. `confirm` är sant när en högre höjd väntar på bekräftelse i nästa
   * bildruta: då ska anroparen mäta en gång till. `recheck` är sant när en lägre höjd väntar på
   * att ha legat stilla i RELEARN_MS: då ska anroparen mäta igen efter så lång tid.
   * `relearned` är sant i den avläsning där höjden sänktes.
   */
  sample(s: HealthySample): {
    healthy: number;
    confirm: boolean;
    recheck: boolean;
    relearned: boolean;
  } {
    const w = Math.round(s.innerWidth);
    if (w !== this.width) {
      this.reset();
      this.width = w;
    }
    let recheck = false;
    let relearned = false;
    const calm = calmReading(s);
    if (
      calm !== null &&
      this.value > 0 &&
      calm < this.value - 1 &&
      this.value - calm < STUCK_MIN_GAP
    ) {
      if (this.calm !== null && Math.abs(this.calm - calm) <= 1) {
        if (s.now - this.calmSince >= RELEARN_MS) {
          this.value = calm;
          this.calm = null;
          this.pending = null;
          relearned = true;
        } else {
          recheck = true;
        }
      } else {
        this.calm = calm;
        this.calmSince = s.now;
        recheck = true;
      }
    } else {
      this.calm = null;
    }
    const r = healthyReading(s);
    if (r === null || r <= this.value) {
      this.pending = null;
      return { healthy: this.value, confirm: false, recheck, relearned };
    }
    if (this.pending === r) {
      this.value = r;
      this.pending = null;
      this.calm = null;
      return { healthy: this.value, confirm: false, recheck: false, relearned };
    }
    this.pending = r;
    return { healthy: this.value, confirm: true, recheck, relearned };
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

/**
 * Sant när vyn är för kort (en tangentbordshöjd, se STUCK_MIN_GAP) eller förskjuten fast ingen
 * skriver: då puffar vi WebKit.
 */
export function looksStuck(i: {
  innerHeight: number;
  healthyBottom: number;
  offsetTop: number;
  typing: boolean;
}): boolean {
  if (i.typing || i.healthyBottom <= 0) return false;
  return i.innerHeight <= i.healthyBottom - STUCK_MIN_GAP || i.offsetTop > 1;
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
