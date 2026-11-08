/**
 * "Ny version av appen finns": logiken utan webbläsare (testas i app-version.test.ts).
 *
 * Sidan vet vilket bygge den laddades med; /api/version säger vilket servern kör nu. Är de
 * olika finns en ny version. Då visas alltid en ruta med knappen Uppdatera. Appen laddar
 * bara om av sig själv när den öppnas igen efter en stund i bakgrunden, inget är ifyllt och
 * ett tidigare försök inte redan misslyckats (så att den aldrig laddar om i en slinga).
 */

import { isBuildId } from "@/lib/build-id";

/** Varför versionen kontrolleras. */
export type CheckTrigger =
  /** Sidan har just laddats. */
  | "load"
  /** Appen öppnades igen efter en stund i bakgrunden (eller ur bfcache). */
  | "resume"
  /** Var femte minut, när appen syns, eller när nätet kommer tillbaka. */
  | "interval";

export type UpdateDecision = "none" | "banner" | "auto";

/** Ett försök att uppdatera (sparas i sessionStorage före omladdningen). */
export interface UpdateAttempt {
  /** Bygget som sidan hade före omladdningen. */
  from: string;
  /** Bygget som servern körde. */
  to: string;
  /** När (ms sedan 1970). */
  at: number;
  /** Antal automatiska omladdningar i den här sessionen. */
  autoCount: number;
}

/** Så länge ett misslyckat försök räknas: under den tiden laddar appen inte om själv igen. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** Högst så många automatiska omladdningar per session, vad som än händer. */
export const MAX_AUTO_RELOADS = 2;
/** Så länge appen ska ha legat i bakgrunden för att räknas som "öppnad igen". */
export const RESUME_AFTER_HIDDEN_MS = 30_000;
/** Så ofta versionen kontrolleras medan appen syns. */
export const CHECK_INTERVAL_MS = 5 * 60_000;

export const ATTEMPT_KEY = "binderlab-uppdatering";

/** Finns en ny version? Bara när båda id:na är giltiga och olika. */
export function isNewBuild(current: unknown, live: unknown): boolean {
  return isBuildId(current) && isBuildId(live) && current !== live;
}

/** Får appen ladda om av sig själv nu, med tanke på tidigare försök? */
export function autoReloadAllowed(
  attempt: UpdateAttempt | null,
  current: string,
  live: string,
  now: number,
): boolean {
  if (!attempt) return true;
  if (attempt.autoCount >= MAX_AUTO_RELOADS) return false;
  // Samma uppdatering har redan provats nyss och sidan är fortfarande gammal: försök inte
  // igen (rutan med Uppdatera visas i stället).
  const sameUpdate = attempt.from === current && attempt.to === live;
  if (sameUpdate && now - attempt.at >= 0 && now - attempt.at < RETRY_AFTER_MS) return false;
  return true;
}

/** Vad appen ska göra efter en kontroll. */
export function decideUpdate({
  current,
  live,
  trigger,
  unsaved,
  attempt,
  now,
}: {
  current: string;
  live: string | null;
  trigger: CheckTrigger;
  /** Något är ifyllt men inte sparat (t.ex. antal i Fyll på). */
  unsaved: boolean;
  attempt: UpdateAttempt | null;
  now: number;
}): UpdateDecision {
  if (!live || !isNewBuild(current, live)) return "none";
  if (trigger !== "resume" || unsaved) return "banner";
  return autoReloadAllowed(attempt, current, live, now) ? "auto" : "banner";
}

/** Försöket som sparas före en omladdning. */
export function nextAttempt(
  previous: UpdateAttempt | null,
  { from, to, now, auto }: { from: string; to: string; now: number; auto: boolean },
): UpdateAttempt {
  return { from, to, at: now, autoCount: (previous?.autoCount ?? 0) + (auto ? 1 : 0) };
}

/**
 * Efter omladdningen: kom den nya versionen (sidan har nu försökets "to")? Då är försöket
 * klart, men antalet automatiska omladdningar räknas kvar för sessionen.
 */
export function settleAttempt(
  attempt: UpdateAttempt | null,
  current: string,
): UpdateAttempt | null {
  if (!attempt) return null;
  if (attempt.to === current) return { ...attempt, from: current, at: 0 };
  return attempt;
}

// ---------------------------------------------------------------------------
// Lagring (sessionStorage). Kan saknas eller kasta (privat läge, spärrad lagring): då
// räknas inget försök, och automatisk omladdning görs inte alls (se readAttempt).
// ---------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function parseAttempt(raw: string | null): UpdateAttempt | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<UpdateAttempt>;
    if (
      isBuildId(v.from) &&
      isBuildId(v.to) &&
      typeof v.at === "number" &&
      Number.isFinite(v.at) &&
      typeof v.autoCount === "number" &&
      Number.isFinite(v.autoCount)
    ) {
      return { from: v.from, to: v.to, at: v.at, autoCount: v.autoCount };
    }
  } catch {
    // Trasigt värde: räknas som inget försök.
  }
  return null;
}

/**
 * Det sparade försöket. `usable: false` när lagringen inte går att läsa och skriva: då vet
 * appen inte om den redan har laddat om, och laddar därför aldrig om av sig själv.
 */
export function readAttempt(storage: StorageLike | null | undefined): {
  usable: boolean;
  attempt: UpdateAttempt | null;
} {
  if (!storage) return { usable: false, attempt: null };
  try {
    return { usable: true, attempt: parseAttempt(storage.getItem(ATTEMPT_KEY)) };
  } catch {
    return { usable: false, attempt: null };
  }
}

/** Sparar försöket; false om lagringen inte går att skriva. */
export function writeAttempt(
  storage: StorageLike | null | undefined,
  attempt: UpdateAttempt,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
    return parseAttempt(storage.getItem(ATTEMPT_KEY)) !== null;
  } catch {
    return false;
  }
}
