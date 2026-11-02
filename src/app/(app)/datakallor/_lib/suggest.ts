/**
 * Förslag på automat för en okänd källautomat. Awish-namnet ("Order Machine")
 * börjar oftast med vår kod, t.ex. "BL-001 ICA Lund" för BL-001. Förslaget är
 * bara ett förval i listan; användaren bekräftar alltid kopplingen.
 */

export interface SuggestableMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

function fold(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("sv-SE").replace(/\s+/g, " ").trim();
}

/** Koden som ett eget ord (inte "BL-0011" för "BL-001"). */
function containsToken(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : haystack.charAt(at - 1);
    const after = haystack.charAt(at + needle.length);
    const boundary = (c: string) => c === "" || !/[\p{L}\p{N}]/u.test(c);
    if (boundary(before) && boundary(after)) return true;
    from = at + 1;
  }
}

/**
 * Automaten vars kod står i källans namn (som eget ord). Står flera koder där vinner
 * den längsta. Annars en automat vars namn är exakt källans namn. Annars null.
 */
export function suggestMachine(
  externalName: string | null,
  machines: readonly SuggestableMachine[],
): string | null {
  if (!externalName) return null;
  const name = fold(externalName);
  let best: SuggestableMachine | null = null;
  for (const m of machines) {
    const code = fold(m.code);
    if (containsToken(name, code) && (!best || code.length > fold(best.code).length)) {
      best = m;
    }
  }
  if (best) return best.id;
  const exact = machines.filter((m) => fold(m.name) === name || fold(`${m.code} ${m.name}`) === name);
  return exact.length === 1 ? (exact[0]?.id ?? null) : null;
}
