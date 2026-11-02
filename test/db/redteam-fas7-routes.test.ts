/**
 * Röd granskning fas 7: route handlers (route.ts) och sidor anropade med fel roll.
 *
 * Samma riktiga stack som redteam-fas7-actions.test.ts (dev-sessionscookie,
 * session.ts, requireRole och RLS); bara Nexts förfrågan är fejkad.
 *
 *   - Exporter och filer (order-CSV, SIE, avtalsfil, rapportfiler, portalens PDF):
 *     påfyllaren, butiken, en icke-medlem och en utloggad får aldrig innehållet, och
 *     A:s id:n ger samma 404 för en utomstående som ett okänt id.
 *   - Sökningen: påfyllaren får inga order och inga belopp.
 *   - Assistenten: fel ursprung, utloggad och butiken nekas innan något körs.
 *   - Schemalagda jobb: utan CRON_SECRET (eller med fel/för kort) körs inget.
 *   - Sidorna: påfyllaren och butiken skickas bort från sidor som inte är deras,
 *     och påfyllarens egna sidor skickar inga belopp till klientkomponenterna.
 */

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const req = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));

vi.mock("next/headers", async () => {
  const { createRequestMock } = await import("./redteam-fas7-harness");
  return createRequestMock(req).headers;
});
vi.mock("next/navigation", async () => {
  const { createRequestMock } = await import("./redteam-fas7-harness");
  return createRequestMock(req).navigation;
});
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  unstable_noStore: vi.fn(),
}));

import { db, one } from "./helpers";
import {
  call,
  keysDeep,
  loginAs,
  MONEY_KEY,
  NextSignal,
  seedCast,
  type Cast,
  type PersonaName,
} from "./redteam-fas7-harness";

let cast: Cast;
let reportIdA: string;

beforeAll(async () => {
  cast = await seedCast();
  reportIdA = (
    await one<{ id: string }>(
      db(),
      sql`select id from public.reports where organization_id = ${cast.A.orgId} limit 1`,
    )
  ).id;
}, 180_000);

const BASE = "http://localhost:3200";

