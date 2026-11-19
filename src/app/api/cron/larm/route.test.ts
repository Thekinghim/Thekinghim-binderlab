import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ freshServiceDb: async () => ({ db: true }) }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({}) }));
vi.mock("@/server/request-info", () => ({ resolveAppBaseUrl: () => "https://app.example.se" }));
vi.mock("@/server/monitoring/cron-monitor", () => ({
  CRON_JOBS: { larm: { slug: "binderlab-larm" } },
  withCronMonitor: async (_job: unknown, fn: () => Promise<unknown>) => fn(),
}));
const alerts = vi.fn(async () => ({
  ranAt: "2026-11-19T05:07:00.000Z",
  organizations: [{ organizationId: "org-1", status: "ok" }],
  deliveries: { processed: 0, sent: 0, failed: 0, skipped: 0 },
}));
vi.mock("@/server/alerts/job", () => ({ runAlertJob: alerts }));
const settlements = vi.fn(async () => [
  {
    organizationId: "org-1",
    created: 0,
    refreshed: 1,
    errors: [{ storeId: "s1", message: "Sega gubben: order utan inköpspris." }],
  },
]);
vi.mock("@/server/settlements/service", () => ({ createMonthlySettlements: settlements }));
const settlementAlerts = vi.fn(async (_deps: unknown, _runs: unknown) => ({ failed: 1 }));
vi.mock("@/server/monitoring/failures", () => ({ recordSettlementRuns: settlementAlerts }));
const checks = vi.fn(async () => ({
  ranAt: "2026-11-19T05:07:00.000Z",
  organizations: [
    { organizationId: "org-1", status: "ok" },
    { organizationId: "org-2", status: "skipped", reason: "already_ran" },
  ],
}));
vi.mock("@/server/self-check/job", () => ({ runScheduledSelfChecks: checks }));
const watch = vi.fn(async () => ({ raised: 1, resolved: 0 }));
vi.mock("@/server/monitoring/watch", () => ({ syncWatchAlertsForAll: watch }));

const { GET, maxDuration } = await import("./route");

const SECRET = "en-lang-hemlighet-1234567890";
const req = () =>
  new Request("https://app.example.se/api/cron/larm", {
    headers: { authorization: `Bearer ${SECRET}` },
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("/api/cron/larm", () => {
  it("kör också dagens kontroll (om den inte har kört) och vakten, efter larmen", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.selfChecks).toEqual({ ran: 1, errors: 0 });
    // En butik som inte gick att räkna går vidare till larmen, inte bara till loggen.
    expect(body.settlements).toEqual({ created: 0, refreshed: 1, errors: 1 });
    expect(settlementAlerts).toHaveBeenCalledTimes(1);
    expect(settlementAlerts.mock.calls[0]?.[1]).toMatchObject([
      { organizationId: "org-1", errors: [{ storeId: "s1" }] },
    ]);
    expect(body.watch).toEqual({ raised: 1, resolved: 0 });
    expect(alerts.mock.invocationCallOrder[0]!).toBeLessThan(checks.mock.invocationCallOrder[0]!);
    expect(checks.mock.invocationCallOrder[0]!).toBeLessThan(watch.mock.invocationCallOrder[0]!);
    // Kontrollen får plats: routen har 300 s.
    expect(maxDuration).toBe(300);
  });

  it("ett fel i kontrollen stoppar varken larmen eller vakten", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    checks.mockRejectedValueOnce(new Error("Databasen svarar inte."));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.selfChecks).toBeNull();
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("utan rätt hemlighet körs ingenting", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await GET(new Request("https://app.example.se/api/cron/larm"));
    expect(res.status).toBe(401);
    expect(alerts).not.toHaveBeenCalled();
    expect(checks).not.toHaveBeenCalled();
  });
});
