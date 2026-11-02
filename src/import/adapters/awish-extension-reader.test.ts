/**
 * Chrome-tilläggets avläsning av Awish orderlista (extensions/awish-sync/src/reader.ts och
 * extract-html.ts): rubrikerna oavsett kolumnordning, "Amount: 170.00", sidnavigering,
 * utloggad sida och JSON. Raderna går sedan genom servern (awish-extension.ts): samma
 * fält, samma tolkning.
 */

import { describe, expect, it } from "vitest";

import { extractHtml } from "../../../extensions/awish-sync/src/extract-html";
import {
  findJsonRows,
  findOrderTable,
  jsonApiFromUrl,
  jsonLoggedOut,
  jsonPageUrl,
  looksLoggedOut,
  mapColumns,
  pageUrl,
  readGrid,
  readJsonItems,
  readPagination,
  ReaderError,
} from "../../../extensions/awish-sync/src/reader";
import {
  AWISH_COLUMNS,
  makeOrders,
  ordersJson,
  renderLoginPage,
  renderOrdersPage,
  type Column,
} from "../../../extensions/awish-sync/test/mock-awish";
import { parseIngestBody } from "../../server/ingest/body";
import { parseAwishExtensionBatch } from "./awish-extension";

const BASE = "https://dash.awish.vip/dashboard/orders/index";
const orders = makeOrders(45);

function readHtmlPage(html: string, page: number) {
  const extracted = extractHtml(html);
  const table = findOrderTable(extracted.tables);
  if (!table) throw new Error("ingen tabell");
  return { extracted, read: readGrid(table, page) };
}

describe("HTML-tabellen", () => {
  it("läser alla fält efter rubriktexterna, Actions ignoreras", () => {
    const { read } = readHtmlPage(renderOrdersPage(orders, 1), 1);
    expect(read.rows).toHaveLength(20);
    expect(read.absent).toEqual([]);
    const first = orders[0]!;
    expect(read.rows[0]).toEqual({
      externalId: first.orderNo,
      title: first.name,
      machine: first.machine,
      amount: "Amount: 170.00\nDiscount Amount: 0.00",
      isPaid: "Paid Success",
      paidAt: first.paymentTime,
      paymentMethod: first.method,
      rowId: String(first.id),
      orderDate: first.date,
      page: 1,
      pageRow: 1,
    });
    expect(JSON.stringify(read.rows)).not.toContain("Del");
  });

  it.each([
    ["omvänd ordning", [...AWISH_COLUMNS].reverse()],
    [
      "blandad ordning utan Payment Method",
      [
        "Actions",
        "Payment Time",
        "Order No.",
        "Is Paid",
        "Name",
        "ID",
        "Order Amount",
        "Order Machine",
        "Date",
      ] as Column[],
    ],
  ])("kolumnordningen spelar ingen roll (%s)", (_label, columns) => {
    const { read } = readHtmlPage(renderOrdersPage(orders, 2, { columns }), 2);
    const expected = orders.slice(20, 40);
    expect(read.rows.map((r) => [r.externalId, r.title, r.machine, r.paidAt])).toEqual(
      expected.map((o) => [o.orderNo, o.name, o.machine, o.paid ? o.paymentTime : "-"]),
    );
    expect(read.absent).toEqual(columns.includes("Payment Method") ? [] : ["paymentMethod"]);
  });

  it("fast rubrik i en egen tabell (Bootstrap Table) fungerar", () => {
    const { read } = readHtmlPage(renderOrdersPage(orders, 1, { splitHeader: true }), 1);
    expect(read.rows).toHaveLength(20);
    expect(read.rows[0]!.externalId).toBe(orders[0]!.orderNo);
  });

  it("'Amount: 170.00' tolkas av servern till 170,00 kr, Discount Amount tas aldrig", () => {
    const { read } = readHtmlPage(renderOrdersPage(orders, 1), 1);
    const body = parseIngestBody(JSON.stringify({ rows: read.rows }));
    const parsed = parseAwishExtensionBatch({
      context: {
        organizationId: "00000000-0000-4000-8000-000000000001",
        dataSourceId: "00000000-0000-4000-8000-000000000002",
        sourceTimezone: "Asia/Shanghai",
        config: {},
        secretRef: null,
      },
      rows: body.rows,
    });
    expect(parsed.rows[0]!.amountOre).toBe(17_000);
    expect(parsed.rows[1]!.amountOre).toBe(7_900);
    // Ej betald rad (Payment Time "-") räknas som ej betald, inte som fel.
    expect(parsed.rows.filter((r) => r.isPaid).length + parsed.errors.length).toBe(20);
    expect(parsed.errors.every((e) => e.isPaid === false)).toBe(true);
  });

  it("entiteter, <br> och nästlade taggar i cellerna", () => {
    const html = `<table><thead><tr><th>Order&nbsp;No.</th><th>Name</th><th>Order Machine</th><th>Order Amount</th><th>Is Paid</th><th>Payment Time</th></tr></thead>
      <tbody><tr><td><b>4278</b>0</td><td>Pok&eacute;mon &amp; Co &#8211; 151</td><td>Ica<br/>Malmö</td><td>Amount: 170.00<br>Paid Amount: 170.00</td><td><span>Paid&#32;Success</span></td><td>2026-11-02 00:17:00</td></tr></tbody></table>`;
    const { read } = readHtmlPage(html, 1);
    expect(read.rows[0]).toMatchObject({
      externalId: "42780",
      title: "Pok&eacute;mon & Co – 151",
      machine: "Ica\nMalmö",
      amount: "Amount: 170.00\nPaid Amount: 170.00",
      isPaid: "Paid Success",
    });
  });

  it("en tabell utan obligatoriska kolumner är ingen ordertabell", () => {
    const html = `<table><tr><th>ID</th><th>Device No.</th><th>Name</th></tr><tr><td>1</td><td>D-1</td><td>Ica</td></tr></table>`;
    expect(findOrderTable(extractHtml(html).tables)).toBeNull();
    expect(() => readGrid({ headers: ["ID", "Name"], rows: [] }, 1)).toThrow(ReaderError);
  });

  it("rubriker känns igen oavsett skiftläge och skiljetecken", () => {
    const columns = mapColumns([
      "order no",
      "NAME",
      "order-machine",
      "ORDER AMOUNT",
      "is_paid",
      "Payment time",
    ]);
    expect(Object.values(columns).filter((i) => i >= 0)).toHaveLength(6);
  });
});

