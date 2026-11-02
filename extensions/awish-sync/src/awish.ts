/**
 * Läser Awish orderlista sida för sida med användarens egen inloggning (fetch med
 * credentials: "include" från tillägget, som har host-behörighet för dash.awish.vip).
 *
 * Ordning:
 * 1. JSON-API:t om det är känt: upptäckt i panelens egna anrop (./discover.ts) eller
 *    hittat genom att fråga orderlistans adress som ett XHR-anrop (som FastAdmin och
 *    liknande paneler svarar på med JSON).
 * 2. Annars HTML-tabellen, tolkad med DOMParser i offscreen-dokumentet (eller
 *    tokeniseraren som reserv). Kolumnerna hittas på rubriktexterna.
 *
 * Utloggning (omdirigering till inloggningen, ett lösenordsfält utan ordertabell, 401
 * eller ett JSON-svar som säger det) blir ReaderError "logged_out".
 */

import {
  findJsonRows,
  findOrderTable,
  jsonApiFromUrl,
  jsonLoggedOut,
  jsonPageUrl,
  looksLoggedOut,
  pageUrl,
  readGrid,
  readJsonItems,
  readPagination,
  ReaderError,
  type ExtractedPage,
  type JsonApi,
  type PageRead,
} from "./reader.js";

export const LOGGED_OUT_MESSAGE = "Logga in på dash.awish.vip i Chrome så fortsätter synken.";

export interface AwishDeps {
  fetch: typeof fetch;
  parseHtml: (html: string) => Promise<ExtractedPage>;
  now: () => Date;
  awishOrigin: string;
  ordersPath: string;
  pageSize: number;
  apiProbeIntervalMs: number;
}

/** Det tillägget kommer ihåg om hur Awish läses (sparas i chrome.storage). */
export interface AwishMemory {
  api: JsonApi | null;
  /** Var API:t kom ifrån: upptäckt i panelens anrop eller provat. */
  apiSource: "discovered" | "probed" | null;
  /** När ett försök att hitta JSON-API:t senast misslyckades. */
  apiProbeFailedAt: string | null;
  /** Parametern som HTML-sidnavigeringen använder (standard "page"). */
  htmlPageParam: string | null;
}

export interface AwishPage extends PageRead {
  mode: "json" | "html";
  hasMore: boolean;
  lastPage: number | null;
}

