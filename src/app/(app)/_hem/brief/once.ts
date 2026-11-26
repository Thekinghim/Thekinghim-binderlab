/**
 * "En gång per dag" för Dagens brief: dagen rutan senast visades sparas per användare i
 * webbläsaren (localStorage, per enhet). Går lagringen inte att läsa eller skriva (privat
 * läge, spärrad) räknas det i stället per besök: högst en gång tills sidan laddas om.
 */

const PREFIX = "binderlab:dagens-brief:";

/** Händelsen som öppnar rutan (knappen Dagens brief på Hem). */
export const BRIEF_OPEN_EVENT = "binderlab:dagens-brief";

/** Visad i det här besöket (när lagringen inte fungerar). */
let shownThisVisit = false;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function store(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Dagens datum (ÅÅÅÅ-MM-DD) i tidszonen. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Har rutan redan visats i dag för användaren? */
export function seenToday(
  userKey: string,
  day: string,
  s: KeyValueStore | null = store(),
): boolean {
  if (shownThisVisit) return true;
  if (!s) return false;
  try {
    return s.getItem(PREFIX + userKey) === day;
  } catch {
    return false;
  }
}

/** Kom ihåg att rutan visats i dag. */
export function markSeen(userKey: string, day: string, s: KeyValueStore | null = store()): void {
  try {
    if (!s) throw new Error("ingen lagring");
    s.setItem(PREFIX + userKey, day);
  } catch {
    shownThisVisit = true;
  }
}

/** Bara för testerna. */
export function resetVisitForTests(): void {
  shownThisVisit = false;
}
