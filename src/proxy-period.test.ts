/**
 * Proxyn och periodvalet (src/proxy.ts + periodRedirect): en periodsida utan ?period får det
 * sparade valet, en periodsida med ett val sparar det, och ?fran= på andra sidor (Fyll på:s
 * retur ?fran=hem, Rapporters egna datum) skrivs aldrig om. Next:s _rsc följer aldrig med.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERIOD_COOKIE } from "@/components/shell/period-state";
import { resetServerEnvCache } from "@/lib/env";
import { proxy } from "@/proxy";
import { DEV_SESSION_COOKIE, signDevSession } from "@/server/auth/session-token";

const SECRET = "p".repeat(48);
const BASE = "http://localhost:3000";

let session = "";

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("AUTH_PROVIDER", "dev");
  vi.stubEnv("DATABASE_URL", "postgres://postgres@127.0.0.1:54322/binderlab_dev");
  vi.stubEnv("DEV_AUTH_SECRET", SECRET);
  vi.stubEnv("APP_URL", BASE);
  resetServerEnvCache();
  session = await signDevSession(
    { userId: "0f0e0d0c-0b0a-4908-8706-050403020100", email: "anna@example.se" },
    SECRET,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCache();
});

function get(path: string, saved?: string, headers: Record<string, string> = {}) {
  const cookie = [
    `${DEV_SESSION_COOKIE}=${session}`,
    saved ? `${PERIOD_COOKIE}=${encodeURIComponent(saved)}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return proxy(new NextRequest(`${BASE}${path}`, { headers: { cookie, ...headers } }));
}

describe("proxyn och periodvalet", () => {
  it("Fyll på:s ?fran=hem och ?fran=automater står kvar (ingen omdirigering)", async () => {
    for (const path of ["/fyll-pa/abc?fran=hem", "/fyll-pa?fran=automater&rutt=1"]) {
      const res = await get(path, "period=igar");
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.status, path).toBe(200);
    }
  });

  it("Rapporters ?fran=&till= skrivs inte om", async () => {
    const res = await get(
      "/rapporter?typ=butik&manad=2026-10&butiken=x&fran=2026-10-01&till=2026-10-15",
      "period=igar",
    );
    expect(res.headers.get("location")).toBeNull();
  });

  it("en periodsida utan val får kakans val, utan _rsc", async () => {
    const res = await get("/pengar?_rsc=7pN0Py", "period=igar", { rsc: "1" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/pengar?period=igar`);
    const order = await get("/order", "from=2026-11-14&to=2026-11-20");
    expect(order.headers.get("location")).toBe(`${BASE}/order?from=2026-11-14&to=2026-11-20`);
  });

  it("en periodsida med ett val i adressen sparar det i kakan", async () => {
    const res = await get("/pengar?period=idag", "period=igar");
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(PERIOD_COOKIE)?.value).toBe("period=idag");
    const reset = await get("/pengar?period=30d", "period=igar");
    expect(reset.cookies.get(PERIOD_COOKIE)?.value).toBe("");
    const same = await get("/pengar?period=igar", "period=igar");
    expect(same.cookies.get(PERIOD_COOKIE)).toBeUndefined();
  });
});
