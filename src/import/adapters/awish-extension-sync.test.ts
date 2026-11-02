/**
 * Chrome-tilläggets synk (extensions/awish-sync/src/sync.ts) mot en låtsas-Awish och ett
 * låtsas-Binderlab i minnet: batchning, var den slutar läsa, hela historiken (med
 * återupptagning), utloggning, ogiltig token, backoff vid 429 och JSON-API:t.
 */

import { describe, expect, it } from "vitest";

import { extractHtml } from "../../../extensions/awish-sync/src/extract-html";
import type { OrderRow } from "../../../extensions/awish-sync/src/reader";
import { initialState, runSync, type SyncDeps } from "../../../extensions/awish-sync/src/sync";
import {
  makeOrders,
  ordersJson,
  renderLoginPage,
  renderOrdersPage,
  type MockOrder,
} from "../../../extensions/awish-sync/test/mock-awish";

const AWISH = "https://dash.awish.vip";
const BINDERLAB = "https://binderlab.example";
const TOKEN = `blsync_${"A".repeat(43)}`;
const settings = { binderlabUrl: BINDERLAB, token: TOKEN };

interface Fake {
  orders: MockOrder[];
  loggedIn: boolean;
  json: boolean;
  /** Binderlabs kända ordernummer (betalda som tagits emot). */
  known: Set<string>;
  batches: { rows: OrderRow[]; report?: { state: string } }[];
  reports: { state: string; message?: string }[];
  awishHits: string[];
  /** Svar som Binderlab ger i tur och ordning innan det svarar normalt. */
  binderlabFailures: number[];
  /** Kasta efter så här många Awish-anrop (simulerar att service workern stängs). */
  crashAfterAwishHits?: number;
  tokenRevoked: boolean;
  slept: number[];
}

function fake(overrides: Partial<Fake> = {}): Fake {
  return {
    orders: makeOrders(95),
    loggedIn: true,
    json: false,
    known: new Set(),
    batches: [],
    reports: [],
    awishHits: [],
    binderlabFailures: [],
    tokenRevoked: false,
    slept: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fetchFor(f: Fake): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const headers = new Headers(init?.headers);
    if (url.origin === AWISH) {
      f.awishHits.push(`${url.pathname}${url.search}`);
      if (f.crashAfterAwishHits !== undefined && f.awishHits.length > f.crashAfterAwishHits) {
        throw new Error("Service workern stängdes.");
      }
      expect(init?.credentials).toBe("include");
      if (!f.loggedIn) {
        if (headers.get("x-requested-with"))
          return json({ code: 0, msg: "Please login first", url: "/dashboard/index/login" });
        const res = new Response(renderLoginPage(), {
          status: 200,
          headers: { "content-type": "text/html" },
        });
        Object.defineProperty(res, "redirected", { value: true });
        Object.defineProperty(res, "url", { value: `${AWISH}/dashboard/index/login?url=x` });
        return res;
      }
      if (headers.get("x-requested-with") && f.json) {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "20");
        return json(ordersJson(f.orders, offset, limit));
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      return new Response(renderOrdersPage(f.orders, page), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.origin === BINDERLAB) {
      expect(init?.credentials).toBe("omit");
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      if (f.tokenRevoked)
        return json(
          { ok: false, error: "Token är ogiltig eller återkallad.", code: "unauthorized" },
          401,
        );
      const failure = f.binderlabFailures.shift();
      if (failure)
        return json(
          { ok: false, error: "Tillfälligt fel" },
          failure,
          failure === 429 ? { "retry-after": "3" } : {},
        );
      if (url.pathname === "/api/ingest/awish/status") {
        return json({
          ok: true,
          dataSource: {
            id: "ds",
            name: "Awish via tillägg",
            sourceTimezone: "Asia/Shanghai",
            status: "active",
          },
          lastSyncedAt: null,
          orders: {
            count: f.known.size,
            latestExternalId: null,
            latestOrderedAt: null,
            knownExternalIds: [...f.known],
          },
          limits: { maxRows: 500, maxBodyBytes: 2_000_000 },
        });
      }
      if (url.pathname === "/api/ingest/awish" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          rows: OrderRow[];
          report?: { state: string; message?: string };
        };
        expect(body.rows.length).toBeLessThanOrEqual(500);
        if (body.rows.length === 0) {
          if (body.report) f.reports.push(body.report);
          return json({ ok: true, importId: null, summary: null, lastSyncedAt: null });
        }
        f.batches.push(body);
        let fresh = 0;
        for (const r of body.rows) {
          if (r.isPaid === "Paid Success" && !f.known.has(r.externalId)) {
            f.known.add(r.externalId);
            fresh += 1;
          }
        }
        return json({
          ok: true,
          importId: `imp-${f.batches.length}`,
          summary: {
            total: body.rows.length,
            new: fresh,
            duplicate: body.rows.length - fresh,
            conflict: 0,
            error: 0,
            notPaid: 0,
          },
          lastSyncedAt: new Date().toISOString(),
        });
      }
    }
    throw new Error(`Oväntad adress ${url.toString()}`);
  }) as typeof fetch;
}

