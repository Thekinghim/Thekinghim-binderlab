/**
 * Renderar rapportmejlet (src/emails, react-dom/server) från serverkod som ligger i
 * Server Components-grafen (server actions, sidor). Next tillåter inte en statisk import
 * av react-dom/server där, så mallen laddas först när ett mejl ska renderas.
 */

import "server-only";

import type { RenderedEmail, ReportEmailProps } from "@/emails/report-email";

export async function renderReportEmailLazy(props: ReportEmailProps): Promise<RenderedEmail> {
  const { renderReportEmail } = await import("@/emails/report-email");
  return renderReportEmail(props);
}
