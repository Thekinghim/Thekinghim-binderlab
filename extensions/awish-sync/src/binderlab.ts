/**
 * Klienten mot Binderlab: GET /api/ingest/awish/status och POST /api/ingest/awish med
 * "Authorization: Bearer <token>". Inga cookies (credentials: "omit"). Återförsök med
 * backoff vid 429 (Retry-After), 5xx och nätverksfel; 401/403 stoppar direkt.
 * Tilläggets enda mottagare: inget skickas någon annanstans än till Binderlab-adressen.
 */

import type { OrderRow } from "./reader.js";

export type BinderlabErrorKind = "auth" | "rate" | "invalid" | "server" | "network" | "settings";

export class BinderlabError extends Error {
  constructor(
    readonly kind: BinderlabErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "BinderlabError";
  }
}

export interface IngestStatus {
  ok: true;
  dataSource: { id: string; name: string; sourceTimezone: string; status: string };
  lastSyncedAt: string | null;
  orders: {
    count: number;
    latestExternalId: string | null;
    latestOrderedAt: string | null;
    knownExternalIds: string[];
    /** Ordrar i just den här datakällan (count gäller alla Awish-källor i organisationen). */
    sourceCount?: number;
  };
  limits: { maxRows: number; maxBodyBytes: number };
}

export interface Report {
  state: "ok" | "logged_out" | "error";
  message?: string;
  fullHistory?: boolean;
  pagesRead?: number;
  rowsSeen?: number;
  mode?: "json" | "html" | "tab";
  /** Rubrikerna (HTML) eller nycklarna (JSON) per fält, som de lästes. */
  columns?: Partial<Record<string, string>>;
  /** Sökvägen som lästes, utan parametrar. */
  path?: string;
}

export interface BatchResult {
  ok: true;
  importId: string | null;
  summary: {
    total: number;
    new: number;
    duplicate: number;
    conflict: number;
    error: number;
    notPaid: number;
  } | null;
  lastSyncedAt: string | null;
}

export interface BinderlabDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  version: string;
}

/** Normaliserar Binderlab-adressen: https (eller http mot localhost), utan avslutande /. */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new BinderlabError("settings", "Binderlabs adress är inte en giltig adress.");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new BinderlabError("settings", "Binderlabs adress måste börja med https://.");
  }
  if (u.username || u.password) {
    throw new BinderlabError("settings", "Binderlabs adress får inte innehålla inloggning.");
  }
  return u.origin;
}

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000];

export class BinderlabClient {
  readonly base: string;

  constructor(
    private readonly deps: BinderlabDeps,
    baseUrl: string,
    private readonly token: string,
  ) {
    this.base = normalizeBaseUrl(baseUrl);
    if (!/^blsync_[A-Za-z0-9_-]{43}$/.test(token.trim())) {
      throw new BinderlabError(
        "settings",
        "Token har fel form. Kopiera den på nytt från Datakällor i Binderlab.",
      );
    }
    this.token = token.trim();
  }

  private async once<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.deps.fetch(`${this.base}${path}`, {
        ...init,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
      });
    } catch {
      throw new BinderlabError("network", `Binderlab (${this.base}) svarar inte.`);
    }
    let body: { ok?: boolean; error?: string } | null = null;
    try {
      body = (await res.json()) as { ok?: boolean; error?: string };
    } catch {
      body = null;
    }
    if (res.ok && body?.ok) return body as T;
    const message = body?.error ?? `Binderlab svarade ${res.status}.`;
    if (res.status === 401 || res.status === 403) throw new BinderlabError("auth", message);
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "0");
      throw new BinderlabError(
        "rate",
        message,
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
      );
    }
    if (res.status === 400 || res.status === 409 || res.status === 413) {
      throw new BinderlabError("invalid", message);
    }
    throw new BinderlabError("server", message);
  }

  /** Med återförsök: 429, 5xx och nätverksfel. */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.once<T>(path, init);
      } catch (error) {
        const e = error as BinderlabError;
        const retryable = e.kind === "rate" || e.kind === "server" || e.kind === "network";
        const delay = RETRY_DELAYS_MS[attempt];
        if (!retryable || delay === undefined) throw error;
        await this.deps.sleep(Math.max(delay, e.retryAfterMs ?? 0));
      }
    }
  }

  status(): Promise<IngestStatus> {
    return this.request<IngestStatus>("/api/ingest/awish/status", { method: "GET" });
  }

  postBatch(input: {
    rows: OrderRow[];
    absent?: "paymentMethod"[];
    batch?: number;
    report?: Report;
  }): Promise<BatchResult> {
    return this.request<BatchResult>("/api/ingest/awish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rows: input.rows,
        ...(input.absent && input.absent.length > 0 ? { absent: input.absent } : {}),
        ...(input.batch ? { batch: input.batch } : {}),
        ...(input.report ? { report: input.report } : {}),
        client: { name: "binderlab-awish-sync", version: this.deps.version },
      }),
    });
  }
}
