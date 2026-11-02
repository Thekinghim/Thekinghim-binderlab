/** Slår ihop klassnamn och hoppar över falska värden. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
