/**
 * Raderna i Att göra utanför reglerna (Awish-kontot, ny automat, bokföringen) som Hem visar dem. Ren
 * funktion: texterna kommer från Att göras extraTodos, så att Hem och Att göra säger samma.
 */

import { extraTodos } from "../att-gora/_lib/model";
import { monthText } from "../ekonomi/_lib/view";
import type { HomeExtraTodo } from "./model";

/** Vart raderna utanför reglerna leder (samma knappar som överst på Att göra). */
const EXTRA_HREF: Record<string, string> = {
  "awish-expiry": "/datakallor",
  "new-machines": "/att-gora",
  bokforing: "/ekonomi?vy=bokforing",
};

/** Raderna utanför reglerna som Hem visar dem, med samma texter som Att göra. */
export function homeExtraTodos(input: {
  bokforingMonth: string | null;
  newMachines: number;
  awishExpiry?: { text: string; level: "now" | "soon" } | null;
  /** Startklar-raden (readinessTodo): texten och formuläret för nästa steg. */
  startklar?: { title: string; href: string } | null;
}): HomeExtraTodo[] {
  return extraTodos({
    bokforingMonth: input.bokforingMonth ? monthText(input.bokforingMonth) : null,
    newMachines: input.newMachines,
    awishExpiry: input.awishExpiry ?? null,
    startklar: input.startklar ?? null,
  }).map((e) => ({
    ...e,
    href:
      e.key === "startklar" && input.startklar
        ? input.startklar.href
        : (EXTRA_HREF[e.key] ?? "/att-gora"),
  }));
}
