/*
 * Binderlab service worker.
 *
 * 1. Fältsidorna fungerar utan uppkoppling: /drift/pafyllning och /drift/besok hämtas från
 *    nätet först och sparas; utan nät visas den sparade versionen. Påfyllningar köas i
 *    sidan (IndexedDB) och skickas när nätet kommer tillbaka. Next:s statiska filer
 *    (/_next/static) hämtas också från nätet först och sparas för läget utan nät.
 * 2. Push: larm från /api/cron/larm visas som notiser. Ett klick öppnar sidan som förklarar
 *    larmet (eller fokuserar ett öppet fönster).
 *
 * Bara fältsidorna sparas (inga belopp). Andra sidor och alla anrop går alltid till nätet.
 */

const VERSION = "binderlab-falt-v2";
const PAGES = ["/drift/pafyllning", "/drift/besok"];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // Försök spara fältsidorna direkt (lyckas bara när användaren är inloggad).
      await Promise.all(
        PAGES.map(async (path) => {
          try {
            const res = await fetch(path, { credentials: "same-origin" });
            if (res.ok && !res.redirected) await cache.put(path, res);
          } catch {
            // Utan nät: sidan sparas vid nästa besök.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("binderlab-") && k !== VERSION)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isFieldPage(url) {
  return PAGES.includes(url.pathname);
}

function offlinePage() {
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ingen uppkoppling · Binderlab</title>
<style>body{margin:0;background:#0a0a0b;color:#edeae4;font:14px/20px system-ui,sans-serif;padding:32px 16px}main{max-width:480px;margin:0 auto}p{color:#a6a39d}.l{font:11px/16px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#8f8c86}a{color:#edeae4}</style></head>
<body><main><p class="l">Ur drift · ingen uppkoppling</p><h1 style="font-size:24px;line-height:32px;font-weight:500">Sidan finns inte sparad i telefonen.</h1>
<p>Öppna Påfyllning en gång med uppkoppling, så fungerar den sedan utan nät.</p><p><a href="/drift/pafyllning">Försök igen →</a></p></main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function networkFirst(request, url) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS),
      ),
    ]);
    if (res.ok && !res.redirected) await cache.put(url.pathname, res.clone());
    return res;
  } catch {
    const cached = await cache.match(url.pathname);
    return cached ?? offlinePage();
  }
}

// Statiska filer: nätet först (webbläsarens egen cache gör det snabbt), den sparade kopian
// bara utan nät. Så kan en gammal kopia aldrig blandas med en ny sida.
async function assetNetworkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // RSC-anrop (klientnavigering) går alltid till nätet; utan nät gör Next en vanlig
  // sidladdning, som då besvaras från den sparade sidan nedan.
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) return;
  if (request.mode === "navigate" && isFieldPage(url)) {
    event.respondWith(networkFirst(request, url));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(assetNetworkFirst(request));
  }
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Binderlab", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Binderlab";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    requireInteraction: data.severity === "critical",
    icon: "/icon.svg",
    badge: "/icon.svg",
    lang: "sv",
    data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/drift" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/drift", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target && "focus" in client) return client.focus();
      }
      const any = windows.find((c) => "navigate" in c);
      if (any) {
        await any.navigate(target);
        return any.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
