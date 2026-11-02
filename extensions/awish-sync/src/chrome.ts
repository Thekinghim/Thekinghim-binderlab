/**
 * De delar av Chromes tilläggs-API som tillägget använder, med typer (projektet har inte
 * @types/chrome). Inget globalt: filerna hämtar `chromeApi` härifrån.
 */

export interface MessageSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number; url?: string };
}

export interface ChromeApi {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    sendMessage<T = unknown>(message: unknown): Promise<T>;
    onMessage: {
      addListener(
        cb: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    onInstalled: { addListener(cb: () => void): void };
    onStartup: { addListener(cb: () => void): void };
    getContexts?(filter: { contextTypes: string[]; documentUrls?: string[] }): Promise<unknown[]>;
  };
  storage: {
    local: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  alarms: {
    create(
      name: string,
      info: { periodInMinutes?: number; delayInMinutes?: number },
    ): Promise<void> | void;
    get(name: string): Promise<unknown>;
    onAlarm: { addListener(cb: (alarm: { name: string }) => void): void };
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    setTitle(details: { title: string }): Promise<void>;
  };
  offscreen?: {
    createDocument(params: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  permissions: {
    request(permissions: { origins: string[] }): Promise<boolean>;
    contains(permissions: { origins: string[] }): Promise<boolean>;
  };
  tabs: {
    create(props: { url: string }): Promise<unknown>;
    /** Med host-behörighet för adressen behövs inte behörigheten "tabs". */
    query(filter: { url?: string | string[] }): Promise<Array<{ id?: number; url?: string }>>;
  };
  scripting?: {
    executeScript<T>(details: {
      target: { tabId: number };
      func: () => T;
      world?: "ISOLATED" | "MAIN";
    }): Promise<Array<{ result?: T }>>;
  };
}

export const chromeApi = (globalThis as unknown as { chrome: ChromeApi }).chrome;
