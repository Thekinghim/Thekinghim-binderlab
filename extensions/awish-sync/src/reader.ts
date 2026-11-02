/**
 * Avläsning av Awish orderlista (dash.awish.vip/dashboard/orders/index), oberoende av
 * hur sidan hämtades. Rena funktioner: används av tilläggets service worker och
 * offscreen-dokument, och testas i src/import/adapters/awish-extension-reader.test.ts.
 *
 * Två källor:
 * - HTML-tabellen: kolumnerna hittas på rubriktexterna (ID, Date, Name, Order No.,
 *   Order Machine, Payment Method, Order Amount, Is Paid, Payment Time, Actions), aldrig
 *   på kolumnordningen. Okänsligt för skiftläge, mellanslag och skiljetecken.
 * - JSON (om panelen laddar tabellen via XHR/fetch): raderna hittas i svaret
 *   (rows, data, list, records, ...) och fälten på nycklarnas namn (order_no, goods_name,
 *   machine_name, pay_time, ...), samma synonymer som rubrikerna.
 *
 * Värdena skickas som källans text (beloppscellen "Amount: 170.00", "Paid Success",
 * Payment Time i källans tid): Binderlab tolkar dem med samma regler som en uppladdad
 * CSV. Bara när JSON har ett tal i stället för text skrivs det om (tidsstämpel → ISO
 * med Z, 1/0 → Paid Success/Unpaid).
 */

/** En rad som skickas till Binderlab (samma fält som CSV-mappningen). */
export interface OrderRow {
  externalId: string;
  title: string;
  machine: string;
  amount: string;
  isPaid: string;
  paidAt: string;
  paymentMethod?: string | null;
  rowId?: string | null;
  orderDate?: string | null;
  page?: number;
  pageRow?: number;
}

export type Field =
  | "externalId"
  | "title"
  | "machine"
  | "amount"
  | "isPaid"
  | "paidAt"
  | "paymentMethod"
  | "rowId"
  | "orderDate";

export const REQUIRED_FIELDS: readonly Field[] = [
  "externalId",
  "title",
  "machine",
  "amount",
  "isPaid",
  "paidAt",
];

/** En tabell som rubriker och rader med cellernas text. */
export interface Grid {
  headers: string[];
  rows: string[][];
}

export interface PageLink {
  href: string;
  text: string;
  rel: string;
  className: string;
}

/** Det som avläsningen behöver ur en HTML-sida (från DOMParser eller tokeniseraren). */
export interface ExtractedPage {
  tables: Grid[];
  links: PageLink[];
  /** Sidan har ett lösenordsfält (inloggningssida). */
  hasPasswordInput: boolean;
  title: string;
  /** Sidans synliga text (för "Total 1 234" o.d.), högst 20 000 tecken. */
  text: string;
}

