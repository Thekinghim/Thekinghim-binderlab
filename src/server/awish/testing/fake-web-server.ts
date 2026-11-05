/**
 * Låtsas-Awish webbpanel för testerna: en riktig http-server på 127.0.0.1 som härmar
 * dash.awish.vip (GraphQL på /graphql och bilduppladdning på /api/v1/files). Den
 * kontrollerar Appid-headern och att payloaden är signerad (web-sign.ts), loggar in med
 * e-post/lösenord och håller varor och fack i minnet.
 *
 * Den är lika sträng som riktiga Awish om formen: varje GraphQL-dokument jämförs med
 * panelens eget (dashboard-documents.ts) och nekas om operationen, variablerna, argumenten
 * eller urvalet avviker (t.ex. ett urval på en skalär mutation, som riktiga Awish nekade).
 * Indata (GoodInput, ProductInput, GoodsQueryInput) kontrolleras fält för fält, och svaren
 * innehåller bara de fält som frågades efter.
 *
 * Används av enhetstester, databastester och lokalt i dev (scripts/dev/fake-awish-web.ts);
 * aldrig av appen i drift, och den når aldrig riktiga Awish.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { AWISH_WEB_APP_KEY, awishCheckSignature, awishDecode } from "../web-sign";

import {
  DASHBOARD_DOCUMENTS,
  GOOD_INPUT_FIELDS,
  GOOD_PRICE_FIELDS,
  GOODS_QUERY_FIELDS,
  PRODUCT_INPUT_FIELDS,
  PROVEN_EXTRA_FIELDS,
  UPLOAD_FIELDS,
} from "./dashboard-documents";
import {
  checkOperationShape,
  GqlShapeError,
  parseOperation,
  project,
  type GqlField,
} from "./graphql-shape";

export interface FakeWebProduct {
  id: number;
  goodId: number | null;
  goodName: string | null;
  status: boolean;
  currentInventory: number;
  capacity: number | null;
  channelName: string | null;
  /** Panelens floor_status; standard "ERR_NORMAL". */
  floorStatus?: string;
  /** Fackets egen kapacitet (product.inventory); annars används capacity (channel.total). */
  inventory?: number | null;
}

export interface FakeWebMachine {
  id: number;
  machineNo: string | null;
  name: string | null;
}

export interface FakeWebGood {
  id: number;
  name: string;
  /** Pris i SEK som Awish svarar med (decimalsträng, t.ex. "79.00"). */
  price: string;
  thumb: string;
  media: string[];
  description: string;
  content: string;
}

export interface FakeWebUpload {
  fields: Record<string, string>;
  fileName: string;
  type: string;
  size: number;
  url: string;
}

export interface FakeWebState {
  appId: string;
  appKey: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  merchantId: number;
  /** Är kontot panelens root (bara root får CreateProduct, "synka fack"). */
  isRoot: boolean;
  currencies: Array<{ id: number; name: string; code: string; symbol: string }>;
  machines: FakeWebMachine[];
  /** Fack per Awish-automat (machine_id som sträng). */
  products: Record<string, FakeWebProduct[]>;
  goods: FakeWebGood[];
  nextGoodId: number;
  /** Vad createGood svarar med (riktiga Awish: ett skalärt värde; standard true). */
  createGoodResult: unknown;
  /** Kategorier per automat (machine_id som sträng). */
  categories: Record<string, Array<{ id: number; title: string }>>;
  uploads: FakeWebUpload[];
  /** Antal kommande anrop som svarar med HTTP 503 (Awish nere). */
  failNext: number;
  /** GraphQL-fel att svara med vid nästa anrop (töms efter ett anrop). */
  nextError: { message: string; code?: string } | null;
  /** GraphQL-fel för en viss operation (töms när det använts). */
  failOn: Record<string, { message: string; code?: string }>;
  /** HTTP-status för nästa uppladdning (töms efter en). */
  uploadFailStatus: number | null;
  /** Logg över anropen, för att prova vad som faktiskt skickades. */
  calls: Array<{
    operationName: string;
    variables: Record<string, unknown>;
    token: string | null;
    query?: string;
  }>;
  /** Anrop som nekades för fel form (meddelandet). */
  rejected: string[];
}