describe("sidnavigering", () => {
  it("hittar nästa sida och sista sidan (20 rader per sida)", () => {
    const first = readPagination(extractHtml(renderOrdersPage(orders, 1)), 1, BASE);
    expect(first).toEqual({ param: "page", lastPage: 3, hasNext: true });
    const last = readPagination(extractHtml(renderOrdersPage(orders, 3)), 3, pageUrl(BASE, 3));
    expect(last.hasNext).toBe(false);
    expect(last.lastPage).toBe(3);
  });

  it("räknar sista sidan ur 'Showing 1 to 20 of 45 rows' när sidnumren saknas", () => {
    const p = readPagination(
      extractHtml(renderOrdersPage(orders, 1, { totalTextOnly: true })),
      1,
      BASE,
    );
    expect(p.lastPage).toBe(3);
    expect(p.hasNext).toBe(true);
  });

  it("tom sida efter sista sidan har inga rader", () => {
    const { read } = readHtmlPage(renderOrdersPage(orders, 9), 9);
    expect(read.rows).toEqual([]);
    expect(read.seen).toBe(0);
  });

  it("pageUrl sätter parametern och behåller resten", () => {
    expect(pageUrl(`${BASE}?sort=id`, 4)).toBe(`${BASE}?sort=id&page=4`);
  });
});

describe("utloggad", () => {
  it("inloggningssidan och omdirigering till login känns igen", () => {
    expect(
      looksLoggedOut(
        extractHtml(renderLoginPage()),
        "https://dash.awish.vip/dashboard/orders/index",
      ),
    ).toBe(true);
    expect(
      looksLoggedOut(
        extractHtml("<html></html>"),
        "https://dash.awish.vip/dashboard/index/login?url=x",
      ),
    ).toBe(true);
    expect(looksLoggedOut(extractHtml(renderOrdersPage(orders, 1)), BASE)).toBe(false);
  });

  it("JSON-svar om inloggning känns igen", () => {
    expect(
      jsonLoggedOut({ code: 0, msg: "Please login first", url: "/dashboard/index/login" }),
    ).toBe(true);
    expect(jsonLoggedOut({ code: 401 })).toBe(true);
    expect(jsonLoggedOut({ total: 1, rows: [] })).toBe(false);
  });
});

describe("JSON (panelens XHR-API)", () => {
  it("hittar raderna och totalen och läser fälten på nycklarna", () => {
    const found = findJsonRows(ordersJson(orders, 0, 20));
    expect(found?.total).toBe(45);
    const read = readJsonItems(found!.items, 1);
    expect(read.rows).toHaveLength(20);
    expect(read.rows[0]).toMatchObject({
      externalId: orders[0]!.orderNo,
      title: orders[0]!.name,
      machine: orders[0]!.machine,
      amount: "Amount: 170.00",
      isPaid: "Paid Success",
      paidAt: orders[0]!.paymentTime,
      paymentMethod: orders[0]!.method,
    });
    expect(read.rows[4]!.isPaid).toBe("Unpaid");
  });

  it("inbäddade svar (data.list, data.data) och tidsstämplar i sekunder", () => {
    const json = {
      code: 1,
      data: {
        total: 1,
        list: [
          {
            orderSn: "A-1",
            goods: { title: "Box" },
            device_name: "Ica",
            money: 170,
            pay_status: true,
            pay_time: 1_762_013_820,
          },
        ],
      },
    };
    const found = findJsonRows(json);
    const read = readJsonItems(found!.items, 1);
    expect(read.rows[0]).toMatchObject({
      externalId: "A-1",
      title: "Box",
      machine: "Ica",
      amount: "170.00",
      isPaid: "Paid Success",
      paidAt: "2025-11-01T16:17:00Z",
    });
  });

  it("ett svar som inte är ordrar ger null", () => {
    expect(findJsonRows({ data: [{ id: 1, device_no: "D1" }] })).toBeNull();
    expect(findJsonRows({ rows: [] })).toEqual({ items: [], total: null });
  });

  it("API:ts sidparametrar: offset/limit och page/pageSize", () => {
    const offset = jsonApiFromUrl(`${BASE}?sort=id&order=desc&offset=40&limit=20&filter=%7B%7D`)!;
    expect(offset).toMatchObject({
      style: "offset",
      pageParam: "offset",
      sizeParam: "limit",
      pageSize: 20,
    });
    expect(jsonPageUrl(offset, 3)).toBe(
      `${BASE}?sort=id&order=desc&filter=%7B%7D&limit=20&offset=40`,
    );
    const page = jsonApiFromUrl(`${BASE}?page=2&pageSize=50`)!;
    expect(page).toMatchObject({
      style: "page",
      pageParam: "page",
      sizeParam: "pageSize",
      pageSize: 50,
    });
    expect(jsonPageUrl(page, 1)).toBe(`${BASE}?pageSize=50&page=1`);
  });
});
