import type { RenderedEmail } from "@/emails/report-email";
import type { RecipientKind } from "@/emails/report-content";
import rendered from "./rendered-samples.json";

/*
 * Exempelmejlen som färdig HTML och text. Filen skrivs av
 * rendered-samples.test.ts från src/emails/sample.ts, så att varken
 * react-dom/server eller själva mallen hamnar i klientpaketet. Testet
 * fallerar om filen inte längre stämmer med mallen.
 */
export const renderedSamples: Record<RecipientKind, RenderedEmail> = rendered;

export type EmailChecks = {
  bytes: number;
  classAttributes: number;
  svgElements: number;
  externalCss: number;
  images: number;
};

/** Kontroller av den färdiga strängen, visas på förhandsvisningssidan. */
export function checkEmailHtml(html: string): EmailChecks {
  return {
    bytes: new TextEncoder().encode(html).length,
    classAttributes: (html.match(/\sclass=/g) ?? []).length,
    svgElements: (html.match(/<svg/g) ?? []).length,
    externalCss: (html.match(/<link[^>]+stylesheet/g) ?? []).length,
    images: (html.match(/<img/g) ?? []).length,
  };
}