export interface PageRead {
  rows: OrderRow[];
  /** Valfria fält som tabellen inte har (Payment Method). */
  absent: "paymentMethod"[];
  /** Antal rader i tabellen (även de som inte gick att läsa). */
  seen: number;
  /** Rader som saknade ordernummer och hoppades över. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Rubriker och nycklar
// ---------------------------------------------------------------------------

/** Gemener, NFKC, bara bokstäver och siffror ("Order No." → "orderno"). Samma som servern. */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Synonymer per fält, normaliserade. Ordningen avgör när flera kolumner passar. */
const SYNONYMS: Record<Field, readonly string[]> = {
  externalId: [
    "orderno",
    "ordernumber",
    "ordernr",
    "ordersn",
    "orderid",
    "outtradeno",
    "tradeno",
    "ordernummer",
    "订单号",
    "订单编号",
  ],
  title: [
    "name",
    "productname",
    "goodsname",
    "goodstitle",
    "product",
    "itemname",
    "title",
    "produkt",
    "goods",
    "item",
    "商品名称",
    "商品",
  ],
  machine: [
    "ordermachine",
    "machinename",
    "machine",
    "devicename",
    "device",
    "automat",
    "设备名称",
    "设备",
  ],
  amount: [
    "orderamount",
    "amount",
    "totalamount",
    "payamount",
    "totalfee",
    "money",
    "price",
    "belopp",
    "订单金额",
    "金额",
  ],
  isPaid: [
    "ispaid",
    "paid",
    "paystatus",
    "paymentstatus",
    "paystate",
    "status",
    "betald",
    "支付状态",
  ],
  paidAt: ["paymenttime", "paytime", "paidtime", "paidat", "paymentat", "betaltid", "支付时间"],
  paymentMethod: [
    "paymentmethod",
    "paymethod",
    "paytype",
    "paymenttype",
    "payway",
    "betalmetod",
    "支付方式",
  ],
  rowId: ["id"],
  orderDate: [
    "date",
    "orderdate",
    "ordertime",
    "createtime",
    "createdat",
    "addtime",
    "datum",
    "创建时间",
  ],
};

const FIELDS = Object.keys(SYNONYMS) as Field[];

/** Kolumnindex per fält (−1 = saknas). Varje kolumn används högst en gång. */
export function mapColumns(headers: readonly string[]): Record<Field, number> {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const out = Object.fromEntries(FIELDS.map((f) => [f, -1])) as Record<Field, number>;
  // Fält med specifika namn först, så att "Order Amount" inte tas av något annat.
  for (const field of FIELDS) {
    const synonyms = SYNONYMS[field];
    let best = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    normalized.forEach((h, i) => {
      if (used.has(i)) return;
      const rank = synonyms.indexOf(h);
      if (rank >= 0 && rank < bestRank) {
        best = i;
        bestRank = rank;
      }
    });
    if (best >= 0) {
      used.add(best);
      out[field] = best;
    }
  }
  return out;
}

export function missingFields(columns: Record<Field, number>): Field[] {
  return REQUIRED_FIELDS.filter((f) => columns[f] < 0);
}

/**
 * Rättar till tabeller som ritats i delar: en tabell utan rubrikrad vars första rad är
 * rubrikerna, och en fast rubrik i en egen tabell följd av raderna i nästa (Bootstrap
 * Table, Layui och liknande ritar så).
 */
export function normalizeTables(tables: readonly Grid[]): Grid[] {
  const promote = (t: Grid): Grid => {
    const first = t.rows[0];
    if (t.headers.length === 0 && first && missingFields(mapColumns(first)).length === 0) {
      return { headers: first, rows: t.rows.slice(1) };
    }
    return t;
  };
  const out: Grid[] = [];
  for (let i = 0; i < tables.length; i += 1) {
    const t = promote(tables[i]!);
    const next = tables[i + 1];
    if (t.headers.length > 0 && t.rows.length === 0 && next && next.headers.length === 0) {
      out.push({ headers: t.headers, rows: next.rows });
      i += 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Tabellen med orderlistan: den som har alla obligatoriska kolumner och flest fält. */
export function findOrderTable(tables: readonly Grid[]): Grid | null {
  let best: Grid | null = null;
  let bestScore = -1;
  for (const t of normalizeTables(tables)) {
    const columns = mapColumns(t.headers);
    if (missingFields(columns).length > 0) continue;
    const score = FIELDS.filter((f) => columns[f] >= 0).length * 10_000 + t.rows.length;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

function clean(text: string | undefined | null): string {
  return (text ?? "")
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Raderna i en tabell (rubrikerna hittas på texten). */
export function readGrid(grid: Grid, page: number): PageRead {
  const columns = mapColumns(grid.headers);
  const missing = missingFields(columns);
  if (missing.length > 0) {
    throw new ReaderError(
      "layout",
      `Orderlistan saknar kolumner: ${missing.join(", ")}. Awish kan ha ändrat sidan.`,
    );
  }
  const cell = (row: string[], field: Field): string =>
    columns[field] < 0 ? "" : clean(row[columns[field]]);
  const rows: OrderRow[] = [];
  let skipped = 0;
  let seen = 0;
  grid.rows.forEach((r, i) => {
    // Tomma rader och "Inga data"-rader (en cell över hela bredden) räknas inte.
    if (r.length <= 1 && clean(r[0]).length < 40 && !/\d{4}/.test(clean(r[0]))) return;
    seen += 1;
    const externalId = cell(r, "externalId");
    if (externalId === "") {
      skipped += 1;
      return;
    }
    rows.push({
      externalId,
      title: cell(r, "title"),
      machine: cell(r, "machine"),
      amount: cell(r, "amount"),
      isPaid: cell(r, "isPaid"),
      paidAt: cell(r, "paidAt"),
      paymentMethod: columns.paymentMethod < 0 ? null : cell(r, "paymentMethod"),
      rowId: columns.rowId < 0 ? null : cell(r, "rowId"),
      orderDate: columns.orderDate < 0 ? null : cell(r, "orderDate"),
      page,
      pageRow: i + 1,
    });
  });
  return { rows, absent: columns.paymentMethod < 0 ? ["paymentMethod"] : [], seen, skipped };
}

// ---------------------------------------------------------------------------
// Inloggning och sidnavigering
// ---------------------------------------------------------------------------

export class ReaderError extends Error {
  constructor(
    readonly kind: "logged_out" | "layout" | "http" | "network",
    message: string,
  ) {
    super(message);
    this.name = "ReaderError";
  }
}

const LOGIN_PATH = /\/(?:login|signin|sign-in|auth|passport)(?:[/?.#]|$)/i;

/** Är sidan en inloggningssida (eller en omdirigering dit)? */
export function looksLoggedOut(page: ExtractedPage, finalUrl: string): boolean {
  let path = "";
  try {
    const u = new URL(finalUrl);
    path = `${u.pathname}${u.search}`;
  } catch {
    path = finalUrl;
  }
  if (LOGIN_PATH.test(path)) return true;
  const hasOrders = findOrderTable(page.tables) !== null;
  if (hasOrders) return false;
  return page.hasPasswordInput || /\b(?:log ?in|sign ?in)\b|登录|logga in/i.test(page.title);
}

const PAGE_PARAMS = ["page", "p", "pagenum", "pageno", "pageindex", "current", "pn"];

/** Sidnumret i en länk (?page=3), och vilken parameter som bär det. */
function pageOf(href: string, base: string): { param: string; page: number } | null {
  try {
    const u = new URL(href, base);
    for (const [key, value] of u.searchParams) {
      if (PAGE_PARAMS.includes(key.toLowerCase()) && /^\d{1,7}$/.test(value)) {
        return { param: key, page: Number(value) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface Pagination {
  /** Parametern som sidnumret skickas i (standard "page"). */
  param: string;
  /** Högsta sidnummer i sidnavigeringen eller ur "Total N" (null = okänt). */
  lastPage: number | null;
  /** Finns en länk till nästa sida? */
  hasNext: boolean;
}

/** Sidnavigeringen på en sida: parameter, sista sidan och om det finns en nästa. */
export function readPagination(
  page: ExtractedPage,
  currentPage: number,
  baseUrl: string,
  pageSize = 20,
): Pagination {
  let param = "page";
  let lastPage: number | null = null;
  let hasNext = false;
  for (const link of page.links) {
    const p = pageOf(link.href, baseUrl);
    if (!p) continue;
    param = p.param;
    lastPage = Math.max(lastPage ?? 0, p.page);
    // En länk till sidan efter den här (siffran, "Next", "›", "»" ...) betyder att det
    // finns fler sidor. En inaktiv "Next" på sista sidan saknar oftast href med sidnummer.
    const disabled = /disabled/.test(link.className);
    if (p.page === currentPage + 1 && !disabled) hasNext = true;
  }
  const total =
    /(?:total|totalt|共|showing[^\d]*\d+\s*(?:to|-)\s*\d+\s*of)\s*[:：]?\s*([\d\s,]{1,12})\s*(?:条|rows|rader|entries|records|items)?/i.exec(
      page.text,
    );
  if (total?.[1]) {
    const n = Number(total[1].replace(/[\s,]/g, ""));
    if (Number.isFinite(n) && n > 0) {
      lastPage = Math.max(lastPage ?? 0, Math.ceil(n / pageSize));
    }
  }
  if (lastPage !== null && currentPage < lastPage) hasNext = true;
  return { param, lastPage, hasNext };
}

/** Adressen till sida n, med samma parameter som sidnavigeringen använder. */
export function pageUrl(baseUrl: string, page: number, param = "page"): string {
  const u = new URL(baseUrl);
  u.searchParams.set(param, String(page));
  return u.toString();
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROW_KEYS = ["rows", "data", "list", "records", "items", "result", "orders", "lists"];
const TOTAL_KEYS = ["total", "count", "totalcount", "totalrows", "totalelements", "recordstotal"];

function looksLikeOrders(items: Json[]): boolean {
  const first = items.find(isRecord);
  if (!first) return false;
  const columns = mapColumns(Object.keys(first));
  return columns.externalId >= 0 && (columns.amount >= 0 || columns.title >= 0);
}

/** Raderna och totalen i ett JSON-svar, eller null om svaret inte ser ut som ordrar. */
export function findJsonRows(
  json: Json,
): { items: Record<string, Json>[]; total: number | null } | null {
  const queue: Array<{ value: Json; depth: number; total: number | null }> = [
    { value: json, depth: 0, total: null },
  ];
  while (queue.length > 0) {
    const { value, depth, total } = queue.shift()!;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        // En tom lista på rätt nyckel betyder "inga fler rader".
        return { items: [], total };
      }
      if (looksLikeOrders(value)) {
        return { items: value.filter(isRecord), total };
      }
      continue;
    }
    if (!isRecord(value) || depth > 3) continue;
    let here = total;
    for (const [k, v] of Object.entries(value)) {
      if (
        TOTAL_KEYS.includes(normalizeHeader(k)) &&
        (typeof v === "number" || /^\d+$/.test(String(v)))
      ) {
        here = Number(v);
      }
    }
    for (const key of ROW_KEYS) {
      const entry = Object.entries(value).find(([k]) => k.toLowerCase() === key);
      if (entry) queue.push({ value: entry[1], depth: depth + 1, total: here });
    }
  }
  return null;
}

/** Är ett JSON-svar ett "inte inloggad"-svar? */
export function jsonLoggedOut(json: Json): boolean {
  if (!isRecord(json)) return false;
  const code = json.code ?? json.status ?? json.errcode;
  const msg = String(json.msg ?? json.message ?? json.error ?? "");
  const url = String(json.url ?? json.redirect ?? "");
  return (
    code === 401 ||
    code === "401" ||
    LOGIN_PATH.test(url) ||
    /not ?log(?:ged)? ?in|please log ?in|unauthori[sz]ed|login required|请登录|未登录|登录超时/i.test(
      msg,
    )
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Ett JSON-värde som text. Tal som ser ut som tidsstämplar blir ISO med Z. */
function textOf(value: Json, field: Field): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") {
    return field === "isPaid" ? (value ? "Paid Success" : "Unpaid") : String(value);
  }
  if (typeof value === "number") {
    if (field === "paidAt" || field === "orderDate") {
      const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : NaN;
      if (Number.isFinite(ms)) {
        const d = new Date(ms);
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
          d.getUTCHours(),
        )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
      }
    }
    if (field === "isPaid") return value === 1 ? "Paid Success" : "Unpaid";
    if (field === "amount") return value.toFixed(2);
    return String(value);
  }
  if (isRecord(value)) {
    // Inbäddade objekt, t.ex. { machine: { name: "..." } } eller { goods: { title: "..." } }.
    for (const key of ["name", "title", "text", "label", "value"]) {
      if (key in value) return textOf(value[key], field);
    }
    return "";
  }
  if (Array.isArray(value)) return value.map((v) => textOf(v, field)).join(", ");
  const s = String(value).trim();
  if (field === "isPaid" && /^(?:1|true)$/i.test(s)) return "Paid Success";
  if (field === "isPaid" && /^(?:0|false|-1)$/i.test(s)) return "Unpaid";
  if ((field === "paidAt" || field === "orderDate") && /^\d{10}(?:\d{3})?$/.test(s)) {
    return textOf(Number(s), field);
  }
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Raderna i ett JSON-svar. Fälten hittas på nycklarnas namn (som rubrikerna). */
export function readJsonItems(items: readonly Record<string, Json>[], page: number): PageRead {
  const keys = [...new Set(items.flatMap((i) => Object.keys(i)))];
  const columns = mapColumns(keys);
  const missing = missingFields(columns);
  if (items.length > 0 && missing.length > 0) {
    throw new ReaderError(
      "layout",
      `Awish svar saknar fält: ${missing.join(", ")}. Tillägget läser HTML-tabellen i stället.`,
    );
  }
  const keyOf = (f: Field): string | null => (columns[f] < 0 ? null : (keys[columns[f]] ?? null));
  const get = (item: Record<string, Json>, f: Field): string => {
    const k = keyOf(f);
    return k === null ? "" : textOf(item[k], f);
  };
  const rows: OrderRow[] = [];
  let skipped = 0;
  items.forEach((item, i) => {
    const externalId = get(item, "externalId");
    if (externalId === "") {
      skipped += 1;
      return;
    }
    rows.push({
      externalId,
      title: get(item, "title"),
      machine: get(item, "machine"),
      amount: get(item, "amount"),
      isPaid: get(item, "isPaid"),
      paidAt: get(item, "paidAt"),
      paymentMethod: keyOf("paymentMethod") === null ? null : get(item, "paymentMethod"),
      rowId: keyOf("rowId") === null ? null : get(item, "rowId"),
      orderDate: keyOf("orderDate") === null ? null : get(item, "orderDate"),
      page,
      pageRow: i + 1,
    });
  });
  return {
    rows,
    absent: keyOf("paymentMethod") === null ? ["paymentMethod"] : [],
    seen: items.length,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// JSON-API: parametrar för sidor
// ---------------------------------------------------------------------------

/** Hur JSON-API:t pagineras (upptäckt i sidans egna anrop eller provat). */
export interface JsonApi {
  /** Adressen utan sidparametrar. */
  url: string;
  /** "page" = sidnummer (från 1), "offset" = radindex (från 0). */
  style: "page" | "offset";
  pageParam: string;
  sizeParam: string;
  pageSize: number;
  /** Huvuden som sidan själv skickade (bara X-Requested-With och Accept används). */
  ajaxHeader: boolean;
}

const SIZE_PARAMS = ["limit", "pagesize", "size", "rows", "perpage", "per_page", "length", "ps"];
const OFFSET_PARAMS = ["offset", "start", "skip"];

/** Tolkar adressen som panelen själv anropade och tar fram hur sidorna bläddras. */
export function jsonApiFromUrl(url: string, ajaxHeader = true): JsonApi | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let style: JsonApi["style"] = "page";
  let pageParam = "page";
  let sizeParam = "limit";
  let pageSize = 20;
  for (const [key, value] of [...u.searchParams]) {
    const k = key.toLowerCase();
    if (OFFSET_PARAMS.includes(k)) {
      style = "offset";
      pageParam = key;
      u.searchParams.delete(key);
    } else if (PAGE_PARAMS.includes(k)) {
      style = "page";
      pageParam = key;
      u.searchParams.delete(key);
    } else if (SIZE_PARAMS.includes(k.replace(/_/g, "")) || SIZE_PARAMS.includes(k)) {
      sizeParam = key;
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && n <= 500) pageSize = n;
      u.searchParams.delete(key);
    }
  }
  return { url: u.toString(), style, pageParam, sizeParam, pageSize, ajaxHeader };
}

/** Adressen till sida n (från 1) i JSON-API:t. */
export function jsonPageUrl(api: JsonApi, page: number): string {
  const u = new URL(api.url);
  u.searchParams.set(api.sizeParam, String(api.pageSize));
  u.searchParams.set(
    api.pageParam,
    String(api.style === "offset" ? (page - 1) * api.pageSize : page),
  );
  return u.toString();
}
