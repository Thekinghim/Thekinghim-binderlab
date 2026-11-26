/**
 * Håll en kontroll på samma plats på skärmen medan sidan under och ovanför den byts ut
 * (ett periodval under kort som får nya höjder när den nya perioden kommer).
 * Chrome gör det själv (scroll anchoring); Safari på iPhone gör det inte, så sidan hoppade och
 * knappen man just tryckte på försvann ur bild.
 *
 * Läget mäts när man trycker. Varje gång sidans höjd ändras (ResizeObserver) rullas sidan med
 * skillnaden, tills personen själv rör sidan (finger, hjul, tangent) eller tiden är ute.
 */

/** Hur mycket sidan ska rullas för att kontrollen ska stå där den stod (0 = stå still). */
export function scrollFix(before: number, now: number): number {
  const d = now - before;
  return Math.abs(d) < 1 ? 0 : Math.round(d);
}

// pointerdown: ett klick (mus, finger, penna) eller ett grepp i rullningslisten betyder att
// personen tar över. Utan den kunde ett klick på en länk inom 8 s följas av att sidan rullades
// tillbaka när den nya sidan växte.
const STOP_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Börja hålla `el` på plats. Returnerar en funktion som slutar. Slutar också av sig själv
 * efter `ms` (servern kan ta några sekunder på sig) eller när personen rullar själv.
 */
export function keepInPlace(el: HTMLElement, ms = 8000): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const before = el.getBoundingClientRect().top;
  const fix = () => {
    if (!el.isConnected) {
      stop();
      return;
    }
    const dy = scrollFix(before, el.getBoundingClientRect().top);
    if (dy !== 0) window.scrollBy(0, dy);
  };
  const ro = new ResizeObserver(fix);
  const root = el.closest<HTMLElement>("[data-v2-page]") ?? document.body;
  ro.observe(root);
  const timer = window.setTimeout(() => stop(), ms);
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    ro.disconnect();
    window.clearTimeout(timer);
    for (const e of STOP_EVENTS) window.removeEventListener(e, stop);
  }
  for (const e of STOP_EVENTS) window.addEventListener(e, stop, { passive: true });
  return stop;
}
