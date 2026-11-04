/**
 * Att göra på Hem i telefonen (under md): bara punkterna som gäller nu, så att listan är
 * kort. Övriga punkter finns ett tryck bort ("Alla N →" till Att göra). Från md visas alla
 * punkter som förut. Ren funktion, testas i todo-phone.test.ts.
 */

import { formatInt } from "@/lib/format";

import type { HomeTodo } from "./model";

export interface HomeTodoPhone {
  /** Punkterna som syns i telefonen (de som gäller nu, i samma ordning). */
  readonly shownKeys: ReadonlySet<string>;
  /** Länkens text i telefonen: "Alla N" när något inte syns, annars "Öppna". */
  readonly linkText: string;
  /** Raden när inget gäller nu men det finns punkter, annars null. */
  readonly emptyText: string | null;
}

export function homeTodoPhone(todos: readonly HomeTodo[], todoCount: number): HomeTodoPhone {
  const now = todos.filter((t) => t.level === "now");
  const hidden = todoCount - now.length;
  return {
    shownKeys: new Set(now.map((t) => t.key)),
    linkText: hidden > 0 ? `Alla ${formatInt(todoCount)}` : "Öppna",
    emptyText: now.length === 0 && todoCount > 0 ? "Inget brådskande." : null,
  };
}

/** Länkens text från md (som förut): "Alla N" när listan är kapad, annars "Öppna". */
export function homeTodoLinkText(shown: number, todoCount: number): string {
  return todoCount > shown ? `Alla ${formatInt(todoCount)}` : "Öppna";
}
