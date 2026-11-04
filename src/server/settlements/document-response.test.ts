import { describe, expect, it } from "vitest";

import { settlementDocumentResponse } from "./document-response";

const doc = { html: "<!doctype html><p>Avräkning</p>", fileName: "avrakning-x-2026-10.pdf" };

describe("avräkningens dokument", () => {
  it("PDF när utskriften fungerar", async () => {
    const res = await settlementDocumentResponse(doc, async () => new Uint8Array([37, 80]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("HTML att skriva ut när PDF-utskriften kastar (inte ett tomt 500)", async () => {
    const res = await settlementDocumentResponse(doc, async () => {
      throw new Error("Failed to launch the browser process");
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Avräkning");
  });

  it("HTML när PDF inte är inställt", async () => {
    const res = await settlementDocumentResponse(doc, null);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