export interface FakeWeb {
  baseUrl: string;
  state: FakeWebState;
  stop(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** GraphQL-koercering av ett indataobjekt: okända fält och fel typer nekas. */
function checkInputObject(
  typeName: string,
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GqlShapeError(
      `Variable "$input" got invalid value; Expected type "${typeName}" to be an object.`,
    );
  }
  for (const k of Object.keys(value)) {
    if (!allowed.includes(k)) {
      throw new GqlShapeError(
        `Variable "$input" got invalid value; Field "${k}" is not defined by type "${typeName}".`,
      );
    }
  }
  return value as Record<string, unknown>;
}

function checkGoodInput(input: unknown, currencyIds: number[]): Record<string, unknown> {
  const g = checkInputObject("GoodInput", input, GOOD_INPUT_FIELDS);
  const bad = (f: string, why: string) =>
    new GqlShapeError(`Variable "$input" got invalid value at "input.${f}"; ${why}`);
  for (const f of GOOD_INPUT_FIELDS) {
    if (!(f in g)) throw bad(f, `Field "${f}" is missing.`);
  }
  for (const f of ["name", "description", "thumb", "content", "slug"] as const) {
    if (typeof g[f] !== "string") throw bad(f, "String cannot represent a non string value.");
  }
  if ((g.name as string).trim() === "") throw bad("name", "name is required.");
  if (!Array.isArray(g.media) || g.media.some((m) => typeof m !== "string")) {
    throw bad("media", "Expected [String!].");
  }
  for (const f of ["multi_currency_enabled", "is_tax_exempt", "is_returnable"] as const) {
    if (typeof g[f] !== "boolean") throw bad(f, "Boolean cannot represent a non boolean value.");
  }
  if (g.unit_id !== null && !isInt(g.unit_id)) {
    throw bad("unit_id", "Int cannot represent non-integer value.");
  }
  if (!isNum(g.tax_rate)) throw bad("tax_rate", "Float cannot represent non numeric value.");
  if (!Array.isArray(g.attributes)) throw bad("attributes", "Expected list.");
  if (!Array.isArray(g.prices) || g.prices.length === 0) throw bad("prices", "prices is required.");
  g.prices.forEach((p, i) => {
    const price = checkInputObject("GoodPriceInput", p, GOOD_PRICE_FIELDS);
    for (const f of ["price", "original_price", "member_price", "cost_price"] as const) {
      if (!isNum(price[f])) {
        throw bad(`prices[${i}].${f}`, "Float cannot represent non numeric value.");
      }
    }
    if (!isInt(price.id)) throw bad(`prices[${i}].id`, "Int cannot represent non-integer value.");
    if (!isInt(price.currency_id) || !currencyIds.includes(price.currency_id)) {
      throw bad(`prices[${i}].currency_id`, "currency not found.");
    }
    if ((price.price as number) < 0.01) {
      throw bad(`prices[${i}].price`, "price must be at least 0.01.");
    }
  });
  return g;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startFakeAwishWeb(
  initial: Partial<FakeWebState> = {},
  options: { port?: number } = {},
): Promise<FakeWeb> {
  const state: FakeWebState = {
    appId: "dsc6805f597d8c411e",
    appKey: AWISH_WEB_APP_KEY,
    email: "butik@example.com",
    password: "hemligt",
    accessToken: "access-token-test",
    refreshToken: "refresh-token-test",
    merchantId: 77,
    isRoot: false,
    currencies: [
      { id: 1, name: "US Dollar", code: "USD", symbol: "$" },
      { id: 2, name: "Svensk krona", code: "SEK", symbol: "kr" },
    ],
    machines: [{ id: 1001, machineNo: "BL-001", name: "Sega gubbens automat" }],
    products: {},
    goods: [],
    nextGoodId: 500,
    createGoodResult: true,
    categories: {},
    uploads: [],
    failNext: 0,
    nextError: null,
    failOn: {},
    uploadFailStatus: null,
    calls: [],
    rejected: [],
    ...initial,
  };
  // Varor som facken redan har finns också i varulistan.
  for (const list of Object.values(state.products)) {
    for (const p of list) {
      if (p.goodId != null && !state.goods.some((g) => g.id === p.goodId)) {
        state.goods.push({
          id: p.goodId,
          name: p.goodName ?? `Vara ${p.goodId}`,
          price: "49.00",
          thumb: "",
          media: [],
          description: "",
          content: "",
        });
      }
    }
  }

  let baseUrl = "";

  const sek = () => state.currencies.find((c) => c.code === "SEK") ?? state.currencies[0]!;
  const goodJson = (g: FakeWebGood) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    price: g.price,
    original_price: "0.00",
    multi_currency_enabled: false,
    prices: [
      {
        id: g.id * 10,
        price: g.price,
        original_price: "0.00",
        member_price: "0.00",
        cost_price: "0.00",
        currency: sek(),
      },
    ],
    thumb: g.thumb,
    media: g.media,
    content: g.content,
    slug: `good-${g.id}`,
    updated_at: "2026-11-05 10:00:00",
    age_verification_enabled: false,
    age_verification_min: 0,
    unit: null,
    attributes: [],
    is_tax_exempt: true,
    tax_rate: "0.00",
    is_returnable: false,
    category_id: null,
  });

