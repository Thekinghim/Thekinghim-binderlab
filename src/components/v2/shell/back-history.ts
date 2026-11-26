/**
 * Sidorna man har gått igenom i appen sedan den laddades (bara sökvägar), så att
 * tillbaka-pilen vet om router.back() stannar i appen. I hemskärmsappen på iPhone finns
 * ingen webbläsarknapp: backar man ur historiken händer ingenting, så då går pilen till
 * föräldersidan i stället.
 *
 * Gissningen bygger på sökvägen: kommer man till sidan före den senaste räknas det som ett
 * steg bakåt, annars som ett nytt steg. Listan finns bara i minnet (börjar om vid omladdning).
 */

/** Nästa lista när sökvägen blir `path`. */
export function nextHistory(stack: readonly string[], path: string): string[] {
  if (stack[stack.length - 1] === path) return [...stack];
  if (stack.length >= 2 && stack[stack.length - 2] === path) return stack.slice(0, -1);
  // Taket håller listan liten; bara längden ≥ 2 spelar roll.
  return [...stack, path].slice(-50);
}

let history: string[] = [];

/** Skalet anropar vid varje sidbyte. */
export function recordPath(path: string): void {
  history = nextHistory(history, path);
}

/** Finns en sida i appen före den här att backa till? */
export function canGoBackInApp(): boolean {
  return history.length >= 2;
}

/** Bara för tester. */
export function resetHistoryForTests(): void {
  history = [];
}