function isLoginUrl(url: string): boolean {
  try {
    return /\/(?:login|signin|sign-in|auth|passport)(?:[/?.#]|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

const JSON_HEADERS = {
  accept: "application/json, text/javascript, */*; q=0.01",
  "x-requested-with": "XMLHttpRequest",
};

export class AwishReader {
  constructor(
    private readonly deps: AwishDeps,
    readonly memory: AwishMemory,
  ) {}

  get ordersUrl(): string {
    return new URL(this.deps.ordersPath, this.deps.awishOrigin).toString();
  }

  /** Bara Awish egen adress läses, aldrig något annat. */
  private assertAwish(url: string): void {
    if (new URL(url).origin !== new URL(this.deps.awishOrigin).origin) {
      throw new ReaderError("http", "Tillägget läser bara från Awish-panelen.");
    }
  }

  private async get(url: string, headers: Record<string, string>): Promise<Response> {
    this.assertAwish(url);
    let res: Response;
    try {
      res = await this.deps.fetch(url, { credentials: "include", cache: "no-store", headers });
    } catch {
      throw new ReaderError(
        "network",
        "Awish-panelen svarar inte. Synken försöker igen om en stund.",
      );
    }
    if ((res.redirected && isLoginUrl(res.url)) || res.status === 401 || res.status === 419) {
      throw new ReaderError("logged_out", LOGGED_OUT_MESSAGE);
    }
    if (res.status === 403 && isLoginUrl(res.url)) {
      throw new ReaderError("logged_out", LOGGED_OUT_MESSAGE);
    }
    if (!res.ok) {
      throw new ReaderError("http", `Awish svarade ${res.status} för orderlistan.`);
    }
    return res;
  }

  /** Ett JSON-API som panelen själv anropade (från ./discover.ts). */
  useDiscoveredApi(url: string): boolean {
    try {
      this.assertAwish(url);
    } catch {
      return false;
    }
    const api = jsonApiFromUrl(url);
    if (!api) return false;
    this.memory.api = api;
    this.memory.apiSource = "discovered";
    return true;
  }

  /** Provar om orderlistans adress svarar med JSON som ett XHR-anrop. */
  private async probeJson(): Promise<JsonApi | null> {
    const failedAt = this.memory.apiProbeFailedAt ? Date.parse(this.memory.apiProbeFailedAt) : NaN;
    if (
      Number.isFinite(failedAt) &&
      this.deps.now().getTime() - failedAt < this.deps.apiProbeIntervalMs
    ) {
      return null;
    }
    const base = this.ordersUrl;
    const size = this.deps.pageSize;
    const candidates = [
      `${base}?sort=id&order=desc&offset=0&limit=${size}`,
      `${base}?page=1&limit=${size}`,
    ];
    for (const url of candidates) {
      let res: Response;
      try {
        res = await this.get(url, JSON_HEADERS);
      } catch (error) {
        if (error instanceof ReaderError && error.kind === "logged_out") throw error;
        continue;
      }
      if (!/json|javascript/i.test(res.headers.get("content-type") ?? "")) continue;
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        continue;
      }
      if (jsonLoggedOut(json)) throw new ReaderError("logged_out", LOGGED_OUT_MESSAGE);
      const found = findJsonRows(json);
      if (found && found.items.length > 0) {
        const api = jsonApiFromUrl(url);
        if (api) {
          this.memory.api = api;
          this.memory.apiSource = "probed";
          return api;
        }
      }
    }
    this.memory.apiProbeFailedAt = this.deps.now().toISOString();
    return null;
  }

  private async readJson(api: JsonApi, page: number): Promise<AwishPage | null> {
    const res = await this.get(
      jsonPageUrl(api, page),
      api.ajaxHeader ? JSON_HEADERS : { accept: "application/json" },
    );
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    if (jsonLoggedOut(json)) throw new ReaderError("logged_out", LOGGED_OUT_MESSAGE);
    const found = findJsonRows(json);
    if (!found) return null;
    let read: PageRead;
    try {
      read = readJsonItems(found.items, page);
    } catch {
      return null;
    }
    const lastPage =
      found.total === null ? null : Math.max(1, Math.ceil(found.total / api.pageSize));
    const hasMore =
      found.items.length > 0 &&
      (found.total === null
        ? found.items.length >= api.pageSize
        : page * api.pageSize < found.total);
    return { ...read, mode: "json", hasMore, lastPage };
  }

  private async readHtml(page: number): Promise<AwishPage> {
    const url =
      page === 1
        ? this.ordersUrl
        : pageUrl(this.ordersUrl, page, this.memory.htmlPageParam ?? "page");
    const res = await this.get(url, { accept: "text/html,application/xhtml+xml" });
    const html = await res.text();
    const extracted = await this.deps.parseHtml(html);
    if (looksLoggedOut(extracted, res.url || url)) {
      throw new ReaderError("logged_out", LOGGED_OUT_MESSAGE);
    }
    const table = findOrderTable(extracted.tables);
    if (!table) {
      if (page > 1)
        return {
          rows: [],
          absent: [],
          seen: 0,
          skipped: 0,
          mode: "html",
          hasMore: false,
          lastPage: page - 1,
        };
      throw new ReaderError(
        "layout",
        "Hittar inte ordertabellen i Awish (rubrikerna Order No., Name, Order Machine, Order Amount, Is Paid, Payment Time). Awish kan ha ändrat sidan.",
      );
    }
    const read = readGrid(table, page);
    const pagination = readPagination(extracted, page, url, this.deps.pageSize);
    this.memory.htmlPageParam = pagination.param;
    const hasMore =
      read.seen > 0 &&
      (pagination.hasNext || (pagination.lastPage === null && read.seen >= this.deps.pageSize));
    return { ...read, mode: "html", hasMore, lastPage: pagination.lastPage };
  }

  /** Sida n (från 1, nyast först). */
  async readPage(page: number): Promise<AwishPage> {
    if (this.memory.api) {
      const viaJson = await this.readJson(this.memory.api, page);
      if (viaJson) return viaJson;
      // API:t svarade inte som väntat: glöm det och läs HTML.
      this.memory.api = null;
      this.memory.apiSource = null;
      this.memory.apiProbeFailedAt = this.deps.now().toISOString();
    } else if (page === 1) {
      const api = await this.probeJson();
      if (api) {
        const viaJson = await this.readJson(api, page);
        if (viaJson) return viaJson;
        this.memory.api = null;
        this.memory.apiSource = null;
      }
    }
    return this.readHtml(page);
  }
}
