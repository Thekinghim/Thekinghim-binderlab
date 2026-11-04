import { describe, expect, it, vi } from "vitest";

// Avräkningens "PDF"-länk gav 500 med tom kropp på Vercel när Chromium inte startade.
vi.mock("server-only", () => ({}));
vi.mock("@/server/data/core", () => ({ requireViewer: async () => ({}) }));
vi.mock("@/server/settlements/service", () => ({
  SettlementError: class extends Error {},
  settlementDocumentFor: async () => ({
    html: "<!doctype html><title>Avräkning Sega gubben</title><p>8 193,11 kr</p>",
    fileName: "avrakning-sega-gubben-2026-10.pdf",
  }),
}));
vi.mock("@/server/pdf/render", () => ({
  pdfStatus: () => ({ configured: true }),
  getPdfRenderer: () => ({
    renderHtml: async () => {
      throw new Error("Failed to launch the browser process");
    },
  }),
}));

const { GET } = await import("./route");

describe("/butiker/avrakning/{id}", () => {
  it("visar avräkningen som HTML när PDF-utskriften misslyckas", async () => {
    const res = await GET(new Request("https://x.se/butiker/avrakning/1"), {
      params: Promise.resolve({ id: "c5cf4c60-cfb3-4c91-942d-a0eaa7c26c79" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("8 193,11 kr");
  });
});
