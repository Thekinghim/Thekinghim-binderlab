/**
 * Namnen bakom orderlistans id: titlar, automater och butiker i svensk ordning,
 * rangordningen som både servern (SQL) och tabellen i webbläsaren sorterar efter, och
 * vilka namn ett sökord träffar. Rent och klientsäkert.
 */

import { normalize } from "@/lib/fuzzy";

import type { OrderRefs, TitleOption } from "./types";

/** Samma ordning som DataTable: svensk, numerisk, skiftlägesokänslig. */
const collator = new Intl.Collator("sv-SE", { numeric: true, sensitivity: "base" });

interface TitleIn {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}
interface MachineIn {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface StoreIn {
  readonly id: string;
  readonly name: string;
}

/** Sorterade namnlistor (titlar på namn, automater på kod, butiker på namn). */
export function buildRefs(input: {
  titles: readonly TitleIn[];
  machines: readonly MachineIn[];
  stores: readonly StoreIn[];
}): OrderRefs {
  const by =
    <T>(get: (x: T) => string) =>
    (a: T, b: T) =>
      collator.compare(get(a), get(b));
  return {
    titles: input.titles
      .map((t) => ({ id: t.id, name: t.name, archived: t.archived }))
      .sort(by((t) => t.name)),
    machines: input.machines
      .map((m) => ({ id: m.id, code: m.code, name: m.name }))
      .sort(by((m) => m.code)),
    stores: input.stores.map((s) => ({ id: s.id, name: s.name })).sort(by((s) => s.name)),
  };
}

/** Id i sorteringsordning per namnlista. */
export function sortRanks(refs: OrderRefs): {
  titles: string[];
  machines: string[];
  stores: string[];
} {
  return {
    titles: refs.titles.map((t) => t.id),
    machines: refs.machines.map((m) => m.id),
    stores: refs.stores.map((s) => s.id),
  };
}

/** id → position i listan (för tabellens sortering). */
export function rankMap(items: readonly { id: string }[]): Map<string, number> {
  return new Map(items.map((x, i) => [x.id, i]));
}

function hit(term: string, ...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => t != null && normalize(t).includes(term));
}

/**
 * För varje sökord: titlar, automater (kod eller namn) och butiker vars namn innehåller
 * ordet (skiftläges- och accentokänsligt, å ä ö är egna bokstäver).
 */
export function matchTerms(
  terms: readonly string[],
  refs: OrderRefs,
): Array<{ text: string; titleIds: string[]; machineIds: string[]; storeIds: string[] }> {
  return terms.map((text) => {
    const n = normalize(text);
    return {
      text,
      titleIds: refs.titles.filter((t) => hit(n, t.name)).map((t) => t.id),
      machineIds: refs.machines.filter((m) => hit(n, m.code, m.name)).map((m) => m.id),
      storeIds: refs.stores.filter((s) => hit(n, s.name)).map((s) => s.id),
    };
  });
}

/** Titlarna i titelfiltret: aktiva, plus den valda om den är arkiverad. */
export function titleChoices(
  titles: readonly TitleOption[],
  selected: string | null,
): TitleOption[] {
  return titles.filter((t) => !t.archived || t.id === selected);
}
