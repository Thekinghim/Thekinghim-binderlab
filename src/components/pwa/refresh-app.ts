"use client";

import { BUILD_ID, isBuildId } from "@/lib/build-id";

import {
  nextAttempt,
  readAttempt,
  writeAttempt,
  type StorageLike,
  type UpdateAttempt,
} from "./app-version";

/**
 * Det som "Uppdatera" gör i webbläsaren: frågar servern vilket bygge som körs, ber service
 * workern (public/sw.js) glömma sparade sidor och laddar om. Logiken utan webbläsare finns i
 * app-version.ts.
 */

const VERSION_URL = "/api/version";

/**
 * Bygget som sidans skript laddades med. Sätts av den första AppUpdate som visas och ändras
 * inte vid klientnavigering eller router.refresh (då kan servern skicka ett nyare id medan
 * skripten fortfarande är de gamla); en omladdning börjar om.
 */
let loadedBuild: string | null = null;

/** Sidans bygge (första gången det anges vinner). */
export function rememberLoadedBuild(build: string): string {
  if (loadedBuild === null && isBuildId(build)) loadedBuild = build;
  return loadedBuildId();
}

/** Bygget som sidan laddades med (det inbakade om ingen AppUpdate visats). */
export function loadedBuildId(): string {
  return loadedBuild ?? BUILD_ID;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** sessionStorage, eller null om den inte går att nå (privat läge, spärrad lagring). */
export function sessionStore(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Byggets id som servern kör nu, eller null (utan nät, fel svar). */
export async function fetchLiveBuildId(timeoutMs = 8000): Promise<string | null> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const res = await fetch(VERSION_URL, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller?.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { buildId?: unknown };
    return isBuildId(body.buildId) ? body.buildId : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return withTimeout(
    navigator.serviceWorker.getRegistration("/").then((r) => r ?? null),
    2000,
    null,
  );
}

/** Skickar ett meddelande till service workern och väntar på svaret (högst timeoutMs). */
function ask(worker: ServiceWorker | null | undefined, message: object, timeoutMs: number) {
  if (!worker) return Promise.resolve(false);
  return withTimeout(
    new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve(true);
      worker.postMessage(message, [channel.port2]);
    }),
    timeoutMs,
    false,
  );
}

/**
 * Talar om för service workern vilket bygge servern kör. Har det bytts glömmer workern de
 * sidor den sparat från det förra bygget (och sparar dem på nytt), så att en gammal sida
 * aldrig visas igen.
 */
export async function reportLiveBuild(build: string): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const worker = navigator.serviceWorker.controller ?? (await registration())?.active;
  worker?.postMessage({ type: "build", build });
}

export type RefreshResult = { ok: true } | { ok: false; reason: "offline" };

/**
 * Uppdatera appen: hämta en ny service worker om det finns, låt workern glömma sparade sidor
 * (de sparas igen vid nästa besök, så Fyll på fungerar fortfarande utan nät) och ladda om.
 * Utan nät görs ingenting (den sparade sidan är då det enda som fungerar).
 *
 * `from`/`to`: byggena före och efter, sparas så att appen aldrig laddar om i en slinga.
 */
export async function refreshApp({
  from,
  to,
  auto = false,
}: {
  from: string;
  to?: string | null;
  auto?: boolean;
}): Promise<RefreshResult> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, reason: "offline" };
  }
  const storage = sessionStore();
  const { attempt } = readAttempt(storage);
  const next: UpdateAttempt = nextAttempt(attempt, {
    from,
    to: to ?? from,
    now: Date.now(),
    auto,
  });
  writeAttempt(storage, next);

  const reg = await registration();
  if (reg) {
    // Ny sw.js? Den aktiveras direkt (skipWaiting) och tar bort gamla cachar.
    await withTimeout(
      reg.update().then(() => undefined),
      4000,
      undefined,
    );
    const worker = reg.active ?? navigator.serviceWorker.controller;
    await ask(worker, { type: "refresh-pages" }, 3000);
  }
  window.location.reload();
  return { ok: true };
}
