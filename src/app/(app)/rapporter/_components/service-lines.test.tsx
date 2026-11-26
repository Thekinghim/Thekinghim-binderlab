import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ServiceLines } from "./service-lines";

const status = {
  mail: { kind: "outbox" },
  pdf: { configured: false, missing: ["PDF_BROWSER_URL"] },
  storage: { kind: "local", configured: true, missing: [] },
} as unknown as Parameters<typeof ServiceLines>[0]["status"];

describe("ServiceLines (Rapporter)", () => {
  it("ägaren ser inga namn på miljövariabler", () => {
    const html = renderToStaticMarkup(<ServiceLines status={status} showSettings={false} />);
    expect(html).toContain("PDF kan inte skapas här");
    expect(html).not.toContain("PDF_BROWSER_URL");
    expect(html).not.toContain("RESEND_API_KEY");
  });

  it("under utveckling står namnen kvar", () => {
    const html = renderToStaticMarkup(<ServiceLines status={status} showSettings />);
    expect(html).toContain("PDF_BROWSER_URL");
  });
});