function deps(f: Fake, extra: Partial<SyncDeps> = {}): SyncDeps {
  return {
    fetch: fetchFor(f),
    parseHtml: async (html) => extractHtml(html),
    now: () => new Date("2026-11-02T10:00:00Z"),
    sleep: async (ms) => {
      f.slept.push(ms);
    },
    awishOrigin: AWISH,
    ordersPath: "/dashboard/orders/index",
    pageSize: 20,
    apiProbeIntervalMs: 86_400_000,
    version: "1.0.0-test",
    pageDelayMs: 1000,
    batchSize: 50,
    overlapPages: 1,
    maxIncrementalPages: 2000,
    ...extra,
  };
}

const paidIds = (orders: MockOrder[]) => orders.filter((o) => o.paid).map((o) => o.orderNo);

describe("första synken: hela historiken", () => {
  it("läser alla sidor i lugn takt, skickar i batcher och rapporterar ok", async () => {
    const f = fake();
    const state = await runSync(deps(f), settings, initialState());
    expect(state.lastError).toBeNull();
    expect(state.loggedOut).toBe(false);
    expect(state.full).toBeNull();
    // 95 ordrar = 5 sidor, plus en provning av JSON-API:t (svarar HTML här).
    expect(f.awishHits.filter((h) => !h.includes("offset=") && !h.includes("limit=")).length).toBe(
      5,
    );
    expect(f.batches.map((b) => b.rows.length)).toEqual([60, 35]);
    expect([...f.known].sort()).toEqual(paidIds(f.orders).sort());
    // En sida i sekunden mellan sidorna.
    expect(f.slept.filter((ms) => ms === 1000)).toHaveLength(4);
    expect(f.reports.at(-1)).toMatchObject({ state: "ok", fullHistory: true, pagesRead: 5 });
    expect(state.lastRun).toMatchObject({
      mode: "full",
      source: "html",
      pagesRead: 5,
      rowsSent: 95,
    });
  });

  it("en avbruten läsning fortsätter där den senast skickade batchen slutade", async () => {
    const f = fake({ crashAfterAwishHits: 5 });
    const first = await runSync(deps(f), settings, initialState());
    expect(first.lastError).toMatch(/svarar inte|stängdes/);
    expect(first.full).toMatchObject({ active: true });
    const resumeFrom = first.full!.nextPage;
    expect(resumeFrom).toBeGreaterThan(1);
    f.crashAfterAwishHits = undefined;
    f.awishHits = [];
    const second = await runSync(deps(f), settings, first);
    expect(second.full).toBeNull();
    expect(f.awishHits[0]).toContain(`page=${resumeFrom}`);
    expect([...f.known].sort()).toEqual(paidIds(f.orders).sort());
  });
});

