/**
 * Klient mot Fortnox eget API (https://api.fortnox.se/3) och token-tjänsten
 * (https://apps.fortnox.se/oauth-v1). Bara det appen behöver: verifikat, konton, serier,
 * räkenskapsår, låst period och företagets namn.
 *
 * Tre regler bär resten av integrationen:
 *
 * 1. Varje fel sorteras efter om anropet SÄKERT inte gick igenom (`definite`: Fortnox svarade
 *    med ett 4xx-fel) eller om det är OVISST (nätverksfel, tidsgräns, 5xx). Ett verifikat som
 *    skickats med ovisst svar får aldrig skickas igen förrän vi har letat efter det i Fortnox.
 * 2. Högst 20 anrop per 5 sekunder härifrån (Fortnox gräns är 25 per 5 sekunder per token),
 *    och ett 429-svar väntas ut och försöks igen. 429 betyder att inget gjordes.
 * 3. Token skrivs aldrig i fel, loggar eller felmeddelanden. Felen bär bara status, Fortnox
 *    felkod och Fortnox egen feltext.
 */

import "server-only";

import type { FortnoxConfig } from "./config";

export type FortnoxErrorKind =
  /** Token gick inte (utgången eller återkallad). */
  | "unauthorized"
  /** Rättigheten (scope) eller licensen saknas hos Fortnox. */
  | "forbidden"
  | "rate_limited"
  | "locked_period"
  | "no_financial_year"
  | "unknown_account"
  | "unknown_series"
  | "not_found"
  /** Fortnox tog inte emot innehållet av något annat skäl. */
  | "invalid"
  /** Fortnox svarade 5xx. */
  | "server"
  /** Inget svar (nätverk, tidsgräns) eller ett svar som inte gick att läsa. */
  | "network";

export class FortnoxApiError extends Error {
  constructor(
    readonly kind: FortnoxErrorKind,
    /** Sant när anropet säkert inte ändrade något i Fortnox. */
    readonly definite: boolean,
    readonly status: number | null,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "FortnoxApiError";
  }
}

/** Token-tjänsten sa nej. `invalid_grant` = refresh-token eller kod gäller inte längre. */
export class FortnoxAuthError extends Error {
  constructor(
    readonly kind: "invalid_grant" | "invalid_client" | "temporary",
    message: string,
  ) {
    super(message);
    this.name = "FortnoxAuthError";
  }
}

export interface FortnoxTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** När åtkomsttoken slutar gälla. */
  readonly accessExpiresAt: Date;
}

export interface FortnoxVoucherRow {
  readonly account: string;
  /** Positivt = debet, negativt = kredit. */
  readonly amountOre: number;
  readonly text: string;
}

export interface FortnoxVoucherInput {
  readonly series: string;
  readonly date: string;
  readonly description: string;
  readonly rows: readonly FortnoxVoucherRow[];
}

export interface FortnoxVoucherRef {
  readonly series: string;
  readonly number: number;
  /** Fortnox id för räkenskapsåret. */
  readonly year: number;
}

export interface FortnoxVoucherListed extends FortnoxVoucherRef {
  readonly date: string;
  readonly description: string;
}

export interface FortnoxFinancialYear {
  readonly id: number;
  readonly from: string;
  readonly to: string;
}

export interface FortnoxDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Tidsgräns per anrop, ms. Standard 30 000. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Egna gränsen: 20 anrop per 5 sekunder (Fortnox: 25). */
export const RATE_WINDOW_MS = 5_000;
export const RATE_MAX = 20;
const MAX_429_RETRIES = 4;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Öre som kronor med två decimaler (heltalsräkning: 304980 → 3049.8). */
export function kronor(ore: number): number {
  if (!Number.isSafeInteger(ore) || ore < 0) throw new RangeError("Beloppet ska vara öre ≥ 0.");
  return Number(`${Math.trunc(ore / 100)}.${String(ore % 100).padStart(2, "0")}`);
}

