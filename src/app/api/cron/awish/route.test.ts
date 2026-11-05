import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ getServiceDb: () => ({}) }));
const sync = vi.fn(async () => ({
  sources: [
    {
      dataSourceId: "ds-1",
      organizationId: "org-1",
      ok: true,
      skipped: null,
      message: null,
      importId: null,
      pages: 2,
      fetched: 40,
      summary: null,
      otherSourceDuplicates: 0,
      historyDone: true,
    },
  ],
}));
vi.mock("@/server/awish/sync", () => ({ syncAllAwishSources: sync }));
const campaigns = vi.fn(async () => ({ organizations: 1, shown: 2, failed: 0 }));
vi.mock("@/server/campaigns/service", () => ({ publishAllDueCampaigns: campaigns }));
const offline = vi.fn(async (_db: unknown, _orgs: string[], _o: unknown) => ({
  organizations: [{ organizationId: "org-1" }],
  deliveries: { processed: 1, sent: 1, failed: 0, skipped: 0 },
}));
vi.mock("@/server/awish/offline-alerts", () => ({ runOfflineAlerts: offline }));

const { GET } = await import("./route");

const SECRET = "en-lang-hemlighet-1234567890";
const req = (auth?: string) =>
  new Request("https://app.example.se/api/cron/awish", {
    headers: auth ? { authorization: auth } : {},
  });

describe("/api/cron/awish", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    sync.mockClear();
    campaigns.mockClear();
    offline.mockClear();
  });

  it("utan CRON_SECRET: 503 och ingen synk", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(sync).not.toHaveBeenCalled();
    expect(campaigns).not.toHaveBeenCalled();
  });

  it("fel hemlighet: 401 och ingen synk", async () => {
    process.env.CRON_SECRET = SECRET;
    expect((await GET(req("Bearer fel-hemlighet-1234567890"))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
    expect(campaigns).not.toHaveBeenCalled();
  });

  it("rätt hemlighet: synkar och svarar bara med räknare", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledTimes(1);
    // Planerade kampanjer (redan bekräftade i appen) skickas efter synken.
    expect(campaigns).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({
      ok: true,
      sources: [
        {
          id: "ds-1",
          ok: true,
          skipped: null,
          message: null,
          pages: 2,
          fetched: 40,
          new: 0,
          historyDone: true,
        },
      ],
      campaigns: { shown: 2, failed: 0 },
      offlineAlerts: { organizations: 1, sent: 1 },
    });
    // Offlinelarmet utvärderas direkt efter synken för de synkade organisationerna.
    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0]?.[1]).toEqual(["org-1"]);
  });

  it("ett fel i kampanjerna stoppar inte synkens svar", async () => {
    process.env.CRON_SECRET = SECRET;
    campaigns.mockRejectedValueOnce(new Error("nere"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).campaigns).toBeNull();
  });
});
