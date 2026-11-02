/**
 * Låtsas-Awish för tilläggets tester: HTML-sidor som efterliknar en admin-panel
 * (Bootstrap-tabell med rubrikerna ID, Date, Name, Order No., Order Machine, Payment
 * Method, Order Amount, Is Paid, Payment Time, Actions, sidnavigering med 20 rader per
 * sida), en inloggningssida, JSON som en FastAdmin-panel svarar med, och en liten
 * node-server med cookie-inloggning för end-to-end-testet.
 *
 * Används av src/import/adapters/awish-extension-*.test.ts och ./e2e.test.ts.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface MockOrder {
  id: number;
  date: string;
  name: string;
  orderNo: string;
  machine: string;
  method: string;
  /** Beloppscellen som Awish visar den. */
  amount: string;
  paid: boolean;
  paymentTime: string;
}

const TITLES = [
  "Pokémon 151 Booster",
  "Surging Sparks Booster",
  "One Piece OP-09 Booster",
  "Lorcana Shimmering Skies",
];
const MACHINES = ["Ica Kvantum Malmborgs", "Coop Forum Burlöv", "Pressbyrån Triangeln"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** n ordrar, nyast först (som Awish sorterar), med ordernummer från `first` och uppåt. */
export function makeOrders(
  n: number,
  first = 42_000,
  startMs = Date.UTC(2026, 10, 1, 16, 0, 0),
): MockOrder[] {
  const out: MockOrder[] = [];
  for (let i = 0; i < n; i += 1) {
    // Shanghai-tid (UTC+8) som Awish visar.
    const t = new Date(startMs - i * 7 * 60_000 + 8 * 3_600_000);
    const local = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
    const price = [170, 79, 89, 129][i % 4]!;
    out.push({
      id: 900_000 + n - i,
      date: local.slice(0, 10),
      name: TITLES[i % TITLES.length]!,
      orderNo: String(first + n - 1 - i),
      machine: MACHINES[i % MACHINES.length]!,
      method: i % 2 === 0 ? "WeChat Pay" : "Alipay",
      amount: `Amount: ${price}.00`,
      paid: i % 9 !== 4,
      paymentTime: local,
    });
  }
  return out;
}

export type Column =
  | "ID"
  | "Date"
  | "Name"
  | "Order No."
  | "Order Machine"
  | "Payment Method"
  | "Order Amount"
  | "Is Paid"
  | "Payment Time"
  | "Actions";

export const AWISH_COLUMNS: Column[] = [
  "ID",
  "Date",
  "Name",
  "Order No.",
  "Order Machine",
  "Payment Method",
  "Order Amount",
  "Is Paid",
  "Payment Time",
  "Actions",
];

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cell(o: MockOrder, column: Column): string {
  switch (column) {
    case "ID":
      return `<td>${o.id}</td>`;
    case "Date":
      return `<td><span class="text-muted">${esc(o.date)}</span></td>`;
    case "Name":
      return `<td><a href="/dashboard/goods/edit?ids=${o.id}" class="btn-link">${esc(o.name)}</a></td>`;
    case "Order No.":
      return `<td>\n  ${esc(o.orderNo)}\n</td>`;
    case "Order Machine":
      return `<td><span title="${esc(o.machine)}">${esc(o.machine)}</span></td>`;
    case "Payment Method":
      return `<td>${esc(o.method)}</td>`;
    case "Order Amount":
      return `<td><div>${esc(o.amount)}</div><div class="text-muted">Discount Amount: 0.00</div></td>`;
    case "Is Paid":
      return o.paid
        ? `<td><span class="label label-success">Paid Success</span></td>`
        : `<td><span class="label label-default">Unpaid</span></td>`;
    case "Payment Time":
      return `<td>${o.paid ? esc(o.paymentTime) : "-"}</td>`;
    case "Actions":
      return `<td><a class="btn btn-xs btn-success btn-editone" href="javascript:;"><i class="fa fa-pencil"></i></a> <a class="btn btn-xs btn-danger" href="javascript:;">Del</a></td>`;
  }
}

export interface RenderOptions {
  pageSize?: number;
  columns?: Column[];
  /** Rubriken i en egen tabell före raderna (fast rubrik, som Bootstrap Table ritar). */
  splitHeader?: boolean;
  /** Visa "Showing 1 to 20 of N rows" i stället för numrerade sidlänkar. */
  totalTextOnly?: boolean;
}

/** Orderlistans HTML för sida `page` (från 1). */
export function renderOrdersPage(
  orders: readonly MockOrder[],
  page: number,
  options: RenderOptions = {},
): string {
  const size = options.pageSize ?? 20;
  const columns = options.columns ?? AWISH_COLUMNS;
  const rows = orders.slice((page - 1) * size, page * size);
  const last = Math.max(1, Math.ceil(orders.length / size));
  const head = `<thead><tr>${columns.map((c) => `<th data-field="${esc(c)}"><div class="th-inner sortable">${esc(c)}</div><div class="fht-cell"></div></th>`).join("")}</tr></thead>`;
  const body = `<tbody>${
    rows.length === 0
      ? `<tr class="no-records-found"><td colspan="${columns.length}">No matching records found</td></tr>`
      : rows
          .map((o) => `<tr data-index="${o.id}">${columns.map((c) => cell(o, c)).join("")}</tr>`)
          .join("\n")
  }</tbody>`;
  const table = options.splitHeader
    ? `<div class="fixed-table-header"><table class="table">${head}</table></div><div class="fixed-table-body"><table id="table" class="table table-striped">${body}</table></div>`
    : `<table id="table" class="table table-striped table-bordered">${head}${body}</table>`;
  const links: string[] = [];
  links.push(
    page > 1
      ? `<li class="page-pre"><a href="?page=${page - 1}">‹</a></li>`
      : `<li class="page-pre disabled"><a href="javascript:void(0)">‹</a></li>`,
  );
  if (!options.totalTextOnly) {
    for (let p = Math.max(1, page - 2); p <= Math.min(last, page + 2); p += 1) {
      links.push(
        `<li class="page-number${p === page ? " active" : ""}"><a href="?page=${p}">${p}</a></li>`,
      );
    }
  }
  links.push(
    page < last
      ? `<li class="page-next"><a href="?page=${page + 1}">›</a></li>`
      : `<li class="page-next disabled"><a href="javascript:void(0)">›</a></li>`,
  );
  const from = rows.length === 0 ? 0 : (page - 1) * size + 1;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Orders - Awish Dashboard</title>
<script>var Config = {"moduleurl":"/dashboard","controllername":"orders","actionname":"index"};</script>
<style>.x{}</style></head>
<body class="skin-black">
<header class="main-header"><a href="/dashboard/index/index" class="logo">Awish</a>
<ul class="nav"><li><a href="/dashboard/orders/index">Orders</a></li><li><a href="/dashboard/machines/index">Machines</a></li><li><a href="/dashboard/index/logout">Logout</a></li></ul></header>
<section class="content"><div class="panel panel-default panel-intro"><div class="panel-heading">Orders</div>
<div class="panel-body"><div class="toolbar"><a class="btn btn-primary btn-refresh" href="javascript:;">Refresh</a> <input type="text" class="form-control" placeholder="Search"></div>
${table}
<div class="fixed-table-pagination"><div class="pull-left pagination-detail"><span class="pagination-info">Showing ${from} to ${from + rows.length - (rows.length === 0 ? 0 : 1)} of ${orders.length} rows</span></div>
<div class="pull-right pagination"><ul class="pagination">${links.join("")}</ul></div></div>
</div></div></section></body></html>`;
}

export function renderLoginPage(): string {
  return `<!DOCTYPE html><html><head><title>Login - Awish Dashboard</title></head><body>
<form method="post" action="/dashboard/index/login"><input name="username" type="text"><input name="password" type="password"><button type="submit">Sign in</button></form>
</body></html>`;
}

/** JSON som en FastAdmin-panel svarar med på ett XHR-anrop (offset/limit). */
export function ordersJson(orders: readonly MockOrder[], offset: number, limit: number): unknown {
  return {
    total: orders.length,
    rows: orders.slice(offset, offset + limit).map((o) => ({
      id: o.id,
      createtime: o.date,
      goods_name: o.name,
      order_no: o.orderNo,
      machine_name: o.machine,
      pay_type: o.method,
      order_amount: o.amount,
      is_paid: o.paid ? 1 : 0,
      pay_time: o.paid ? o.paymentTime : "",
    })),
  };
}

// ---------------------------------------------------------------------------
// Servern (end-to-end)
// ---------------------------------------------------------------------------

export interface MockAwishServer {
  url: string;
  orders: MockOrder[];
  /** Antal anrop per sökväg (för att se att tillägget går lugnt fram). */
  hits: { path: string; at: number; cookie: boolean; xhr: boolean }[];
  /** Loggar ut alla (sessionen slutar gälla). */
  expireSessions(): void;
  /**
   * Orderlistan svarar med ett skal som ritas med JavaScript (som en SPA), utan tabell i
   * HTML:en. En flik som redan visar listan behåller den (tilläggets reserv läser den).
   */
  setShell(on: boolean): void;
  close(): Promise<void>;
}

const SESSION_COOKIE = "awish_session";

export async function startMockAwish(options: {
  orders: MockOrder[];
  port?: number;
  json?: boolean;
  render?: RenderOptions;
}): Promise<MockAwishServer> {
  const sessions = new Set<string>();
  const hits: MockAwishServer["hits"] = [];
  const state = { orders: options.orders, shell: false };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cookie = /(?:^|;\s*)awish_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? null;
    const authed = cookie !== null && sessions.has(cookie);
    const xhr = req.headers["x-requested-with"] === "XMLHttpRequest";
    hits.push({ path: `${url.pathname}${url.search}`, at: Date.now(), cookie: authed, xhr });

    if (url.pathname === "/dashboard/index/login") {
      if (req.method === "POST") {
        const token = `s${Math.random().toString(36).slice(2)}${Date.now()}`;
        sessions.add(token);
        res.writeHead(302, {
          location: "/dashboard/orders/index",
          "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderLoginPage());
      return;
    }
    if (url.pathname === "/dashboard/orders/index") {
      if (!authed) {
        if (xhr) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ code: 0, msg: "Please login first", url: "/dashboard/index/login" }),
          );
          return;
        }
        res.writeHead(302, {
          location: "/dashboard/index/login?url=%2Fdashboard%2Forders%2Findex",
        });
        res.end();
        return;
      }
      if (xhr && options.json) {
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(ordersJson(state.orders, offset, limit)));
        return;
      }
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (state.shell) {
        res.end(
          '<!DOCTYPE html><html><head><title>Awish Dashboard</title></head><body><div id="app"></div></body></html>',
        );
        return;
      }
      res.end(renderOrdersPage(state.orders, page, options.render));
      return;
    }
    res.writeHead(
      authed ? 200 : 302,
      authed ? { "content-type": "text/html" } : { location: "/dashboard/index/login" },
    );
    res.end(authed ? "<html><body>Awish</body></html>" : "");
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    get orders() {
      return state.orders;
    },
    set orders(value: MockOrder[]) {
      state.orders = value;
    },
    hits,
    expireSessions: () => sessions.clear(),
    setShell: (on: boolean) => {
      state.shell = on;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as MockAwishServer;
}
