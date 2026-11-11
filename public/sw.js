/*
 * Binderlab service worker.
 *
 * 1. Fältsidorna fungerar utan uppkoppling: /fyll-pa (och /fyll-pa/<automat>),
 *    /drift/pafyllning och /drift/besok hämtas från nätet först och sparas; utan nät visas
 *    den sparade versionen (en automat som inte sparats visas ur /fyll-pa). Påfyllningar köas i
 *    sidan (IndexedDB) och skickas när nätet kommer tillbaka. Next:s statiska filer
 *    (/_next/static) hämtas också från nätet först och sparas för läget utan nät.
 * 2. Push: larm från /api/cron/larm visas som notiser. Ett klick öppnar sidan som förklarar
 *    larmet (eller fokuserar ett öppet fönster).
 *
 * Bara fältsidorna sparas (inga belopp). Andra sidor och alla anrop går alltid till nätet.
 *
 * Sparade sidor hör till en användare: sidan talar om vem som är inloggad (meddelandet
 * "scope" från ServiceWorkerRegistration, en hash av organisation och användare) och
 * sidorna sparas i en cache per användare. Byter användaren, eller visas inloggningen eller
 * utloggningen, rensas de sparade sidorna. På en delad telefon ser nästa användare alltså
 * aldrig den förra användarens besöksplan.
 *
 * Nya versioner: sidan frågar servern vilket bygge som körs (/api/version) och talar om det
 * för workern (meddelandet "build"). Har bygget bytts hämtas fältsidorna på nytt och ersätter
 * de sparade, så att en sida från ett äldre bygge inte visas när det finns nät. "Uppdatera
 * appen" (meddelandet "refresh-pages") gör att nästa sidladdning väntar på nätet i stället
 * för att visa den sparade sidan efter NETWORK_TIMEOUT_MS. En sparad sida tas aldrig bort
 * förrän en ny har hämtats: försvinner nätet mitt i fungerar läget utan nät ändå.
 */
const VERSION = "binderlab-falt-v4";
const ASSETS = `${VERSION}:assets`;
const META = "binderlab-meta";
const PAGES = ["/fyll-pa", "/drift/pafyllning", "/drift/besok"];
const MACHINE_PAGE = /^\/fyll-pa\/[0-9a-f-]{36}$/i;
const SIGNED_OUT = ["/logga-in", "/logga-ut"];
const NETWORK_TIMEOUT_MS = 4000;
/** Så länge efter "Uppdatera appen" som nästa sidladdning väntar på nätet. */
const FRESH_MS = 60_000;

const pageCacheName = (scope) => `${VERSION}:sidor:${scope}`;

async function currentScope() {
  const meta = await caches.open(META);
  const res = await meta.match("/__scope");
  if (!res) return null;
  const text = (await res.text()).trim();
  return /^[a-f0-9]{8,64}$/.test(text) ? text : null;
}

/** Tar bort alla sparade sidor (alla användare). */
async function clearPages() {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((k) => k.startsWith(`${VERSION}:sidor:`)).map((k) => caches.delete(k)),
  );
}

/** Tar bort alla sparade sidor (alla användare) och glömmer vem som var inloggad. */
async function forgetUser() {
  await clearPages();
  const meta = await caches.open(META);
  await meta.delete("/__scope");
}

/** Sparar fältsidorna för den inloggade (utan nät: vid nästa besök). */
async function savePages(scope) {
  const cache = await caches.open(pageCacheName(scope));
  await Promise.all(
    PAGES.map(async (path) => {
      try {
        const res = await fetch(path, { credentials: "same-origin" });
        // Användaren kan ha bytts medan sidan hämtades: spara bara för den som är inloggad.
        if (res.ok && !res.redirected && (await currentScope()) === scope) {
          await cache.put(path, res);
        }
      } catch {
        // Utan nät: sidan sparas vid nästa besök.
      }
    }),
  );
}

/**
 * Servern kör bygget `build`. Är det ett annat än när sidorna sparades kommer de från ett
 * äldre bygge: fältsidorna hämtas på nytt och ersätter dem (en sida som inte gick att hämta,
 * t.ex. utan nät, ligger kvar för läget utan nät). Sparade automatsidor glöms; utan nät
 * visas de ur Fyll på-sidan.
 */
async function setBuild(build) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(build)) return;
  const meta = await caches.open(META);
  const known = await meta.match("/__build");
  if (known && (await known.text()) === build) return;
  await meta.put("/__build", new Response(build));
  const scope = await currentScope();
  if (!scope) return;
  const cache = await caches.open(pageCacheName(scope));
  for (const req of await cache.keys()) {
    if (!PAGES.includes(new URL(req.url).pathname)) await cache.delete(req);
  }
  await savePages(scope);
}

/** "Uppdatera appen": nästa sidladdning (inom FRESH_MS) väntar på nätet. */
async function refreshPages() {
  const meta = await caches.open(META);
  await meta.put("/__fresh", new Response(String(Date.now())));
}

/** Har "Uppdatera appen" just tryckts? Gäller en sidladdning. */
async function takeFresh() {
  const meta = await caches.open(META);
  const res = await meta.match("/__fresh");
  if (!res) return false;
  await meta.delete("/__fresh");
  const at = Number(await res.text());
  return Number.isFinite(at) && Date.now() - at >= 0 && Date.now() - at < FRESH_MS;
}

