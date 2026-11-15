import { beforeEach, describe, expect, it, vi } from "vitest";

// Butikens PDF: en äldre rapport (utan sparat val) har en sparad fil med den gamla mallen,
// med titlar och service. Den får inte lämnas ut när rapporten visas kort.
const ID = "a4aac6f6-3e26-4bbc-a3a9-9da5319a8a3a";
const OLD_PDF = new TextEncoder().encode("%PDF gamla mallen");

let report: unknown;
const read = vi.fn(async () => OLD_PDF);

vi.mock("server-only", () => ({}));
vi.mock("@/server/portal/session", () => ({ getPortalContext: async () => ({}) }));
vi.mock("@/server/portal/load", () => ({
  loadPortalReport: async () => ({
    reportId: ID,
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    generatedAt: "2026-11-02T06:00:00.000Z",
    storagePath: `org/2026-10/${ID}.pdf`,
    report,
  }),
}));
vi.mock("@/server/reports/storage", () => ({
  reportStorageStatus: () => ({ kind: "local", configured: true, missing: [] }),
  userReportStore: async () => ({ get: read }),
}));

const { GET } = await import("./route");

const get = () =>
  GET(new Request(`https://x.se/portal/rapporter/${ID}/pdf`), {
    params: Promise.resolve({ id: ID }),
  });

beforeEach(() => read.mockClear());

describe("/portal/rapporter/{id}/pdf", () => {
  it("äldre rapport utan sparat val: den sparade PDF:en lämnas inte ut, butiken får sidan", async () => {
    report = { kind: "store", topTitles: [{ name: "30th Celebration" }] };
    const res = await get();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://x.se/portal/rapporter/${ID}`);
    expect(read).not.toHaveBeenCalled();
    expect(await res.text()).toBe("");
  });

  it("rapport med sparat val: den sparade PDF:en lämnas ut", async () => {
    for (const details of [false, true]) {
      report = { kind: "store", details };
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(OLD_PDF);
    }
    expect(read).toHaveBeenCalledTimes(2);
  });
});
