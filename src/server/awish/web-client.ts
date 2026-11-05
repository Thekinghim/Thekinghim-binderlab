/**
 * Klient mot Awishs webbpanel (dash.awish.vip). Den officiella gRPC-kopplingen
 * (grpc-client.ts) kan bara läsa lager. Panelen själv skriver lager via ett GraphQL-API
 * på samma adress, och den här klienten gör samma anrop med butikens egen inloggning
 * (e-post och lösenord) så att Binderlab kan skicka påfyllningar till Awish. Då slipper
 * ägaren gå in på Awish och skriva antal för hand.
 *
 * Bara det Binderlab behöver: logga in (Signin), förnya token (RefreshToken), lista
 * automater (Machines) och fack (Products), och sätta ett facks antal (UpdateProduct).
 * Varje anrop skickar panelens headers och en signerad, base64-kodad payload (web-sign.ts).
 *
 * Nätverksadressen och appid/appKey kommer ur miljön men har panelens publika standard
 * som förval. Basadressen går att skicka in, så testerna kör mot en lokal låtsas-server
 * (testing/fake-web-server.ts) och aldrig mot riktiga Awish.
 */

import { AwishApiError, type AwishErrorKind } from "./grpc-client";
import {
  awishPriceToOre,
  type AwishGoodSummary,
  type AwishSlot,
  type GoodImage,
  type GoodInput,
} from "./goods";
import {
  CREATE_GOOD_DOCUMENT,
  GOOD_IMAGE_UPLOAD_FIELDS,
  GOODS_DOCUMENT,
  PRODUCTS_DOCUMENT,
  PROFILE_DOCUMENT,
  UNITS_AND_CURRENCIES_DOCUMENT,
  UPLOAD_PATH,
} from "./web-documents";
import { AWISH_WEB_APP_KEY, awishEncode } from "./web-sign";

export const DEFAULT_AWISH_WEB_BASE_URL = "https://dash.awish.vip";
export const AWISH_WEB_APP_ID = "dsc6805f597d8c411e";
export const AWISH_WEB_APP_VERSION = "1.30.4";

export interface AwishWebLogin {
  readonly email: string;
  readonly password: string;
}

export interface AwishWebTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Sekunder tills access-token går ut (panelens expires_in). */
  readonly expiresIn: number;
}

/** Ett fack i en automat enligt panelen (Products). */
export interface AwishWebProduct {
  readonly id: number;
  readonly goodId: number | null;
  readonly goodName: string | null;
  readonly status: boolean;
  readonly currentInventory: number;
  /** Fackets kapacitet (channel.total), eller null när panelen inte uppger den. */
  readonly capacity: number | null;
  readonly channelName: string | null;
}

/** En automat enligt panelen (Machines/MachinesLite). */
export interface AwishWebMachine {
  readonly id: number;
  readonly machineNo: string | null;
  readonly name: string | null;
}

/** En sida varor ur panelens Goods. */
export interface AwishGoodsPage {
  readonly total: number;
  readonly currentPage: number;
  readonly lastPage: number;
  readonly goods: AwishGoodSummary[];
}

/** En valuta hos butiken (UnitsAndCurrencies). */
export interface AwishCurrency {
  readonly id: number;
  readonly code: string;
  readonly name: string | null;
}

/**
 * Panelens adress ur miljön (AWISH_WEB_BASE_URL), annars den riktiga. Används för att köra
 * appen lokalt mot låtsas-panelen; i drift krävs https så att inloggningen aldrig går okrypterad.
 */
export function awishWebBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.AWISH_WEB_BASE_URL?.trim();
  if (!raw) return DEFAULT_AWISH_WEB_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_AWISH_WEB_BASE_URL;
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    url.protocol === "https:" ||
    (url.protocol === "http:" && local && env.NODE_ENV !== "production")
  ) {
    return url.origin;
  }
  return DEFAULT_AWISH_WEB_BASE_URL;
}

export interface AwishWebClientOptions {
  readonly baseUrl?: string;
  readonly appId?: string;
  readonly appKey?: string;
  readonly appVersion?: string;
  readonly lang?: string;
  readonly timeoutMs?: number;
  /** Klocka i ms; injiceras i tester (annars Date.now). */
  readonly now?: () => number;
  /** fetch; injiceras i tester (annars global fetch). */
  readonly fetch?: typeof fetch;
}

