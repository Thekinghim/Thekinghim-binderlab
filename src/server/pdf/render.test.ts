import { describe, expect, it } from "vitest";

import { getPdfRenderer, pdfStatus, PdfError } from "./render";

describe("pdfStatus", () => {
  it("sparticuz på Vercel, lokal Chromium annars, off stänger av", () => {
    expect(pdfStatus({ VERCEL: "1" }).kind).toBe("sparticuz");
    expect(pdfStatus({ PDF_RENDERER: "off" })).toMatchObject({ kind: "off", configured: false });
    expect(
      pdfStatus({ PDF_RENDERER: "local", PDF_CHROMIUM_PATH: "/finns/inte/chrome" }),
    ).toMatchObject({ kind: "local", configured: false });
    expect(() => getPdfRenderer({ PDF_RENDERER: "off" })).toThrow(PdfError);
    expect(pdfStatus({ PDF_RENDERER: "fel" }).configured).toBe(false);
  });
});
