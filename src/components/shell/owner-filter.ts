/**
 * Butiksägaren i filtrets butiksval: värdet i listan och etiketten. Rena funktioner, testas
 * i owner-filter.test.ts. Ägaren står i URL:en som ?agare=<id> (OWNER_PARAM); i listan har
 * den värdet "agare:<id>", så att den inte kan förväxlas med en butik.
 */

import type { ShellOwner } from "./owners-context";

const PREFIX = "agare:";

/** Listans värde för en ägare. */
export function ownerOptionValue(id: string): string {
  return `${PREFIX}${id}`;
}

/** Ägarens id ur listans värde, eller null om värdet är en butik. */
export function ownerFromOptionValue(value: string | null): string | null {
  return value && value.startsWith(PREFIX) ? value.slice(PREFIX.length) : null;
}

/** "Godisbolaget Väst AB (3 butiker)". */
export function ownerOptionLabel(owner: Pick<ShellOwner, "name" | "storeIds">): string {
  return `${owner.name} (${owner.storeIds.length} butiker)`;
}

/**
 * Ägarna som val i filtret: bara de med fler än en aktiv butik, i namnordning, med bara
 * butiker som finns i listan.
 */
export function ownerChoices(
  owners: ReadonlyArray<{ id: string; name: string; archived: boolean }>,
  stores: ReadonlyArray<{ id: string; ownerId?: string | null; archived: boolean }>,
): ShellOwner[] {
  return owners
    .filter((o) => !o.archived)
    .map((o) => ({
      id: o.id,
      name: o.name,
      storeIds: stores.filter((s) => !s.archived && s.ownerId === o.id).map((s) => s.id),
    }))
    .filter((o) => o.storeIds.length > 1)
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}