function clean(text: string, max: number): string {
  // Styrtecken bort; Fortnox tar inte emot dem i texter.
  const flat = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

/** Verifikatet som Fortnox vill ha det. Kastar om det inte balanserar. */
export function voucherBody(input: FortnoxVoucherInput): unknown {
  let sum = 0;
  for (const r of input.rows) {
    if (!Number.isSafeInteger(r.amountOre) || r.amountOre === 0) {
      throw new RangeError("Varje rad ska ha ett belopp i hela ören som inte är 0.");
    }
    if (!/^[1-9]\d{3}$/.test(r.account)) throw new RangeError(`Ogiltigt konto: ${r.account}.`);
    sum += r.amountOre;
  }
  if (input.rows.length < 2) throw new RangeError("Ett verifikat har minst två rader.");
  if (sum !== 0) throw new RangeError(`Verifikatet balanserar inte (${sum} öre).`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new RangeError("Ogiltigt datum.");
  return {
    Voucher: {
      Description: clean(input.description, 200),
      TransactionDate: input.date,
      VoucherSeries: input.series,
      VoucherRows: input.rows.map((r) => ({
        Account: Number(r.account),
        Debit: r.amountOre > 0 ? kronor(r.amountOre) : 0,
        Credit: r.amountOre < 0 ? kronor(-r.amountOre) : 0,
        TransactionInformation: clean(r.text, 100),
      })),
    },
  };
}

interface ErrorBody {
  readonly code: number | null;
  readonly message: string;
}

function errorBody(raw: unknown): ErrorBody {
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const info = (
    root.ErrorInformation && typeof root.ErrorInformation === "object"
      ? root.ErrorInformation
      : root
  ) as Record<string, unknown>;
  const code = Number(info.code ?? info.Code);
  const message = info.message ?? info.Message ?? root.error_description ?? root.error;
  return {
    code: Number.isSafeInteger(code) ? code : null,
    message: typeof message === "string" ? clean(message, 300) : "",
  };
}

/** Sorterar ett felsvar. Felkoderna är Fortnox egna; texterna är reserv när koden saknas. */
export function classifyError(status: number, body: ErrorBody): FortnoxErrorKind {
  const text = body.message.toLowerCase();
  if (status === 429) return "rate_limited";
  if (status === 401 || body.code === 2000310 || body.code === 2000311) return "unauthorized";
  if (body.code === 2000663 || body.code === 2001101 || body.code === 2001103) return "forbidden";
  if (status >= 500) return "server";
  if (body.code === 2000401 || /låst|locked/.test(text)) return "locked_period";
  if (/räkenskapsår|bokföringsår|financial ?year/.test(text)) return "no_financial_year";
  if (/verifikationsserie|voucher ?series/.test(text)) return "unknown_series";
  if (body.code === 2000423 || body.code === 2001304 || /konto|account/.test(text)) {
    return "unknown_account";
  }
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "invalid";
}

/** Delas av alla klienter mot samma Fortnox-konto i processen. */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly max = RATE_MAX,
    private readonly windowMs = RATE_WINDOW_MS,
  ) {}

  /** Väntar tills ett anrop får göras. Anropen släpps i tur och ordning. */
  take(): Promise<void> {
    const next = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        while (this.stamps.length > 0 && t - this.stamps[0]! >= this.windowMs) this.stamps.shift();
        if (this.stamps.length < this.max) {
          this.stamps.push(t);
          return;
        }
        await this.sleep(this.windowMs - (t - this.stamps[0]!) + 5);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function basic(config: FortnoxConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`;
}

interface TimedResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly retryAfter: string | null;
  /** Hela svaret som text, eller null om det inte gick att läsa klart i tid. */
  readonly text: string | null;
}

/** Anropet och HELA svaret inom tidsgränsen. null = inget svar alls. */
async function timedFetch(
  deps: FortnoxDeps,
  url: string,
  init: RequestInit,
): Promise<TimedResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await (deps.fetch ?? fetch)(url, { ...init, signal: controller.signal });
    let text: string | null = null;
    try {
      text = await response.text();
    } catch {
      text = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      retryAfter: response.headers.get("retry-after"),
      text,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string | null): { value: unknown; readable: boolean } {
  if (text === null) return { value: null, readable: false };
  if (text === "") return { value: null, readable: true };
  try {
    return { value: JSON.parse(text), readable: true };
  } catch {
    return { value: null, readable: false };
  }
}

async function tokenRequest(
  config: FortnoxConfig,
  deps: FortnoxDeps,
  form: Record<string, string>,
): Promise<FortnoxTokens> {
  const response = await timedFetch(deps, `${config.authBaseUrl}/oauth-v1/token`, {
    method: "POST",
    headers: {
      authorization: basic(config),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!response) throw new FortnoxAuthError("temporary", "Fortnox svarade inte.");
  const body = parseJson(response.text).value;
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof o.error === "string" ? o.error : "";
    if (response.status >= 500 || response.status === 429) {
      throw new FortnoxAuthError("temporary", `Fortnox svarade ${response.status}.`);
    }
    if (error === "invalid_client" || response.status === 401) {
      throw new FortnoxAuthError(
        "invalid_client",
        "Fortnox godtar inte appens Client-Id eller Client-Secret.",
      );
    }
    // Koden eller refresh-token gäller inte (längre). Fortnox dokumenterar inte felsvarets
    // form: "invalid_grant" eller en text om ogiltig token/kod räknas hit. Ett annat 4xx
    // (t.ex. från en mellanserver) är tillfälligt, så att kopplingen inte bryts i onödan.
    const description = typeof o.error_description === "string" ? o.error_description : "";
    if (error === "invalid_grant" || /invalid|expired|revoked/i.test(`${error} ${description}`)) {
      throw new FortnoxAuthError("invalid_grant", "Fortnox godtar inte längre kopplingen.");
    }
    throw new FortnoxAuthError("temporary", `Fortnox svarade ${response.status}.`);
  }
  const expiresIn = Number(o.expires_in);
  if (
    typeof o.access_token !== "string" ||
    typeof o.refresh_token !== "string" ||
    !o.access_token ||
    !o.refresh_token ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new FortnoxAuthError("temporary", "Fortnox svar gick inte att läsa.");
  }
  return {
    accessToken: o.access_token,
    refreshToken: o.refresh_token,
    accessExpiresAt: new Date((deps.now ?? Date.now)() + expiresIn * 1000),
  };
}

/** Byter koden från Fortnox mot token (en gång, inom 10 minuter). */
export function exchangeCode(
  config: FortnoxConfig,
  code: string,
  codeVerifier: string,
  deps: FortnoxDeps = {},
): Promise<FortnoxTokens> {
  return tokenRequest(config, deps, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });
}

/** Ny åtkomsttoken. Fortnox byter också refresh-token; den gamla gäller inte efteråt. */
export function refreshTokens(
  config: FortnoxConfig,
  refreshToken: string,
  deps: FortnoxDeps = {},
): Promise<FortnoxTokens> {
  return tokenRequest(config, deps, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Återkallar kopplingen hos Fortnox. Misslyckas den gör det inget: token raderas ändå här. */
export async function revokeRefreshToken(
  config: FortnoxConfig,
  refreshToken: string,
  deps: FortnoxDeps = {},
): Promise<boolean> {
  const response = await timedFetch(deps, `${config.authBaseUrl}/oauth-v1/revoke`, {
    method: "POST",
    headers: {
      authorization: basic(config),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token_type_hint: "refresh_token", token: refreshToken }).toString(),
  });
  return response?.ok === true;
}

/** Adressen dit ägaren skickas för att godkänna kopplingen. */
export function authorizeUrl(
  config: FortnoxConfig,
  scopes: readonly string[],
  state: string,
  codeChallenge: string,
): string {
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: scopes.join(" "),
    state,
    access_type: "offline",
    response_type: "code",
    account_type: "service",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${config.authBaseUrl}/oauth-v1/auth?${q.toString()}`;
}

/** Ger en giltig åtkomsttoken. `force` = den förra togs inte emot: hämta en ny. */
export type TokenSource = (force?: boolean) => Promise<string>;

const limiters = new Map<string, RateLimiter>();

function limiterFor(key: string, deps: FortnoxDeps): RateLimiter {
  if (deps.now || deps.sleep) return new RateLimiter(deps.now ?? Date.now, deps.sleep ?? realSleep);
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(Date.now, realSleep);
    limiters.set(key, limiter);
  }
  return limiter;
}

export class FortnoxClient {
  private readonly limiter: RateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: Pick<FortnoxConfig, "apiBaseUrl">,
    private readonly token: TokenSource,
    private readonly deps: FortnoxDeps = {},
    /** Nyckel för hastighetsgränsen (organisationen): en gräns per Fortnox-konto. */
    limiterKey = "default",
    limiter?: RateLimiter,
  ) {
    this.limiter = limiter ?? limiterFor(limiterKey, deps);
    this.sleep = deps.sleep ?? realSleep;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let refreshed = false;
    let waits = 0;
    for (;;) {
      const token = await this.token(false);
      await this.limiter.take();
      const response = await timedFetch(this.deps, `${this.config.apiBaseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response) {
        throw new FortnoxApiError("network", false, null, null, "Fortnox svarade inte.");
      }
      const { value: parsed, readable } = parseJson(response.text);
      if (response.ok) {
        if (!readable) {
          // Fortnox tog emot anropet men svaret gick inte att läsa: ovisst vad som skapades.
          throw new FortnoxApiError(
            "network",
            false,
            response.status,
            null,
            "Fortnox svar gick inte att läsa.",
          );
        }
        return parsed;
      }
      const info = errorBody(parsed);
      const kind = classifyError(response.status, info);
      if (kind === "rate_limited" && waits < MAX_429_RETRIES) {
        waits += 1;
        const header = Number(response.retryAfter);
        const wait =
          Number.isFinite(header) && header > 0 ? Math.min(header, 30) * 1000 : RATE_WINDOW_MS;
        await this.sleep(wait);
        continue;
      }
      if (kind === "unauthorized" && !refreshed) {
        refreshed = true;
        await this.token(true);
        continue;
      }
      throw new FortnoxApiError(
        kind,
        // Säkert "inget gjordes" bara för ett riktigt nej från Fortnox. 408 och 425 (tidsgräns,
        // för tidigt) kan komma från en mellanserver medan anropet ändå gick fram.
        response.status < 500 && response.status !== 408 && response.status !== 425,
        response.status,
        info.code,
        info.message || `Fortnox svarade ${response.status}.`,
      );
    }
  }

  /** Bolaget i Fortnox: namn och databasnummer (visas efter kopplingen, så att ägaren ser att det är rätt bolag). */
  async company(): Promise<{ name: string | null; tenant: string | null }> {
    const raw = (await this.request("GET", "/3/companyinformation")) as {
      CompanyInformation?: { CompanyName?: unknown; DatabaseNumber?: unknown };
    } | null;
    const name = raw?.CompanyInformation?.CompanyName;
    const tenant = raw?.CompanyInformation?.DatabaseNumber;
    return {
      name: typeof name === "string" && name.trim() ? clean(name, 120) : null,
      tenant:
        typeof tenant === "number" || typeof tenant === "string" ? clean(String(tenant), 40) : null,
    };
  }

  /** Räkenskapsåret som innehåller dagen, eller null om Fortnox inte har något. */
  async financialYearFor(date: string): Promise<FortnoxFinancialYear | null> {
    const raw = (await this.request(
      "GET",
      `/3/financialyears?date=${encodeURIComponent(date)}`,
    )) as { FinancialYears?: unknown } | null;
    const list = Array.isArray(raw?.FinancialYears) ? raw.FinancialYears : [];
    for (const item of list) {
      const y = item as { Id?: unknown; FromDate?: unknown; ToDate?: unknown };
      const id = Number(y.Id);
      if (
        Number.isSafeInteger(id) &&
        typeof y.FromDate === "string" &&
        typeof y.ToDate === "string" &&
        y.FromDate <= date &&
        date <= y.ToDate
      ) {
        return { id, from: y.FromDate, to: y.ToDate };
      }
    }
    return null;
  }

  /** Sista låsta dagen, eller null när ingen period är låst. */
  async lockedUntil(): Promise<string | null> {
    const raw = (await this.request("GET", "/3/settings/lockedperiod")) as {
      LockedPeriod?: { EndDate?: unknown };
    } | null;
    const end = raw?.LockedPeriod?.EndDate;
    return typeof end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null;
  }

  /** 'ok', 'inactive' eller 'missing' för ett konto i Fortnox kontoplan. */
  async accountState(account: string, yearId: number): Promise<"ok" | "inactive" | "missing"> {
    try {
      const raw = (await this.request(
        "GET",
        `/3/accounts/${encodeURIComponent(account)}?financialyear=${yearId}`,
      )) as { Account?: { Active?: unknown } } | null;
      if (!raw?.Account) return "missing";
      return raw.Account.Active === false ? "inactive" : "ok";
    } catch (error) {
      if (
        error instanceof FortnoxApiError &&
        (error.kind === "not_found" || error.kind === "unknown_account")
      ) {
        return "missing";
      }
      throw error;
    }
  }

  /** Verifikationsseriernas koder i Fortnox. */
  async voucherSeries(yearId: number): Promise<string[]> {
    const raw = (await this.request("GET", `/3/voucherseries?financialyear=${yearId}`)) as {
      VoucherSeriesCollection?: unknown;
    } | null;
    const list = Array.isArray(raw?.VoucherSeriesCollection) ? raw.VoucherSeriesCollection : [];
    return list
      .map((x) => (x as { Code?: unknown }).Code)
      .filter((c): c is string => typeof c === "string");
  }

  /** Skapar verifikatet. Fortnox har ingen spärr mot dubbletter: anroparen ansvarar för den. */
  async createVoucher(input: FortnoxVoucherInput, yearId: number): Promise<FortnoxVoucherRef> {
    const raw = (await this.request(
      "POST",
      `/3/vouchers?financialyear=${yearId}`,
      voucherBody(input),
    )) as { Voucher?: { VoucherNumber?: unknown; VoucherSeries?: unknown; Year?: unknown } } | null;
    const number = Number(raw?.Voucher?.VoucherNumber);
    const series = raw?.Voucher?.VoucherSeries;
    if (!Number.isSafeInteger(number) || number < 1 || typeof series !== "string") {
      // Skapat, men numret gick inte att läsa: ovisst, letas upp vid nästa körning.
      throw new FortnoxApiError(
        "network",
        false,
        201,
        null,
        "Fortnox svar saknar verifikatnummer.",
      );
    }
    return { series, number, year: yearId };
  }

  /** Verifikaten i serien mellan två datum (alla sidor). */
  async listVouchers(
    series: string,
    yearId: number,
    from: string,
    to: string,
  ): Promise<FortnoxVoucherListed[]> {
    const out: FortnoxVoucherListed[] = [];
    for (let page = 1; page <= 200; page += 1) {
      const raw = (await this.request(
        "GET",
        `/3/vouchers/sublist/${encodeURIComponent(series)}?financialyear=${yearId}` +
          `&fromdate=${from}&todate=${to}&limit=500&page=${page}`,
      )) as { Vouchers?: unknown; MetaInformation?: Record<string, unknown> } | null;
      const list = Array.isArray(raw?.Vouchers) ? raw.Vouchers : [];
      for (const item of list) {
        const v = item as Record<string, unknown>;
        const number = Number(v.VoucherNumber);
        if (!Number.isSafeInteger(number)) continue;
        out.push({
          series: typeof v.VoucherSeries === "string" ? v.VoucherSeries : series,
          number,
          year: yearId,
          date: typeof v.TransactionDate === "string" ? v.TransactionDate : "",
          description: typeof v.Description === "string" ? v.Description : "",
        });
      }
      const pages = Number(raw?.MetaInformation?.["@TotalPages"]);
      // Saknas sidantalet läses nästa sida så länge sidan var full.
      if (Number.isFinite(pages) ? page >= pages : list.length < 500) return out;
    }
    throw new FortnoxApiError("invalid", true, null, null, "För många sidor i Fortnox svar.");
  }
}