describe("vanlig synk", () => {
  it("slutar läsa vid kända ordernummer (plus en sida överlapp) och skickar bara nya", async () => {
    const f = fake();
    const first = await runSync(deps(f), settings, initialState());
    // Fem nya ordrar högst upp.
    const newer = makeOrders(5, 42_095, Date.UTC(2026, 10, 2, 9, 0, 0));
    f.orders = [...newer, ...f.orders];
    f.batches = [];
    f.awishHits = [];
    const run = await runSync(deps(f), settings, first);
    expect(run.lastRun?.mode).toBe("incremental");
    expect(run.lastRun?.pagesRead).toBe(2);
    const sent = f.batches.flatMap((b) => b.rows.map((r) => r.externalId));
    expect(sent).toEqual(expect.arrayContaining(paidIds(newer)));
    expect(sent.every((id) => !paidIds(f.orders.slice(5)).includes(id))).toBe(true);
  });

  it("ingen ny order: ingen batch, bara en rapport", async () => {
    const f = fake();
    const first = await runSync(deps(f), settings, initialState());
    f.batches = [];
    f.reports = [];
    const again = await runSync(deps(f), settings, first);
    expect(f.batches).toEqual([]);
    expect(f.reports).toEqual([expect.objectContaining({ state: "ok", fullHistory: false })]);
    expect(again.lastRun).toMatchObject({ mode: "incremental", rowsSent: 0 });
  });

  it("en ej betald order skickas en gång, och igen när den blivit betald", async () => {
    const f = fake();
    const first = await runSync(deps(f), settings, initialState());
    const unpaid = f.orders.find((o) => !o.paid)!;
    expect(first.sentUnpaid).toContain(unpaid.orderNo);
    f.batches = [];
    let state = await runSync(deps(f), settings, first);
    expect(f.batches.flatMap((b) => b.rows).map((r) => r.externalId)).not.toContain(unpaid.orderNo);
    unpaid.paid = true;
    state = await runSync(deps(f), settings, state);
    expect(f.batches.flatMap((b) => b.rows).map((r) => r.externalId)).toContain(unpaid.orderNo);
    expect(state.sentUnpaid).not.toContain(unpaid.orderNo);
  });

  it("'Läs hela historiken igen' läser alla sidor och skickar även kända", async () => {
    const f = fake();
    const first = await runSync(deps(f), settings, initialState());
    f.batches = [];
    const again = await runSync(deps(f), settings, first, { full: true });
    expect(again.lastRun).toMatchObject({ mode: "full", pagesRead: 5, rowsSent: 95 });
  });
});

describe("fel", () => {
  it("utloggad från Awish: inget läses, Binderlab får rapporten, popupen visar inloggningstexten", async () => {
    const f = fake({ loggedIn: false, known: new Set(["1"]) });
    const state = await runSync(deps(f), settings, initialState());
    expect(state.loggedOut).toBe(true);
    expect(state.lastError).toBe("Logga in på dash.awish.vip i Chrome så fortsätter synken.");
    expect(f.batches).toEqual([]);
    expect(f.reports).toEqual([expect.objectContaining({ state: "logged_out" })]);
    f.loggedIn = true;
    const later = await runSync(deps(f), settings, state);
    expect(later.loggedOut).toBe(false);
    expect(later.lastError).toBeNull();
  });

  it("återkallad token: stoppar direkt och markerar token som ogiltig", async () => {
    const f = fake({ tokenRevoked: true });
    const state = await runSync(deps(f), settings, initialState());
    expect(state.tokenInvalid).toBe(true);
    expect(f.awishHits).toEqual([]);
  });

  it("429 och 5xx från Binderlab: återförsök med backoff (Retry-After respekteras)", async () => {
    const f = fake({ binderlabFailures: [429, 503] });
    const state = await runSync(deps(f), settings, initialState());
    expect(state.lastError).toBeNull();
    expect(f.slept.slice(0, 2)).toEqual([3000, 4000]);
  });

  it("utan inställningar händer ingenting", async () => {
    const f = fake();
    const state = await runSync(deps(f), null, initialState());
    expect(state.lastError).toMatch(/adress och token/);
    expect(f.awishHits).toEqual([]);
  });

  it("fel form på adress eller token avvisas innan något anropas", async () => {
    const f = fake();
    expect(
      (
        await runSync(
          deps(f),
          { binderlabUrl: "http://binderlab.example", token: TOKEN },
          initialState(),
        )
      ).lastError,
    ).toMatch(/https/);
    expect(
      (await runSync(deps(f), { binderlabUrl: BINDERLAB, token: "x" }, initialState())).lastError,
    ).toMatch(/Token/);
    expect(f.awishHits).toEqual([]);
  });
});

describe("JSON-API:t", () => {
  it("hittas genom att fråga orderlistan som XHR och används för alla sidor", async () => {
    const f = fake({ json: true });
    const state = await runSync(deps(f), settings, initialState());
    expect(state.awish.api).toMatchObject({ style: "offset", pageSize: 20 });
    expect(state.awish.apiSource).toBe("probed");
    expect(state.lastRun?.source).toBe("json");
    expect(f.awishHits.every((h) => h.includes("offset="))).toBe(true);
    expect([...f.known].sort()).toEqual(paidIds(f.orders).sort());
  });

  it("utan JSON faller den tillbaka på HTML och provar inte igen förrän efter ett dygn", async () => {
    const f = fake({ json: false });
    const state = await runSync(deps(f), settings, initialState());
    expect(state.awish.api).toBeNull();
    expect(state.awish.apiProbeFailedAt).not.toBeNull();
    f.awishHits = [];
    await runSync(deps(f), settings, state);
    expect(f.awishHits.some((h) => h.includes("offset="))).toBe(false);
  });
});
