import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const run = vi.fn(async (_deps: unknown) => ({
  organizations: [
    { id: "org-1", month: "2026-10", status: "created", version: 1, packageStatus: "final" },
  ],
}));
vi.mock("@/server/bokforing/stored", () => ({ runBokforingForAll: run }));
vi.mock("@/server/pdf/render", () => ({
  pdfStatus: () => ({ configured: false }),
  getPdfRenderer: () => ({ renderHtml: async () => new Uint8Array() }),
}));

const { GET } = await import("./route");

const SECRET = "en-lang-hemlighet-1234567890";
const req = (auth?: string) =>
  new Request("https://app.example.se/api/cron/bokforing", {
    headers: auth ? { authorization: auth } : {},
  });

describe("/api/cron/bokforing", () => {
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

  it("rätt hemlighet: tar fram paketen och svarar med status per organisation", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      organizations: [
        { id: "org-1", month: "2026-10", status: "created", version: 1, packageStatus: "final" },
      ],
    });
    expect(run).toHaveBeenCalledOnce();
  });
});
