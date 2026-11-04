import { describe, expect, it, vi } from "vitest";

// "PDF" på Rapporter gav 500 "Filen kunde inte skapas." när Chromium inte startade.
vi.mock("server-only", () => ({}));
vi.mock("@/server/reports/runtime", () => ({
  currentReportViewer: async () => ({}),
  renderReportPdf: async () => new Uint8Array(),
}));
vi.mock("@/server/reports/storage", () => ({ userReportStore: async () => ({}) }));
vi.mock("@/server/reports/service", async () => {
  const { PdfError } = await import("@/server/pdf/render");
  return {
    ReportError: class extends Error {},
    getReportFor: async () => ({}),
    ensurePdfFor: async () => {
      throw new PdfError("PDF kunde inte skapas: Failed to launch the browser process");
    },
  };
});

const { GET } = await import("./route");

describe("/rapport/{id}/fil/pdf", () => {
  it("skickar till utskriftssidan när PDF:en inte kan skapas", async () => {
    const id = "a4aac6f6-3e26-4bbc-a3a9-9da5319a8a3a";
    const res = await GET(new Request(`https://x.se/rapport/${id}/fil/pdf`), {
      params: Promise.resolve({ id, typ: "pdf" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://x.se/rapport/${id}?utskrift=1`);
  });
});