/** Ny inloggad användare: andras sidor tas bort, fältsidorna sparas för henne. */
async function setScope(scope) {
  if (!/^[a-f0-9]{8,64}$/.test(scope)) return;
  if ((await currentScope()) === scope) return;
  await forgetUser();
  const meta = await caches.open(META);
  await meta.put("/__scope", new Response(scope));
  await savePages(scope);
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "scope" && typeof data.scope === "string") {
    event.waitUntil(setScope(data.scope));
  } else if (data.type === "signed-out") {
    event.waitUntil(forgetUser());
  } else if (data.type === "build" && typeof data.build === "string") {
    event.waitUntil(setBuild(data.build));
  } else if (data.type === "refresh-pages") {
    // Svaret (på porten) när workern är redo: sidan laddar om först då.
    const port = event.ports && event.ports[0];
    event.waitUntil(
      refreshPages()
        .catch(() => {})
        .then(async () => {
          if (port) port.postMessage({ type: "pages-refreshed" });
          // Sidan laddar om nu; övriga fältsidor hämtas också på nytt (ersätts bara om de
          // gick att hämta).
          const scope = await currentScope();
          if (scope) await savePages(scope);
        }),
    );
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("binderlab-") && k !== META && !k.startsWith(`${VERSION}:`))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isFieldPage(url) {
  return PAGES.includes(url.pathname) || MACHINE_PAGE.test(url.pathname);
}

function offlinePage(path) {
  const retry = PAGES.includes(path) || MACHINE_PAGE.test(path) ? path : "/fyll-pa";
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ingen uppkoppling · Binderlab</title>
<style>body{margin:0;background:#0a0a0b;color:#edeae4;font:14px/20px system-ui,sans-serif;padding:32px 16px}main{max-width:480px;margin:0 auto}p{color:#a6a39d}.l{font:11px/16px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#8f8c86}a{color:#edeae4}</style></head>
<body><main><p class="l">Ur drift · ingen uppkoppling</p><h1 style="font-size:24px;line-height:32px;font-weight:500">Sidan finns inte sparad i telefonen.</h1>
<p>Öppna sidan en gång med uppkoppling, så fungerar den sedan utan nät.</p><p><a href="${retry}">Försök igen →</a></p></main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Talar om för sidan att en nyare version av den har sparats (den kontrollerar då bygget). */
async function notifyUpdated(clientId) {
  if (!clientId) return;
  const client = await self.clients.get(clientId);
  if (client) client.postMessage({ type: "page-updated" });
}

async function networkFirst(request, url, clientId) {
  const scope = await currentScope();
  const cache = scope ? await caches.open(pageCacheName(scope)) : null;
  // En automat (/fyll-pa/<id>) som inte sparats: Fyll på-sidan har alla automater.
  const cached = cache
    ? ((await cache.match(url.pathname)) ??
      (MACHINE_PAGE.test(url.pathname) ? await cache.match("/fyll-pa") : undefined))
    : undefined;
  // Direkt efter "Uppdatera appen": vänta på nätet (den sparade sidan bara om nätet inte svarar).
  const fresh = await takeFresh();
  const network = fetch(request);
  try {
    // Väntetiden gäller bara när det finns en sparad sida att visa i stället. Utan sparad
    // sida väntar vi på nätet: ett långsamt svar är bättre än "ingen uppkoppling".
    const res =
      cached && !fresh
        ? await Promise.race([
            network,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS),
            ),
          ])
        : await network;
    if (res.redirected && SIGNED_OUT.includes(new URL(res.url).pathname)) {
      // Inte inloggad längre: inga sparade sidor kvar.
      await forgetUser();
    } else if (cache && res.ok && !res.redirected) {
      // Inte await: cache.put väntar tills hela svaret har strömmats, och sidan (med
      // sin loading.tsx) ska visas medan den strömmar.
      cache.put(url.pathname, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    if (cached) {
      // Nätet svarade för sent: visa den sparade sidan och spara det nya svaret när det kommer.
      network
        .then(async (res) => {
          if (cache && res.ok && !res.redirected) {
            await cache.put(url.pathname, res);
            await notifyUpdated(clientId);
          }
        })
        .catch(() => {});
      return cached;
    }
    return offlinePage(url.pathname);
  }
}

// Statiska filer: nätet först (webbläsarens egen cache gör det snabbt), den sparade kopian
// bara utan nät. Så kan en gammal kopia aldrig blandas med en ny sida. Filerna är samma för
// alla användare.
async function assetNetworkFirst(request) {
  const cache = await caches.open(ASSETS);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request, res.clone());
    else {
      // Efter en driftsättning finns det förra byggets filer inte kvar på servern (404). En
      // sparad sida från det bygget (nätet svarade för sent) behöver dem för att fungera och
      // kunna visa "Ny version av appen finns": ta den sparade kopian.
      const cached = await cache.match(request);
      if (cached) return cached;
    }
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
  // Anrop (bl.a. /api/version, som alltid ska vara färskt) går alltid till nätet.
  if (url.pathname.startsWith("/api/")) return;
  if (SIGNED_OUT.includes(url.pathname)) {
    // Inloggning eller utloggning (sidladdning eller klientnavigering): glöm den förra
    // användarens sidor. Svaret går till nätet.
    event.waitUntil(forgetUser());
    return;
  }
  // RSC-anrop (klientnavigering) går alltid till nätet; utan nät gör Next en vanlig
  // sidladdning, som då besvaras från den sparade sidan nedan.
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) return;
  if (request.mode === "navigate" && isFieldPage(url)) {
    event.respondWith(networkFirst(request, url, event.resultingClientId || event.clientId));
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
    // Notisens språk (veckosammanfattningen skickas på personens språk); annars svenska.
    lang: data.lang === "en" ? "en" : "sv",
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
