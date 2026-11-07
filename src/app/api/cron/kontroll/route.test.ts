import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const run = vi.fn(async (_db: unknown) => ({
  ranAt: "2026-11-07T04:37:00.000Z",
  organizations: [
    { organizationId: "org-1", status: "failed", failed: 2, durationMs: 1200 },
    { organizationId: "org-2", status: "skipped", reason: "already_ran" },
  ],
}));
vi.mock("@/server/self-check/job", () => ({ runScheduledSelfChecks: run }));
vi.mock("@/db/client", () => ({ getServiceDb: () => ({}) }));
vi.mock("@/server/monitoring/cron-monitor", () => ({
  CRON_JOBS: { kontroll: { slug: "binderlab-kontroll" } },
  withCronMonitor: async (_job: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { GET } = await import("./route");

const SECRET = "en-lang-hemlighet-1234567890";
const req = (auth?: string) =>
  new Request("https://app.example.se/api/cron/kontroll", {
    headers: auth ? { authorization: auth } : {},
  });

describe("/api/cron/kontroll", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    run.mockClear();
  });

  it("utan CRON_SECRET: 503 och ingen körning", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("för kort CRON_SECRET: 503", async () => {
    process.env.CRON_SECRET = "kort";
    expect((await GET(req("Bearer kort"))).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("fel eller ingen hemlighet: 401", async () => {
    process.env.CRON_SECRET = SECRET;
    expect((await GET(req("Bearer fel"))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rätt hemlighet: kör kontrollen och svarar med utfallet per organisation", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ranAt: "2026-11-07T04:37:00.000Z",
      ran: 1,
      failed: 1,
      errors: 0,
      organizations: [
        { organizationId: "org-1", status: "failed", failed: 2, durationMs: 1200 },
        { organizationId: "org-2", status: "skipped", reason: "already_ran" },
      ],
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("alla körda gick inte att köra: 500", async () => {
    process.env.CRON_SECRET = SECRET;
    run.mockResolvedValueOnce({
      ranAt: "2026-11-07T04:37:00.000Z",
      organizations: [{ organizationId: "org-1", status: "error", error: "x" } as never],
    });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(500);
  });
});
