/**
 * Är ändringen av ett antal så stor att den troligen är felskriven (en nolla för mycket,
 * eller fältet tömt)? Då frågar Vårt lager innan den sparas. Minst 50 pack och minst
 * hälften av det som stod: 162 → 1620 och 162 → 0 frågar, 162 → 120 och 5 → 40 sparas direkt.
 */
export function isBigCountChange(from: number, to: number): boolean {
  const diff = Math.abs(to - from);
  return diff >= 50 && diff >= Math.abs(from) / 2;
}
