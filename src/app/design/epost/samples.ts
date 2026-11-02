import "client-only";
import { renderReportEmail, type RenderedEmail } from "@/emails/report-email";
import type { RecipientKind } from "@/emails/report-content";
import { sampleReportEmails } from "@/emails/sample";

/*
 * Exempelmejlen renderade till HTML en gång, när modulen laddas.
 *
 * Next tillåter inte react-dom/server i serverkomponenter eller
 * route handlers, så förhandsvisningen renderar i klientlagret (SSR och
 * webbläsare). I produktion körs renderReportEmail i utskicksjobbet,
 * som är vanlig Node.
 */
export const renderedSamples: Record<RecipientKind, RenderedEmail> = {
  butik: renderReportEmail(sampleReportEmails.butik),
  bokforing: renderReportEmail(sampleReportEmails.bokforing),
  delagare: renderReportEmail(sampleReportEmails.delagare),
};

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
