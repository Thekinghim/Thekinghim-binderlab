import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECIPIENT_KINDS } from "@/emails/report-content";
import { renderReportEmail, type RenderedEmail } from "@/emails/report-email";
import { sampleReportEmails } from "@/emails/sample";

/*
 * Förhandsvisningen på /design och /design/epost läser färdigrenderade
 * exempelmejl från rendered-samples.json. Next tillåter inte
 * react-dom/server i serverkomponenter, och att rendera i webbläsaren
 * skulle lägga react-dom/server i klientpaketet för /design.
 *
 * Testet kontrollerar att filen stämmer med mallen. Efter en ändring i
 * src/emails/ skrivs filen om med:
 *
 *   UPDATE_EMAIL_SAMPLES=1 npx vitest run src/app/design/epost
 */

const FILE = fileURLToPath(new URL("./rendered-samples.json", import.meta.url));

function renderAll(): Record<string, RenderedEmail> {
  return Object.fromEntries(
    RECIPIENT_KINDS.map(({ value }) => [value, renderReportEmail(sampleReportEmails[value])]),
  );
}

describe("rendered-samples.json", () => {
  const fresh = renderAll();

  if (process.env.UPDATE_EMAIL_SAMPLES === "1") {
    writeFileSync(FILE, `${JSON.stringify(fresh, null, 2)}\n`);
  }

  it("finns", () => {
    expect(existsSync(FILE)).toBe(true);
  });

  it("stämmer med mallen (kör med UPDATE_EMAIL_SAMPLES=1 för att skriva om)", () => {
    const stored = JSON.parse(readFileSync(FILE, "utf8")) as unknown;
    expect(stored).toEqual(fresh);
  });
});
