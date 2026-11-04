import { describe, expect, it } from "vitest";

import { getPdfRenderer, LocalPdfRenderer, pdfStatus, PdfError } from "./render";

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

describe("fel från Chromium", () => {
  // Utan detta blev en Chromium som inte startar (t.ex. på Vercel) ett vanligt Error och
  // routerna svarade 500 i stället för att visa HTML-utskriften.
  it("en Chromium som inte startar ger PdfError (med orsaken), inte ett vanligt fel", async () => {
    const renderer = new LocalPdfRenderer("/finns/inte/chrome");
    const error = await renderer.renderHtml("<p>x</p>").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfError);
    expect((error as PdfError).cause).toBeDefined();
    const page = await renderer
      .render({ url: "http://127.0.0.1:9/rapport/x", cookies: [] })
      .catch((e: unknown) => e);
    expect(page).toBeInstanceOf(PdfError);
  });
});