  async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (state.uploadFailStatus) {
      const status = state.uploadFailStatus;
      state.uploadFailStatus = null;
      send(res, status, { message: "upload failed" });
      return;
    }
    // Panelens uppladdning: token utan "Bearer", Appid och tiden i sekunder.
    if (req.headers["appid"] !== state.appId) {
      send(res, 401, { message: "appid is missing" });
      return;
    }
    if (req.headers["authorization"] !== state.accessToken) {
      send(res, 401, { message: "Unauthenticated." });
      return;
    }
    if (!/^\d{10}$/.test(String(req.headers["timestamp"] ?? ""))) {
      send(res, 422, { message: "timestamp is required" });
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "");
    if (!contentType.startsWith("multipart/form-data")) {
      send(res, 422, { message: "multipart/form-data required" });
      return;
    }
    let form: FormData;
    try {
      form = await new Request("http://fake/upload", {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Uint8Array(body),
      }).formData();
    } catch {
      send(res, 422, { message: "bad multipart body" });
      return;
    }
    const fields: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (k === "file") continue;
      if (!(UPLOAD_FIELDS as readonly string[]).includes(k) || typeof v !== "string") {
        send(res, 422, { message: `unknown field ${k}` });
        return;
      }
      try {
        JSON.parse(v);
      } catch {
        send(res, 422, { message: `${k} must be JSON` });
        return;
      }
      fields[k] = v;
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      send(res, 422, { message: "The file field is required." });
      return;
    }
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["png", "jpg", "jpeg", "webp"].includes(ext) || !file.type.startsWith("image/")) {
      send(res, 422, { message: "The file must be an image." });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      send(res, 413, { message: "The file may not be greater than 5120 kilobytes." });
      return;
    }
    const n = state.uploads.length + 1;
    const url = `${baseUrl}/uploads/${n}.${ext}`;
    state.uploads.push({ fields, fileName: file.name, type: file.type, size: file.size, url });
    send(res, 200, {
      id: n,
      file_url: url,
      file_name: file.name,
      file_size: file.size,
      file_type: file.type,
      file_extension: ext,
    });
  }

  function handleGraphql(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
    if (state.failNext > 0) {
      state.failNext -= 1;
      send(res, 503, { errors: [{ message: "service unavailable" }] });
      return;
    }
    // Awish-mellanprogrammets headerkontroll.
    if (req.headers["appid"] !== state.appId) {
      send(res, 200, {
        errors: [{ message: "appid is missing", extensions: { code: "UNAUTHENTICATED" } }],
      });
      return;
    }
    let payload: { operationName?: string; query?: string; variables?: Record<string, unknown> };
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      send(res, 400, { errors: [{ message: "bad request" }] });
      return;
    }
    const op = payload.operationName ?? "";
    const query = String(payload.query ?? "");
    const variables = payload.variables ?? {};
    const authHeader = req.headers["authorization"];
    const token =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;
    state.calls.push({ operationName: op, variables, token, query });

    const reject = (message: string) => {
      state.rejected.push(message);
      send(res, 200, { errors: [{ message, extensions: { category: "graphql" } }] });
    };

    if (state.nextError) {
      const err = state.nextError;
      state.nextError = null;
      send(res, 200, {
        errors: [{ message: err.message, extensions: err.code ? { code: err.code } : undefined }],
      });
      return;
    }

    // Formen: samma dokument som panelen (operation, variabler, argument, urval).
    let selections: GqlField[];
    const real = DASHBOARD_DOCUMENTS[op];
    try {
      if (op === "MachinesLite") {
        // Klientens äldre automatlista (används inte av appen) kontrolleras inte här.
        selections = parseOperation(query).selections;
      } else if (!real) {
        reject(`Unknown operation "${op}".`);
        return;
      } else {
        selections = checkOperationShape(query, real, PROVEN_EXTRA_FIELDS).selections;
        const declared = parseOperation(real).variables;
        for (const [v, type] of Object.entries(declared)) {
          if (type.endsWith("!") && (variables[v] === undefined || variables[v] === null)) {
            reject(`Variable "$${v}" of required type "${type}" was not provided.`);
            return;
          }
        }
      }
    } catch (error) {
      reject(error instanceof Error ? error.message : "Syntax Error.");
      return;
    }
    const reply = (data: Record<string, unknown>) =>
      send(res, 200, { data: project(data, selections) });

    const failure = state.failOn[op];
    if (failure) {
      delete state.failOn[op];
      send(res, 200, {
        errors: [
          {
            message: failure.message,
            extensions: failure.code ? { code: failure.code } : undefined,
          },
        ],
      });
      return;
    }

    // Signaturen på "input"-strängen kontrolleras, precis som riktiga Awish.
    const checkSignedInput = (): Record<string, unknown> | null => {
      const input = variables.input;
      if (typeof input !== "string") return null;
      let decoded: Record<string, unknown>;
      try {
        decoded = awishDecode(input);
      } catch {
        return null;
      }
      if (!awishCheckSignature(decoded as never, state.appKey)) return null;
      return decoded;
    };

    if (op === "Signin") {
      const decoded = checkSignedInput();
      if (!decoded) {
        send(res, 200, {
          errors: [{ message: "bad signature", extensions: { code: "UNAUTHENTICATED" } }],
        });
        return;
      }
      if (decoded.email !== state.email || decoded.password !== state.password) {
        send(res, 200, {
          errors: [
            { message: "incorrect email or password", extensions: { code: "UNAUTHENTICATED" } },
          ],
        });
        return;
      }
      reply({
        signin: {
          access_token: state.accessToken,
          refresh_token: state.refreshToken,
          expires_in: 7200,
        },
      });
      return;
    }

    // Alla andra anrop kräver giltig token.
    if (token !== state.accessToken) {
      send(res, 200, {
        errors: [{ message: "token invalid", extensions: { code: "UNAUTHENTICATED" } }],
      });
      return;
    }

    switch (op) {
      case "MachinesLite":
        reply({
          machinesLite: state.machines.map((m) => ({
            id: m.id,
            machine_no: m.machineNo,
            name: m.name,
          })),
        });
        return;

      case "Profile":
        reply({
          profile: {
            id: 1,
            email: state.email,
            username: "butik",
            status: 1,
            permissions: [],
            merchant: { id: state.merchantId, title: "Binderlab test", tax_enabled: false },
            role: { id: state.isRoot ? 1 : 2, name: state.isRoot ? "root" : "merchant" },
            is_readonly: false,
            is_email_verified: true,
            agent: null,
          },
        });
        return;

      case "UnitsAndCurrencies": {
        const input = checkInputObject("CurrenciesQueryInput", variables.input, ["merchant_id"]);
        if (input.merchant_id !== state.merchantId) {
          reject("merchant not found");
          return;
        }
        reply({ units: [], currencies: state.currencies });
        return;
      }

      case "Goods": {
        const input = checkInputObject("GoodsQueryInput", variables.input, GOODS_QUERY_FIELDS);
        const perPage = input.per_page ?? 20;
        const page = input.current_page ?? 1;
        if (!isInt(perPage) || perPage < 1 || perPage > 100 || !isInt(page) || page < 1) {
          reject('Variable "$input" got invalid value at "input.per_page".');
          return;
        }
        // Nyast först, som panelens lista.
        const all = [...state.goods].sort((a, b) => b.id - a.id);
        const lastPage = Math.max(1, Math.ceil(all.length / perPage));
        reply({
          goods: {
            total: all.length,
            currentPage: page,
            perPage,
            lastPage,
            data: all.slice((page - 1) * perPage, page * perPage).map(goodJson),
          },
          goodsStatistics: [],
        });
        return;
      }

      case "CreateGood": {
        const g = checkGoodInput(
          variables.input,
          state.currencies.map((c) => c.id),
        );
        const prices = g.prices as Array<{ price: number; currency_id: number }>;
        const id = state.nextGoodId++;
        state.goods.push({
          id,
          name: String(g.name),
          price: prices[0]!.price.toFixed(2),
          thumb: String(g.thumb),
          media: g.media as string[],
          description: String(g.description),
          content: String(g.content),
        });
        reply({ createGood: state.createGoodResult });
        return;
      }

      case "Categories": {
        if (!isInt(variables.machine_id)) {
          reject('Variable "$machine_id" got invalid value.');
          return;
        }
        const list = state.categories[String(variables.machine_id)] ?? [];
        reply({
          categories: list.map((c, i) => ({
            id: c.id,
            title: c.title,
            machine_id: variables.machine_id,
            sort_id: i,
            is_visible: true,
            priority: 1,
          })),
        });
        return;
      }

      case "Products": {
        const decoded = checkSignedInput();
        if (!decoded) {
          send(res, 200, { errors: [{ message: "bad signature" }] });
          return;
        }
        const machineId = String(decoded.machine_id ?? "");
        const list = state.products[machineId] ?? [];
        reply({
          products: list.map((p) => {
            const good = p.goodId == null ? null : state.goods.find((g) => g.id === p.goodId);
            return {
              id: p.id,
              machine_id: Number(machineId),
              good_id: p.goodId,
              status: p.status,
              floor_status: p.floorStatus ?? "ERR_NORMAL",
              lock_status: 0,
              lock_id: null,
              current_inventory: p.currentInventory,
              inventory: p.inventory ?? p.capacity,
              channel: { id: p.id, name: p.channelName, total: p.capacity },
              locker: null,
              good: good
                ? goodJson(good)
                : p.goodId == null
                  ? null
                  : { id: p.goodId, name: p.goodName },
            };
          }),
        });
        return;
      }

      case "UpdateProduct": {
        if (!isInt(variables.id)) {
          reject('Variable "$id" got invalid value; Int cannot represent non-integer value.');
          return;
        }
        const input = checkInputObject("ProductInput", variables.input, PRODUCT_INPUT_FIELDS) as {
          good_id?: unknown;
          status?: unknown;
          current_inventory?: unknown;
        };
        if (input.status !== undefined && typeof input.status !== "boolean") {
          reject('Variable "$input" got invalid value at "input.status".');
          return;
        }
        if (
          input.current_inventory !== undefined &&
          (!isInt(input.current_inventory) || input.current_inventory < 0)
        ) {
          reject('Variable "$input" got invalid value at "input.current_inventory".');
          return;
        }
        if (input.good_id !== undefined && input.good_id !== null && !isInt(input.good_id)) {
          reject('Variable "$input" got invalid value at "input.good_id".');
          return;
        }
        let found: FakeWebProduct | undefined;
        for (const list of Object.values(state.products)) {
          const p = list.find((x) => x.id === variables.id);
          if (p) {
            found = p;
            break;
          }
        }
        if (!found) {
          send(res, 200, { errors: [{ message: "product not found" }] });
          return;
        }
        const max = found.inventory ?? found.capacity;
        if (isInt(input.current_inventory) && max != null && input.current_inventory > max) {
          send(res, 200, { errors: [{ message: "current inventory exceeds capacity" }] });
          return;
        }
        if (isInt(input.good_id) && input.good_id !== found.goodId) {
          const good = state.goods.find((g) => g.id === input.good_id);
          if (!good) {
            send(res, 200, { errors: [{ message: "good not found" }] });
            return;
          }
          found.goodId = good.id;
          found.goodName = good.name;
        } else if (input.good_id === null) {
          found.goodId = null;
          found.goodName = null;
        }
        if (isInt(input.current_inventory)) found.currentInventory = input.current_inventory;
        if (typeof input.status === "boolean") found.status = input.status;
        reply({ updateProduct: true });
        return;
      }

      case "CreateProduct":
        if (!isInt(variables.machine_id)) {
          reject('Variable "$machine_id" got invalid value.');
          return;
        }
        if (!state.isRoot) {
          send(res, 200, {
            errors: [{ message: "permission denied", extensions: { code: "FORBIDDEN" } }],
          });
          return;
        }
        reply({ createProduct: true });
        return;

      default:
        reject(`Operation "${op}" is not implemented by the fake panel.`);
    }
  }

  const server: Server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "";
    if (req.method === "POST" && path.endsWith("/api/v1/files")) {
      handleUpload(req, res).catch(() => send(res, 500, { message: "error" }));
      return;
    }
    if (req.method !== "POST" || !path.endsWith("/graphql")) {
      send(res, 404, { errors: [{ message: "not found" }] });
      return;
    }
    readBody(req)
      .then((raw) => {
        try {
          handleGraphql(req, res, raw);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Internal error.";
          state.rejected.push(message);
          send(res, 200, { errors: [{ message }] });
        }
      })
      .catch(() => send(res, 400, { errors: [{ message: "bad request" }] }));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    state,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
