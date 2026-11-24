import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({
  getServiceDb: () => ({}),
  freshServiceDb: async () => ({}),
}));
const watch = vi.fn(async () => ({ raised: 0, resolved: 0 }));
vi.mock("@/server/monitoring/watch", () => ({ syncWatchAlertsForAll: watch }));
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
const pushRetry = vi.fn(async (_db: unknown, _o: { deadline: number }) => ({
  organizations: 1,
  tried: 1,
  cleared: 1,
  waiting: 0,
  breaker: 0,
  budget: 0,
  errors: 0,
}));
vi.mock("@/server/awish/web-service", () => ({ retryPendingAwishPushesForAll: pushRetry }));
const offline = vi.fn(async (_db: unknown, _orgs: string[], _o: unknown) => ({
  organizations: [{ organizationId: "org-1" }],
  deliveries: { processed: 1, sent: 1, failed: 0, skipped: 0 },
}));
vi.mock("@/server/awish/offline-alerts", () => ({ runOfflineAlerts: offline }));
const salePush = vi.fn(async (_db: unknown, _o: unknown) => ({
  ranAt: "2026-11-23T10:00:00.000Z",
  organizations: [{ organizationId: "org-1", orders: 2, sent: 1, failed: 0, quiet: 0, late: 0 }],
}));
vi.mock("@/server/sales-push/job", () => ({
  runSaleNotifications: salePush,
  SALE_PUSH_BUDGET_MS: 12_000,
}));

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
    pushRetry.mockClear();
    offline.mockClear();
    salePush.mockClear();
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
      pushRetry: { organizations: 1, tried: 1, cleared: 1 },
      watch: { raised: 0, resolved: 0 },
      salePush: { orders: 2, sent: 1 },
      offlineAlerts: { organizations: 1, sent: 1 },
    });
    // Vakten körs i varje tick: den larmar om jobben som bara går en gång per dygn.
    expect(watch).toHaveBeenCalledTimes(1);
    // Offlinelarmet utvärderas direkt efter synken för de synkade organisationerna.
    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0]?.[1]).toEqual(["org-1"]);
  });

  it("offlinelarmet utvärderas även när orderna i en källa misslyckades (läget är sparat)", async () => {
    process.env.CRON_SECRET = SECRET;
    const ok: Record<string, unknown> = (await sync()).sources[0]!;
    sync.mockResolvedValueOnce({
      sources: [
        { ...ok, dataSourceId: "ds-2", organizationId: "org-2", ok: false, message: "stopp" },
        { ...ok, dataSourceId: "ds-3", organizationId: "org-3", skipped: "paused" },
      ],
    } as never);
    await GET(req(`Bearer ${SECRET}`));
    expect(offline.mock.calls[0]?.[1]).toEqual(["org-2"]);
  });

  it("slut i automat: bara organisationer där ett fack just blev tomt utvärderas för lagret", async () => {
    process.env.CRON_SECRET = SECRET;
    const ok: Record<string, unknown> = (await sync()).sources[0]!;
    await GET(req(`Bearer ${SECRET}`));
    // Inget nytt slut: ingen extra utvärdering för lagret.
    expect((offline.mock.calls[0]?.[2] as { stockOrgIds: string[] }).stockOrgIds).toEqual([]);
    offline.mockClear();
    sync.mockResolvedValueOnce({
      sources: [
        { ...ok, dataSourceId: "ds-2", organizationId: "org-2", stockDropped: ["m-1"] },
        { ...ok, dataSourceId: "ds-3", organizationId: "org-3", stockDropped: [] },
        { ...ok, dataSourceId: "ds-4", organizationId: "org-4", alertCheckDue: true },
      ],
    } as never);
    await GET(req(`Bearer ${SECRET}`));
    expect((offline.mock.calls[0]?.[2] as { stockOrgIds: string[] }).stockOrgIds).toEqual([
      "org-2",
      "org-4",
    ]);
  });

  it("ett fel i kampanjerna stoppar inte synkens svar", async () => {
    process.env.CRON_SECRET = SECRET;
    campaigns.mockRejectedValueOnce(new Error("nere"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).campaigns).toBeNull();
  });

  it("försäljningsnotisen körs efter synken, och ett fel i den stoppar inte synkens svar", async () => {
    process.env.CRON_SECRET = SECRET;
    salePush.mockRejectedValueOnce(new Error("push-tjänsten kastade"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.salePush).toBeNull();
    expect(body.sources[0].ok).toBe(true);
    // Efter synken (orderna är sparade), och resten av körningen går som vanligt.
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(salePush.mock.invocationCallOrder[0]!);
    expect(campaigns).toHaveBeenCalledTimes(1);
  });

  it("försäljningsnotisen före kampanjerna, med en tidsgräns inom cronens minut", async () => {
    process.env.CRON_SECRET = SECRET;
    const before = Date.now();
    await GET(req(`Bearer ${SECRET}`));
    // Notiserna först: kampanjerna (Awish) får det som är kvar och tas annars nästa körning.
    expect(salePush.mock.invocationCallOrder[0]).toBeLessThan(
      campaigns.mock.invocationCallOrder[0]!,
    );
    const { deadline } = salePush.mock.calls[0]![1] as { deadline: number };
    expect(deadline).toBeGreaterThan(before);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 12_000);
    // Kampanjerna har en tidsgräns före cronens minut (inget anrop till Awish efter den).
    const { deadlineAt } = (campaigns.mock.calls[0] as unknown as [{ deadlineAt: number }])[0];
    expect(deadlineAt).toBeGreaterThan(before);
    expect(deadlineAt).toBeLessThanOrEqual(before + 57_000 + 1_000);
  });

  it("påfyllningar som inte nådde Awish försöks igen direkt efter synken, med egen tidsgräns", async () => {
    process.env.CRON_SECRET = SECRET;
    const before = Date.now();
    await GET(req(`Bearer ${SECRET}`));
    expect(pushRetry).toHaveBeenCalledTimes(1);
    // Före vakten (en sändning som just gick fram larmar inte) och före kampanjerna och
    // notiserna, så att de alltid får tid när Open API är långsamt.
    expect(pushRetry.mock.invocationCallOrder.at(-1)).toBeLessThan(
      watch.mock.invocationCallOrder.at(-1)!,
    );
    expect(pushRetry.mock.invocationCallOrder[0]).toBeLessThan(
      campaigns.mock.invocationCallOrder[0]!,
    );
    expect(pushRetry.mock.invocationCallOrder[0]).toBeLessThan(
      salePush.mock.invocationCallOrder[0]!,
    );
    const { deadline } = pushRetry.mock.calls[0]![1];
    expect(deadline).toBeGreaterThan(before);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 50_000);
  });

  it("ett fel i de nya försöken stoppar inte synkens svar", async () => {
    process.env.CRON_SECRET = SECRET;
    pushRetry.mockRejectedValueOnce(new Error("nere"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).pushRetry).toBeNull();
  });
});