interface GraphqlError {
  message?: string;
  extensions?: { code?: string; category?: string } | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Översätter GraphQL/HTTP-fel till Binderlabs feltyp och svenska meddelanden. */
function toApiError(message: string, kind: AwishErrorKind): AwishApiError {
  return new AwishApiError(kind, message);
}

function classifyGraphqlError(errors: GraphqlError[]): AwishApiError {
  const first = errors[0];
  const raw = (first?.message ?? "").trim();
  const code = (first?.extensions?.code ?? "").toUpperCase();
  const lowered = raw.toLowerCase();
  if (
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    /unauthenticated|unauthorized|token|invalid credentials|incorrect|password|login/.test(lowered)
  ) {
    return toApiError(
      raw && !/token/i.test(raw)
        ? `Awish nekade inloggningen: ${raw}`
        : "Awish nekade inloggningen. Kontrollera e-post och lösenord under Datakällor.",
      "auth",
    );
  }
  if (code === "FORBIDDEN" || /forbidden|permission|not allowed/.test(lowered)) {
    return toApiError("Awish-kontot saknar behörighet för den åtgärden.", "auth");
  }
  if (/not found|does not exist/.test(lowered)) {
    return toApiError(raw || "Awish hittade inte posten.", "server");
  }
  return toApiError(
    raw ? `Awish svarade med ett fel: ${raw}` : "Awish svarade med ett fel.",
    "server",
  );
}

/** Panelens sidstorlek för varor (dialogen "Välj vara"). */
const GOODS_PER_PAGE = 20;
/** Högst så många sidor varor läses (1 000 varor). */
const MAX_GOODS_PAGES = 50;

/** En vara ur Goods: SEK-priset (annars första priset) i öre. */
function goodSummary(g: Record<string, unknown>): AwishGoodSummary {
  const prices = Array.isArray(g.prices) ? (g.prices as Array<Record<string, unknown>>) : [];
  const code = (p: Record<string, unknown>) =>
    String((p.currency as { code?: unknown } | null)?.code ?? "").toUpperCase();
  const sek = prices.find((p) => code(p) === "SEK") ?? prices[0];
  return {
    id: Number(g.id),
    name: String(g.name ?? ""),
    priceOre: awishPriceToOre(sek?.price ?? g.price),
    thumb: typeof g.thumb === "string" && g.thumb !== "" ? g.thumb : null,
  };
}

export interface AwishWebApi {
  /** Loggar in och håller tokens i klienten. Returnerar även token för att spara. */
  login(login: AwishWebLogin): Promise<AwishWebTokens>;
  /** Sätter en token som redan sparats (hoppar över inloggning tills den går ut). */
  useTokens(tokens: AwishWebTokens): void;
  machines(): Promise<AwishWebMachine[]>;
  products(machineId: number): Promise<AwishWebProduct[]>;
  /** Inloggad butik (Profile): butikens merchant-id. */
  profile(): Promise<{ merchantId: number }>;
  /** Butikens valutor (UnitsAndCurrencies). */
  currencies(merchantId: number): Promise<AwishCurrency[]>;
  /** En sida varor (Goods, 20 per sida som panelen). */
  goods(page: number): Promise<AwishGoodsPage>;
  /** Alla varor, sida för sida (högst `maxPages` sidor). */
  allGoods(maxPages?: number): Promise<AwishGoodSummary[]>;
  /** Laddar upp en varubild som panelen gör. Returnerar bildens adress (file_url). */
  uploadImage(image: GoodImage): Promise<string>;
  /** Skapar en vara (CreateGood). Svaret är panelens skalära värde. */
  createGood(input: GoodInput): Promise<unknown>;
  /** En automats fack med vara, status, felstatus, antal och kapacitet (Products). */
  slots(machineId: number): Promise<AwishSlot[]>;
  /** Sätter ett facks antal (absolut). Panelens UpdateProduct. */
  setProductInventory(
    id: number,
    input: { goodId: number | null; status: boolean; currentInventory: number },
  ): Promise<void>;
}

export function createAwishWebClient(options: AwishWebClientOptions = {}): AwishWebApi {
  const baseUrl = (options.baseUrl ?? awishWebBaseUrlFromEnv()).replace(/\/+$/, "");
  const appId = options.appId ?? AWISH_WEB_APP_ID;
  const appKey = options.appKey ?? AWISH_WEB_APP_KEY;
  const appVersion = options.appVersion ?? AWISH_WEB_APP_VERSION;
  const lang = options.lang ?? "en-US";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const doFetch = options.fetch ?? fetch;

  let tokens: AwishWebTokens | null = null;

  async function call<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    opts: { auth: boolean } = { auth: true },
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/graphql-response+json, application/json",
      Appid: appId,
      "APP-VERSION": appVersion,
      "X-Sent-At-Time": now().toString(),
      Lang: lang,
      Authorization: opts.auth && tokens ? `Bearer ${tokens.accessToken}` : "",
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operationName, query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw toApiError(`Awish svarade inte inom ${Math.round(timeoutMs / 1000)} s.`, "timeout");
      }
      throw toApiError("Kunde inte nå Awish. Försök igen om en stund.", "unavailable");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw toApiError(
        "Awish nekade inloggningen. Kontrollera e-post och lösenord under Datakällor.",
        "auth",
      );
    }
    if (res.status >= 500) {
      throw toApiError("Awish svarar inte just nu. Försök igen om en stund.", "unavailable");
    }
    let body: { data?: Record<string, unknown>; errors?: GraphqlError[] };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw toApiError("Awish svarade med något oväntat.", "server");
    }
    if (body.errors && body.errors.length > 0) throw classifyGraphqlError(body.errors);
    if (!body.data) throw toApiError("Awish svarade utan data.", "server");
    return body.data as T;
  }

  const SIGNIN = `mutation Signin($input: String!) { signin(input: $input) { access_token refresh_token expires_in } }`;
  const MACHINES = `query MachinesLite { machinesLite { id machine_no name } }`;
  const PRODUCTS = `query Products($input: String!) { products(input: $input) { id good_id status current_inventory good { id name } channel { name total } } }`;
  const UPDATE_PRODUCT = `mutation UpdateProduct($id: Int!, $input: ProductInput!) { updateProduct(id: $id, input: $input) }`;

  function tokensFrom(raw: unknown): AwishWebTokens {
    const r = (raw ?? {}) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!r.access_token) throw toApiError("Awish gav ingen token vid inloggningen.", "auth");
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? "",
      expiresIn: Number(r.expires_in ?? 0),
    };
  }

  const api: AwishWebApi = {
    async login(login) {
      const input = awishEncode({ email: login.email, password: login.password }, appKey, now());
      const data = await call<{ signin: unknown }>("Signin", SIGNIN, { input }, { auth: false });
      tokens = tokensFrom(data.signin);
      return tokens;
    },

    useTokens(t) {
      tokens = t;
    },

    async machines() {
      const data = await call<{ machinesLite: Array<Record<string, unknown>> }>(
        "MachinesLite",
        MACHINES,
        {},
      );
      return (data.machinesLite ?? []).map((m) => ({
        id: Number(m.id),
        machineNo: m.machine_no == null ? null : String(m.machine_no),
        name: m.name == null ? null : String(m.name),
      }));
    },

    async products(machineId) {
      // Panelen skickar machine_id som signerad base64-sträng i "input".
      const input = awishEncode({ machine_id: machineId.toString() }, appKey, now());
      const data = await call<{ products: Array<Record<string, unknown>> }>("Products", PRODUCTS, {
        input,
      });
      return (data.products ?? []).map((p) => {
        const good = (p.good ?? null) as { id?: unknown; name?: unknown } | null;
        const channel = (p.channel ?? null) as { name?: unknown; total?: unknown } | null;
        return {
          id: Number(p.id),
          goodId: good?.id == null ? null : Number(good.id),
          goodName: good?.name == null ? null : String(good.name),
          status: Boolean(p.status),
          currentInventory: Number(p.current_inventory ?? 0),
          capacity: channel?.total == null ? null : Number(channel.total),
          channelName: channel?.name == null ? null : String(channel.name),
        };
      });
    },

    async profile() {
      const data = await call<{ profile: { merchant?: { id?: unknown } | null } | null }>(
        "Profile",
        PROFILE_DOCUMENT,
        {},
      );
      const id = Number(data.profile?.merchant?.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw toApiError("Awish-kontot hör inte till någon butik.", "server");
      }
      return { merchantId: id };
    },

    async currencies(merchantId) {
      const data = await call<{ currencies: Array<Record<string, unknown>> | null }>(
        "UnitsAndCurrencies",
        UNITS_AND_CURRENCIES_DOCUMENT,
        { input: { merchant_id: merchantId } },
      );
      return (data.currencies ?? []).map((c) => ({
        id: Number(c.id),
        code: String(c.code ?? "").toUpperCase(),
        name: c.name == null ? null : String(c.name),
      }));
    },

    async goods(page) {
      const data = await call<{ goods: Record<string, unknown> | null }>("Goods", GOODS_DOCUMENT, {
        input: { per_page: GOODS_PER_PAGE, current_page: page },
      });
      const g = data.goods ?? {};
      const rows = Array.isArray(g.data) ? (g.data as Array<Record<string, unknown>>) : [];
      return {
        total: Number(g.total ?? rows.length),
        currentPage: Number(g.currentPage ?? page),
        lastPage: Number(g.lastPage ?? page),
        goods: rows.map(goodSummary),
      };
    },

    async allGoods(maxPages = MAX_GOODS_PAGES) {
      const out: AwishGoodSummary[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const p = await api.goods(page);
        out.push(...p.goods);
        if (p.goods.length === 0 || page >= p.lastPage) return out;
      }
      throw toApiError(
        `Awish har fler än ${maxPages * GOODS_PER_PAGE} varor. Det klarar Binderlab inte än.`,
        "server",
      );
    },

    async uploadImage(image) {
      if (!tokens) throw toApiError("Logga in på Awish först.", "auth");
      const form = new FormData();
      // Samma fält och ordning som panelens uppladdning (Naive UI: data först, filen sist).
      for (const [k, v] of Object.entries(GOOD_IMAGE_UPLOAD_FIELDS)) form.append(k, v);
      form.append(
        "file",
        new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.type }),
        image.fileName,
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${UPLOAD_PATH}`, {
          method: "POST",
          // Panelen skickar token utan "Bearer" och tiden i sekunder vid uppladdning.
          headers: {
            Authorization: tokens.accessToken,
            Appid: appId,
            timestamp: Math.ceil(now() / 1000).toString(),
          },
          body: form,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw toApiError(`Awish svarade inte inom ${Math.round(timeoutMs / 1000)} s.`, "timeout");
        }
        throw toApiError("Kunde inte nå Awish. Försök igen om en stund.", "unavailable");
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401 || res.status === 403) {
        throw toApiError("Awish nekade uppladdningen av bilden. Logga in igen.", "auth");
      }
      if (res.status === 413)
        throw toApiError("Awish tog inte emot bilden: den är för stor.", "server");
      if (res.status >= 500) {
        throw toApiError("Awish svarar inte just nu. Försök igen om en stund.", "unavailable");
      }
      let body: Record<string, unknown>;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        throw toApiError("Awish svarade med något oväntat på bilden.", "server");
      }
      const url = typeof body.file_url === "string" ? body.file_url : "";
      if (res.status >= 400 || !/^https?:\/\//.test(url)) {
        const msg = typeof body.message === "string" ? body.message : "";
        throw toApiError(
          msg ? `Awish tog inte emot bilden: ${msg}` : "Awish tog inte emot bilden.",
          "server",
        );
      }
      return url;
    },

    async createGood(input) {
      const data = await call<{ createGood: unknown }>("CreateGood", CREATE_GOOD_DOCUMENT, {
        input,
      });
      if (data.createGood === false || data.createGood == null) {
        throw toApiError("Awish skapade inte varan.", "server");
      }
      return data.createGood;
    },

    async slots(machineId) {
      const input = awishEncode({ machine_id: machineId.toString() }, appKey, now());
      const data = await call<{ products: Array<Record<string, unknown>> | null }>(
        "Products",
        PRODUCTS_DOCUMENT,
        { input },
      );
      return (data.products ?? []).map((p) => {
        const good = (p.good ?? null) as { id?: unknown; name?: unknown } | null;
        const channel = (p.channel ?? null) as { name?: unknown; total?: unknown } | null;
        const inventory = p.inventory == null ? null : Number(p.inventory);
        const total = channel?.total == null ? null : Number(channel.total);
        const capacity =
          inventory != null && Number.isFinite(inventory) && inventory > 0
            ? inventory
            : total != null && Number.isFinite(total) && total > 0
              ? total
              : null;
        return {
          id: Number(p.id),
          channelName: channel?.name == null ? null : String(channel.name),
          goodId: good?.id == null ? null : Number(good.id),
          goodName: good?.name == null ? null : String(good.name),
          status: Boolean(p.status),
          floorStatus: p.floor_status == null ? null : String(p.floor_status),
          currentInventory: Number(p.current_inventory ?? 0),
          capacity,
        };
      });
    },

    async setProductInventory(id, input) {
      await call<{ updateProduct: unknown }>("UpdateProduct", UPDATE_PRODUCT, {
        id,
        input: {
          good_id: input.goodId,
          status: input.status,
          current_inventory: input.currentInventory,
        },
      });
    },
  };
  return api;
}
