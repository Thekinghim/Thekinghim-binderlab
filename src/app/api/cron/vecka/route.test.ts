import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const run = vi.fn(async (_db: unknown) => ({
  ranAt: "2026-11-09T06:07:00.000Z",
  organizations: [
    {
      organizationId: "org-1",
      status: "ran",
      week: "2026-11-02",
      sent: 2,
      failed: 1,
      already: 0,
      off: 1,
      errors: 0,
    },
    { organizationId: "org-2", status: "skipped", reason: "not_yet" },
  ] as Record<string, unknown>[],
}));
vi.mock("@/server/weekly/job", () => ({ runWeeklySummaries: run }));
vi.mock("@/db/client", () => ({ getServiceDb: () => ({}) }));
vi.mock("@/server/monitoring/cron-monitor", () => ({
  CRON_JOBS: { vecka: { slug: "binderlab-vecka" } },
  withCronMonitor: async (_job: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { GET } = await import("./route");

const SECRET = "en-lang-hemlighet-1234567890";
const req = (auth?: string) =>
  new Request("https://app.example.se/api/cron/vecka", {
    headers: auth ? { authorization: auth } : {},
  });

describe("/api/cron/vecka", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    run.mockClear();
  });

  it("utan CRON_SECRET: 503 och ingenting skickas", async () => {
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

  it("rätt hemlighet: kör jobbet och svarar med utfallet", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      ranAt: "2026-11-09T06:07:00.000Z",
      ran: 1,
      sent: 2,
      failed: 1,
      errors: 0,
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("ingen organisation i tur (en annan dag än måndag): 200 och inget skickat", async () => {
    process.env.CRON_SECRET = SECRET;
    run.mockResolvedValueOnce({
      ranAt: "2026-11-10T06:07:00.000Z",
      organizations: [{ organizationId: "org-1", status: "skipped", reason: "not_monday" }],
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ran: 0, sent: 0 });
  });

  it("alla utskick gav fel: 500 (bevakningen larmar)", async () => {
    process.env.CRON_SECRET = SECRET;
    run.mockResolvedValueOnce({
      ranAt: "2026-11-09T06:07:00.000Z",
      organizations: [
        { organizationId: "org-1", status: "ran", sent: 0, failed: 0, errors: 2, error: "x" },
      ],
    });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(500);
  });
});
