import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ getServiceDb: () => ({}) }));
const run = vi.fn(async () => ({ organizations: [{ id: "org-1", status: "ok", accepted: 3 }] }));
vi.mock("@/server/assistant/advisor/service", () => ({ runAdvisorForAll: run }));

const { GET } = await import("./route");

const SECRET = "en-lang-hemlighet-1234567890";
const req = (auth?: string) =>
  new Request("https://app.example.se/api/cron/ai", {
    headers: auth ? { authorization: auth } : {},
  });

describe("/api/cron/ai", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    run.mockClear();
  });

  it("utan CRON_SECRET: 503 och ingen körning", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("fel hemlighet: 401", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req("Bearer fel"));
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rätt hemlighet: kör rådgivaren och svarar med status per organisation", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      organizations: [{ id: "org-1", status: "ok", accepted: 3 }],
    });
    expect(run).toHaveBeenCalledOnce();
  });
});
