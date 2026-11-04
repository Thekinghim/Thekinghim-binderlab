/**
 * Raderna i Att göra utanför reglerna (ny automat, bokföringen) som Hem visar dem. Ren
 * funktion: texterna kommer från Att göras extraTodos, så att Hem och Att göra säger samma.
 */

import { extraTodos } from "../att-gora/_lib/model";
import { monthText } from "../ekonomi/_lib/view";
import type { HomeExtraTodo } from "./model";

/** Vart raderna utanför reglerna leder (samma knappar som överst på Att göra). */
const EXTRA_HREF: Record<string, string> = {
  "new-machines": "/att-gora",
  bokforing: "/ekonomi?vy=bokforing",
};

/** Raderna utanför reglerna som Hem visar dem, med samma texter som Att göra. */
export function homeExtraTodos(input: {
  bokforingMonth: string | null;
  newMachines: number;
}): HomeExtraTodo[] {
  return extraTodos({
    bokforingMonth: input.bokforingMonth ? monthText(input.bokforingMonth) : null,
    newMachines: input.newMachines,
  }).map((e) => ({ ...e, href: EXTRA_HREF[e.key] ?? "/att-gora" }));
}