/** Svaret, eller omdirigeringen som redirect() kastade. */
async function respond(
  run: () => Promise<Response>,
): Promise<{ status: number; body: string; headers: Headers; redirect?: string }> {
  try {
    const res = await run();
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch (error) {
    if (error instanceof NextSignal) {
      return { status: 307, body: "", headers: new Headers(), redirect: error.redirectTo ?? "" };
    }
    throw error;
  }
}

const NOT_ECONOMY: PersonaName[] = ["refiller", "store", "stranger", "anon"];

// ---------------------------------------------------------------------------
// Exporter och filer
// ---------------------------------------------------------------------------

describe("exporter och filer", () => {
  it("GET /order/export: bara ägare, admin och läsare; utomstående får bara sina egna order", async () => {
    const { GET } = await import("@/app/(app)/order/export/route");
    for (const p of NOT_ECONOMY) {
      await loginAs(req, cast.personas[p]);
      const r = await respond(() => GET(new NextRequest(`${BASE}/order/export?period=allt`)));
      expect([401, 403, 307], p).toContain(r.status);
      expect(r.body, p).not.toMatch(/Ordernummer|;\d+,\d\d/);
    }
    await loginAs(req, cast.personas.outsider);
    const r = await respond(() => GET(new NextRequest(`${BASE}/order/export?period=allt`)));
    for (const id of cast.A.orderIds) expect(r.body).not.toContain(id);
    expect(r.body).not.toContain(cast.A.storeId);
  });

  it("GET /order/export: A:s butik eller automat i filtret ger ingen rad för en utomstående", async () => {
    const { GET } = await import("@/app/(app)/order/export/route");
    await loginAs(req, cast.personas.outsider);
    const r = await respond(() =>
      GET(
        new NextRequest(
          `${BASE}/order/export?period=allt&butik=${cast.A.storeId}&automat=${cast.A.machineId}`,
        ),
      ),
    );
    // Bara BOM + rubrikrad (eller ett nej), aldrig A:s order.
    const lines = r.body.split("\r\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it("GET /ekonomi/sie: påfyllaren, butiken, en icke-medlem och en utloggad nekas", async () => {
    const { GET } = await import("@/app/(app)/ekonomi/sie/route");
    for (const p of NOT_ECONOMY) {
      await loginAs(req, cast.personas[p]);
      const r = await respond(() => GET(new NextRequest(`${BASE}/ekonomi/sie?manad=2025-03`)));
      expect([401, 403, 307], p).toContain(r.status);
      expect(r.body, p).not.toContain("#VER");
    }
  });

  it("GET /avtal/[id]/fil: nekas utan ekonomiroll, och A:s avtal är 404 för en utomstående", async () => {
    const { GET } = await import("@/app/(app)/avtal/[id]/fil/route");
    const ctx = { params: Promise.resolve({ id: cast.A.contractId }) };
    for (const p of NOT_ECONOMY) {
      await loginAs(req, cast.personas[p]);
      const r = await respond(() => GET(new Request(`${BASE}/avtal/x/fil`), ctx));
      expect([401, 403, 404, 307], p).toContain(r.status);
      expect(r.body, p).not.toMatch(/%PDF/);
    }
    await loginAs(req, cast.personas.outsider);
    const theirs = await respond(() =>
      GET(new Request(`${BASE}/avtal/x/fil`), {
        params: Promise.resolve({ id: cast.A.contractId }),
      }),
    );
    const unknown = await respond(() =>
      GET(new Request(`${BASE}/avtal/x/fil`), {
        params: Promise.resolve({ id: crypto.randomUUID() }),
      }),
    );
    expect(theirs.status).toBe(404);
    // Samma svar för A:s avtal som för ett id som inte finns (inget orakel).
    expect(theirs.body).toBe(unknown.body);
  });

  it("GET /rapport/[id]/fil/[typ]: nekas utan ekonomiroll; A:s rapport är 404 för en utomstående", async () => {
    const { GET } = await import("@/app/rapport/[id]/fil/[typ]/route");
    for (const typ of ["sie", "xlsx", "pdf"]) {
      for (const p of NOT_ECONOMY) {
        await loginAs(req, cast.personas[p]);
        const r = await respond(() =>
          GET(new Request(`${BASE}/rapport/x/fil/${typ}`), {
            params: Promise.resolve({ id: reportIdA, typ }),
          }),
        );
        expect([401, 403, 404, 307], `${p} ${typ}`).toContain(r.status);
      }
      await loginAs(req, cast.personas.outsider);
      const theirs = await respond(() =>
        GET(new Request(`${BASE}/rapport/x/fil/${typ}`), {
          params: Promise.resolve({ id: reportIdA, typ }),
        }),
      );
      const unknown = await respond(() =>
        GET(new Request(`${BASE}/rapport/x/fil/${typ}`), {
          params: Promise.resolve({ id: crypto.randomUUID(), typ }),
        }),
      );
      expect(theirs.status, typ).toBe(unknown.status);
      expect(theirs.body, typ).toBe(unknown.body);
    }
  });

  it("GET /portal/rapporter/[id]/pdf: bara butiksanvändaren för rapportens butik", async () => {
    const { GET } = await import("@/app/portal/rapporter/[id]/pdf/route");
    for (const p of ["owner", "admin", "viewer", "refiller", "outsider", "stranger"] as const) {
      await loginAs(req, cast.personas[p]);
      const r = await respond(() =>
        GET(new Request(`${BASE}/portal/rapporter/x/pdf`), {
          params: Promise.resolve({ id: reportIdA }),
        }),
      );
      expect([404, 307], p).toContain(r.status);
      expect(r.headers.get("content-type") ?? "", p).not.toContain("pdf");
    }
    await loginAs(req, cast.personas.anon);
    const anon = await respond(() =>
      GET(new Request(`${BASE}/portal/rapporter/x/pdf`), {
        params: Promise.resolve({ id: reportIdA }),
      }),
    );
    expect(anon.redirect ?? "").toMatch(/^\/logga-in/);
  });

  it("GET /portal/rapporter/[id]/pdf: ett id som inte är ett uuid ger 404, inte ett serverfel", async () => {
    const { GET } = await import("@/app/portal/rapporter/[id]/pdf/route");
    await loginAs(req, cast.personas.store);
    const r = await respond(() =>
      GET(new Request(`${BASE}/portal/rapporter/x/pdf`), {
        params: Promise.resolve({ id: "../../etc/passwd" }),
      }),
    ).catch((error: unknown) => ({ status: 500, body: String(error), headers: new Headers() }));
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Sökningen
// ---------------------------------------------------------------------------

describe("GET /sok", () => {
  it("påfyllaren får inga order och inga belopp, inte heller vid sökning på ordernummer", async () => {
    const { GET } = await import("@/app/(app)/sok/route");
    await loginAs(req, cast.personas.refiller);
    const externalId = (
      await one<{ e: string }>(
        db(),
        sql`select external_id as e from public.orders where id = ${cast.A.orderIds[0]}`,
      )
    ).e;
    for (const q of ["a", "BL", externalId, "Pokémon", "ICA"]) {
      const r = await respond(() => GET(new NextRequest(`${BASE}/sok?q=${encodeURIComponent(q)}`)));
      expect(r.status, q).toBe(200);
      const json = JSON.parse(r.body) as unknown;
      expect(
        [...keysDeep(json)].filter((k) => MONEY_KEY.test(k)),
        q,
      ).toEqual([]);
      expect(r.body, q).not.toMatch(/\d\s?kr\b/);
      for (const id of cast.A.orderIds) expect(r.body, q).not.toContain(id);
    }
    const prices = await respond(() => GET(new NextRequest(`${BASE}/sok?lista=inkopspris`)));
    expect(prices.status).toBe(403);
  });

  it("butiken och en icke-medlem nekas; en utomstående hittar inget i A", async () => {
    const { GET } = await import("@/app/(app)/sok/route");
    for (const p of ["store", "stranger"] as const) {
      await loginAs(req, cast.personas[p]);
      const r = await respond(() => GET(new NextRequest(`${BASE}/sok?q=ICA`)));
      expect([401, 403], p).toContain(r.status);
    }
    await loginAs(req, cast.personas.outsider);
    const r = await respond(() =>
      GET(new NextRequest(`${BASE}/sok?lista=pafyllning&automat=${cast.A.machineId}`)),
    );
    expect(r.body).not.toContain(cast.A.titleId);
  });
});

// ---------------------------------------------------------------------------
// Assistenten
// ---------------------------------------------------------------------------

describe("POST /assistent/fraga", () => {
  function post(headers: Record<string, string>, body = { question: "Hur mycket sålde vi?" }) {
    return new Request(`${BASE}/assistent/fraga`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("fel ursprung nekas även för ägaren (CSRF)", async () => {
    const { POST } = await import("@/app/(app)/assistent/fraga/route");
    await loginAs(req, cast.personas.owner);
    const attempts: Array<Record<string, string>> = [
      { origin: "https://evil.example", host: "localhost:3200" },
      { "sec-fetch-site": "cross-site", host: "localhost:3200" },
      { origin: "null", host: "localhost:3200" },
    ];
    for (const headers of attempts) {
      const r = await respond(() => POST(post(headers)));
      expect(r.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("utloggad, butiken och en icke-medlem nekas innan modellen anropas", async () => {
    const { POST } = await import("@/app/(app)/assistent/fraga/route");
    for (const p of ["anon", "store", "stranger"] as const) {
      await loginAs(req, cast.personas[p]);
      const r = await respond(() => POST(post({ origin: BASE, host: "localhost:3200" })));
      expect([401, 403], p).toContain(r.status);
    }
  });
});

// ---------------------------------------------------------------------------
// Schemalagda jobb
// ---------------------------------------------------------------------------

describe("cron-rutterna", () => {
  const saved = process.env.CRON_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it.each(["@/app/api/cron/larm/route", "@/app/api/cron/rapporter/route"])(
    "%s: utan CRON_SECRET eller med en för kort körs inget (503)",
    async (module) => {
      const { GET } = (await import(/* @vite-ignore */ module)) as {
        GET: (r: Request) => Promise<Response>;
      };
      for (const secret of [undefined, "", "kort", "   "]) {
        if (secret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = secret;
        const r = await GET(
          new Request(`${BASE}/api/cron/x`, { headers: { authorization: "Bearer " } }),
        );
        expect(r.status, String(secret)).toBe(503);
      }
    },
  );

  it.each(["@/app/api/cron/larm/route", "@/app/api/cron/rapporter/route"])(
    "%s: fel, saknad eller nästan rätt hemlighet ger 401",
    async (module) => {
      const { GET } = (await import(/* @vite-ignore */ module)) as {
        GET: (r: Request) => Promise<Response>;
      };
      const secret = "rodteam-cron-hemlighet-0123456789";
      process.env.CRON_SECRET = secret;
      for (const authorization of [
        null,
        "",
        `bearer ${secret}`,
        `Bearer ${secret.slice(0, -1)}`,
        `Basic ${Buffer.from(`x:${secret}`).toString("base64")}`,
        secret,
      ]) {
        const headers: Record<string, string> = {};
        if (authorization !== null) headers.authorization = authorization;
        const r = await GET(new Request(`${BASE}/api/cron/x`, { headers }));
        expect(r.status, String(authorization)).toBe(401);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Sidorna
// ---------------------------------------------------------------------------

/** Sidor med approllernas meny, och vilka roller som får se dem (components/shell/nav). */
const ECONOMY_PAGES = [
  "lonsamhet",
  "order",
  "automater",
  "butiker",
  "inkopspriser",
  "rapporter",
  "prognos",
  "expansion",
  "ekonomi",
  "avtal",
  "marknad",
  "effekt",
];
const OPERATOR_PAGES = ["datakallor", "installningar", "installningar/anvandare"];

/**
 * Listsidor med en detaljsida ligger i gruppen (oversikt), så att detaljsidans
 * existenskontroll körs före listans laddningsläge (HTTP 404 för okänt id).
 */
const GROUPED = new Set(["automater", "butiker", "datakallor", "drift", "inkorg"]);

async function renderPage(route: string, params: Record<string, string> = {}) {
  const file = GROUPED.has(route) ? `${route}/(oversikt)` : route;
  const mod = (await import(/* @vite-ignore */ `@/app/(app)/${file}/page`)) as {
    default: (props: unknown) => Promise<unknown>;
  };
  return call(() =>
    mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve({}) }),
  );
}

describe("sidorna", () => {
  it.each([...ECONOMY_PAGES, ...OPERATOR_PAGES])(
    "/%s: påfyllaren skickas till sin startsida innan något läses",
    async (route) => {
      await loginAs(req, cast.personas.refiller);
      const outcome = await renderPage(route);
      expect(outcome.kind).toBe("redirect");
      // Startsidan med en förklaring (?nekad=<rutt>, DeniedNotice i skalet).
      expect((outcome as { to: string }).to).toBe(`/att-gora?nekad=${route.split("/")[0]}`);
    },
    60_000,
  );

  it.each(OPERATOR_PAGES)(
    "/%s: läsaren skickas bort (bara ägare och admin)",
    async (route) => {
      await loginAs(req, cast.personas.viewer);
      const outcome = await renderPage(route);
      expect(outcome.kind).not.toBe("ok");
    },
    60_000,
  );

  it.each([
    "att-gora",
    "lager",
    "drift",
    "drift/larm",
    "drift/besok",
    "drift/pafyllning",
    "inkorg",
  ])(
    "/%s: påfyllarens egen sida skickar inga belopp till klienten (props i sidans träd)",
    async (route) => {
      await loginAs(req, cast.personas.refiller);
      const outcome = await renderPage(route);
      expect(outcome.kind, outcome.kind === "ok" ? "" : JSON.stringify(outcome).slice(0, 200)).toBe(
        "ok",
      );
      const money = [...keysDeep((outcome as { value: unknown }).value)].filter((k) =>
        MONEY_KEY.test(k),
      );
      expect(money).toEqual([]);
    },
    60_000,
  );
});
