"use client";

import { useEffect } from "react";

/**
 * Registrerar service workern (public/sw.js) för hela appen: offline-läge för fältsidorna
 * under /drift och push-notiser. Registreringen görs en gång; webbläsaren uppdaterar
 * workern själv när filen ändras (updateViaCache: 'none').
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // Utan service worker fungerar sidorna ändå, bara inte offline.
    });
  }, []);
  return null;
}

/** Den registrerade service workern, eller null (t.ex. i en webbläsare utan stöd). */
export async function readyRegistration(
  timeoutMs = 4000,
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}
