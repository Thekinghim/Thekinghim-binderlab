/**
 * Liten HTTP-klient för Supabase Management API och Vercel REST API.
 *
 * - Försöker igen vid 429 (respekterar Retry-After). Vid 502/503/504,
 *   nätverksfel och tidsgräns försöker den bara igen för anrop som tål att
 *   göras två gånger (GET, HEAD, PUT, PATCH, DELETE, eller `idempotent: true`).
 *   Ett POST som skapar något görs aldrig om: det kan ha gått igenom trots
 *   felet, och då blir det dubbletter (t.ex. två betalda Supabase-projekt).
 *   Anroparen läser i stället om listan innan något skapas igen.
 * - Varje anrop har en tidsgräns (standard 60 s), så ett hängande anrop inte
 *   stoppar skriptet för alltid.
 * - Fel blir `ApiError` med metod, sökväg (utan frågeparametrar som kan bära
 *   hemligheter), status och API:ts eget meddelande, på svenska.
 * - Dry-run-spärr: i dry-run vägrar klienten allt utom GET, så att ett
 *   misstag i ett steg aldrig kan ändra något.
 */

import type { Logger } from "./log";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiError extends Error {
  constructor(
    readonly service: string,
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly apiMessage: string,
    readonly body: unknown,
  ) {
    super(
      status === 0
        ? `${service}: ${method} ${path} nådde inte fram (${apiMessage}).`
        : `${service}: ${method} ${path} svarade ${status}${apiMessage ? `: ${apiMessage}` : ""}.`,
    );
    this.name = "ApiError";
  }
}

export class DryRunViolation extends Error {
  constructor(method: string, path: string) {
    super(`Dry-run: ${method} ${path} skulle ändra något och skickades inte (fel i skriptet).`);
    this.name = "DryRunViolation";
  }
}

export interface ApiClientOptions {
  service: string;
  baseUrl: string;
  /** Skickas som Authorization: Bearer. */
  token?: string;
  /** Extra rubriker (t.ex. apikey för Supabase Auth/Storage). */
  headers?: Record<string, string>;
  /** Frågeparametrar som läggs på varje anrop (t.ex. teamId hos Vercel). */
  query?: Record<string, string | undefined>;
  fetch: FetchLike;
  log: Logger;
  dryRun: boolean;
  sleep?: Sleep;
  /** Antal omförsök (standard 4). */
  retries?: number;
  /** Tidsgräns per anrop i ms (standard 60 000). */
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Statuskoder som inte är fel utan returneras till anroparen (t.ex. 404). */
  allow?: readonly number[];
  /** Tillåt ett ändrande anrop även i dry-run (används aldrig av stegen). */
  readOnly?: boolean;
  /**
   * Anropet tål att göras två gånger (t.ex. database/query, som skyddas av
   * sin egen kontroll). Då görs POST om vid 5xx och nätverksfel.
   */
  idempotent?: boolean;
  /** Tidsgräns för just det här anropet i ms. */
  timeoutMs?: number;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

export interface ApiClient {
  readonly service: string;
  readonly baseUrl: string;
  request<T = unknown>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>>;
  get<T = unknown>(path: string, options?: Omit<RequestOptions, "body">): Promise<ApiResponse<T>>;
}

/** Omförsök för alla metoder: begäran behandlades inte. */
const RETRY_ALWAYS = new Set([429]);
/** Omförsök bara för anrop som tål att göras två gånger. */
const RETRY_IF_IDEMPOTENT = new Set([502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE"]);

export function isTransient(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

function apiMessageOf(body: unknown, text: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    for (const key of ["message", "msg", "error_description", "error"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
  }
  return text.slice(0, 300);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const sleep = options.sleep ?? realSleep;
  const retries = options.retries ?? 4;
  const defaultTimeout = options.timeoutMs ?? 60_000;
  const base = options.baseUrl.replace(/\/+$/, "");
  if (options.token) options.log.secret(options.token);
  for (const value of Object.values(options.headers ?? {})) options.log.secret(value);

  async function request<T>(
    method: string,
    path: string,
    req: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const upper = method.toUpperCase();
    if (options.dryRun && upper !== "GET" && upper !== "HEAD" && !req.readOnly) {
      throw new DryRunViolation(upper, path);
    }
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries({ ...options.query, ...req.query })) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "binderlab-deploy",
      ...options.headers,
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let payload: string | undefined;
    if (req.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(req.body);
    }

    const repeatable = IDEMPOTENT_METHODS.has(upper) || req.idempotent === true;
    const timeoutMs = req.timeoutMs ?? defaultTimeout;
    let attempt = 0;
    for (;;) {
      let response: Response;
      let text: string;
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        response = await options.fetch(url.toString(), {
          method: upper,
          headers,
          body: payload,
          signal,
        });
        text = await response.text();
      } catch (error) {
        if (repeatable && attempt < retries) {
          attempt += 1;
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const timedOut =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        const reason = timedOut
          ? `inget svar inom ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`
          : options.log.redact(error instanceof Error ? error.message : String(error));
        throw new ApiError(
          options.service,
          upper,
          path,
          0,
          `${reason}; kontrollera att ${url.host} är öppet i sessionens nätverk` +
            (repeatable ? "" : ". Anropet kan ha gått igenom och gjordes inte om"),
          undefined,
        );
      }
      let body: unknown = undefined;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (response.ok || req.allow?.includes(response.status)) {
        return { status: response.status, data: body as T };
      }
      const retryable =
        RETRY_ALWAYS.has(response.status) ||
        (repeatable && RETRY_IF_IDEMPOTENT.has(response.status));
      if (retryable && attempt < retries) {
        attempt += 1;
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      let message = options.log.redact(apiMessageOf(body, text));
      if (response.status === 401) {
        message = `${message || "obehörig"} (är token giltig och rätt?)`;
      } else if (response.status === 403) {
        message = `${message || "nekad"} (saknar token behörighet till detta?)`;
      }
      throw new ApiError(options.service, upper, path, response.status, message, body);
    }
  }

  return {
    service: options.service,
    baseUrl: base,
    request,
    get: (path, req) => request("GET", path, req),
  };
}
