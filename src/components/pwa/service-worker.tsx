"use client";

import { useEffect } from "react";

/**
 * Registrerar service workern (public/sw.js) för hela appen: offline-läge för fältsidorna
 * under /drift och push-notiser. Registreringen görs en gång; webbläsaren uppdaterar
 * workern själv när filen ändras (updateViaCache: 'none').
 *
 * `scope` (en hash av organisation och användare) talar om för workern vem som är inloggad,
 * så att sparade sidor hör till en användare och rensas när någon annan loggar in.
 */
export function ServiceWorkerRegistration({ scope }: { scope: string | null }) {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        reg.active?.postMessage(scope ? { type: "scope", scope } : { type: "signed-out" });
      })
      .catch(() => {
        // Utan service worker fungerar sidorna ändå, bara inte offline.
      });
  }, [scope]);
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
