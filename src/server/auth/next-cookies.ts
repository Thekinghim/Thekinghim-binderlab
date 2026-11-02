import "server-only";

import { cookies } from "next/headers";

import type { CookieJar } from "./types";

/**
 * Next:s cookies() som CookieJar. I serverkomponenter går det inte att skriva
 * cookies; då ignoreras set/delete (proxyn förnyar Supabase-sessionen i
 * stället, och server actions kan skriva).
 */
export async function nextCookieJar(): Promise<CookieJar> {
  const store = await cookies();
  return {
    get: (name) => store.get(name)?.value,
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    set: (name, value, options) => {
      try {
        store.set(name, value, options);
      } catch {
        // Serverkomponent: cookies kan inte skrivas här.
      }
    },
    delete: (name) => {
      try {
        store.delete(name);
      } catch {
        // Serverkomponent: cookies kan inte skrivas här.
      }
    },
  };
}
