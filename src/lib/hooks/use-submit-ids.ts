import { useMemo, useRef } from "react";

/** Ett nytt v4-id (randomUUID finns bara i säkra sammanhang; getRandomValues överallt). */
export function newSubmitId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Minnet bakom useSubmitIds (ren, testbar utan React). */
export function submitIds(make: () => string = newSubmitId) {
  const ids = new Map<string, string>();
  return {
    /** Samma innehåll (`key`) ger samma id tills `done()` anropats. */
    idFor(key: string): string {
      let id = ids.get(key);
      if (!id) {
        id = make();
        ids.set(key, id);
      }
      return id;
    },
    /** Svaret kom fram och allt är sparat: nästa inskick är ett nytt. */
    done(): void {
      ids.clear();
    },
  };
}

/**
 * Id för ett formulärs inskick, så att servern aldrig sparar samma sak två gånger.
 *
 * Formuläret skickar `idFor(innehållet)` med varje inskick. Kommer svaret aldrig fram
 * (telefonen tappade nätet) och användaren trycker igen går samma id en gång till, och
 * servern svarar med det den redan sparat. Efter ett sparat svar anropas `done()`.
 */
export function useSubmitIds() {
  const ref = useRef<ReturnType<typeof submitIds> | null>(null);
  return useMemo(
    () => ({
      idFor: (key: string) => (ref.current ??= submitIds()).idFor(key),
      done: () => ref.current?.done(),
    }),
    [],
  );
}
