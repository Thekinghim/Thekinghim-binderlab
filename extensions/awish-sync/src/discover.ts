/**
 * Innehållsskript i Awish-panelens egen sida (world: MAIN, dash.awish.vip). Om panelen
 * hämtar orderlistan som JSON med fetch eller XMLHttpRequest noteras ADRESSEN (inte
 * svaret) och lämnas till tillägget via window.postMessage → ./bridge.ts, så att
 * tillägget kan läsa samma API i stället för HTML-tabellen. Inget skickas någon
 * annanstans, och sidan påverkas inte (anropen går igenom oförändrade).
 *
 * Bara anrop mot orderlistan rapporteras (samma regel som isOrdersApiPath i
 * ./reader.ts, som service workern också kontrollerar): återbetalningar, topplistor och
 * annat på samma ursprung med ordernummer i svaret används aldrig som orderkälla.
 *
 * Klassiskt skript (inte modul): byggskriptet tar bort raden "export {}".
 */

(() => {
  const w = window as unknown as {
    __binderlabAwishDiscover?: boolean;
    fetch: typeof fetch;
    XMLHttpRequest: typeof XMLHttpRequest;
  };
  if (w.__binderlabAwishDiscover) return;
  w.__binderlabAwishDiscover = true;
  const ORDER_KEY = /^(?:order_?(?:no|sn|number|num|id|code)|out_?trade_?no|trade_?no)$/i;
  let reported = "";
  const ordersPath = (pathname: string): boolean => {
    const path = pathname
      .replace(/\.(?:html|json)$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    if (path === "/dashboard/orders/index" || path === "/dashboard/orders") return true;
    if (/refund|after_?sale|statistic|stats|rank|top|summary|report|export|chart/.test(path)) {
      return false;
    }
    return /^(?:\/[a-z0-9_-]+){0,3}\/orders?\/(?:index|list|lists|getlist|page)$/.test(path);
  };

  const looksLikeOrders = (json: unknown, depth = 0): boolean => {
    if (depth > 3 || json === null || typeof json !== "object") return false;
    if (Array.isArray(json)) {
      const first = json.find((x) => x && typeof x === "object" && !Array.isArray(x)) as
        Record<string, unknown> | undefined;
      return Boolean(first && Object.keys(first).some((k) => ORDER_KEY.test(k)));
    }
    return Object.values(json as Record<string, unknown>).some((v) =>
      looksLikeOrders(v, depth + 1),
    );
  };

  const report = (url: string, text: string) => {
    try {
      const absolute = new URL(url, location.href);
      if (absolute.origin !== location.origin) return;
      if (!ordersPath(absolute.pathname)) return;
      if (!/^\s*[[{]/.test(text)) return;
      if (!looksLikeOrders(JSON.parse(text))) return;
      const href = absolute.toString();
      if (href === reported) return;
      reported = href;
      window.postMessage(
        { source: "binderlab-awish-sync", type: "awish-api", url: href },
        location.origin,
      );
    } catch {
      // Inte JSON, eller inte ordrar: inget att göra.
    }
  };

  const originalFetch = w.fetch;
  w.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const response = await originalFetch.call(this, input, init);
    try {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (/json|javascript/i.test(response.headers.get("content-type") ?? "")) {
        response
          .clone()
          .text()
          .then((t) => report(url, t))
          .catch(() => undefined);
      }
    } catch {
      // Får aldrig störa sidan.
    }
    return response;
  } as typeof fetch;

  const open = w.XMLHttpRequest.prototype.open;
  w.XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.addEventListener("load", () => {
      try {
        if (this.responseType === "" || this.responseType === "text")
          report(String(url), this.responseText);
        else if (this.responseType === "json") report(String(url), JSON.stringify(this.response));
      } catch {
        // Får aldrig störa sidan.
      }
    });
    return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
})();

export {};
