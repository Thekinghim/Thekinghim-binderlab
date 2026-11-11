/**
 * Att göra på Hem i telefonen (under md): alltid nästa sak. Punkterna som gäller nu visas;
 * gäller inget nu visas listans första punkt som "Nästa: …", så att det alltid står vad som
 * ska göras härnäst. Övriga punkter finns ett tryck bort ("Alla N →" till Att göra). Från md
 * visas alla punkter som förut. Rena funktioner, testas i todo-phone.test.ts.
 */

import { formatInt } from "@/lib/format";

import type { HomeTodo } from "./model";
import { kr } from "./text";

export interface HomeTodoPhone {
  /** Punkterna som syns i telefonen (de som gäller nu, i samma ordning). */
  readonly shownKeys: ReadonlySet<string>;
  /** Länkens text i telefonen: "Alla N" när något inte syns, annars "Öppna". */
  readonly linkText: string;
  /**
   * Inget gäller nu men listan har punkter: den första som en rad,
   * "Nästa: Åk till BL-003 senast torsdag · 2 300 kr i risk". Annars null.
   */
  readonly next: { readonly key: string; readonly text: string; readonly href: string } | null;
  /** "Inget brådskande." bara när listan är tom, annars null. */
  readonly emptyText: string | null;
}

export function homeTodoPhone(todos: readonly HomeTodo[], todoCount: number): HomeTodoPhone {
  const now = todos.filter((t) => t.level === "now");
  const first = now.length === 0 ? (todos[0] ?? null) : null;
  const shown = now.length + (first ? 1 : 0);
  return {
    shownKeys: new Set(now.map((t) => t.key)),
    linkText: todoCount > shown ? `Alla ${formatInt(todoCount)}` : "Öppna",
    next: first
      ? {
          key: first.key,
          text: `Nästa: ${first.title}${
            first.atStakeOre != null && first.atStakeOre > 0
              ? ` · ${kr(first.atStakeOre)} i risk`
              : ""
          }`,
          href: first.href,
        }
      : null,
    emptyText: todos.length === 0 ? "Inget brådskande." : null,
  };
}

/** Rubriken med summan: "Att göra · 5 · 8 034 kr i risk" (utan summa när inget står i risk). */
export function homeTodoHeading(todoCount: number, stakeOre: number): string {
  return `Att göra · ${formatInt(todoCount)}${stakeOre > 0 ? ` · ${kr(stakeOre)} i risk` : ""}`;
}

/** Länkens text från md (som förut): "Alla N" när listan är kapad, annars "Öppna". */
export function homeTodoLinkText(shown: number, todoCount: number): string {
  return todoCount > shown ? `Alla ${formatInt(todoCount)}` : "Öppna";
}
