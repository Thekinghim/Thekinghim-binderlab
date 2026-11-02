/**
 * Kopplingen mellan rapporttjänsten och Next: den inloggade (Viewer), PDF via headless
 * Chromium med användarens cookies, lagring, e-post och länkar. Används av server
 * actions och route handlers under /rapporter och /rapport.
 */

import "server-only";

import { headers } from "next/headers";

import { getServerEnv } from "@/lib/env";
import { nextCookieJar } from "@/server/auth/next-cookies";
import { getMailer, mailerStatus } from "@/server/mail/report-mailer";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";
import { resolveAppBaseUrl } from "@/server/request-info";
import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";

import type { SendDeps, Viewer } from "./service";
import { reportStorageStatus, userReportStore } from "./storage";

/** Den inloggade och den aktiva organisationen. Kastar om användaren saknar organisation. */
export async function currentReportViewer(): Promise<Viewer> {
  const user = await requireUser();
  const organization = await getActiveOrganization();
  if (!organization) throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  return { user, organization };
}

/** Appens adress (för länkar i mejl och för Chromium). */
export async function appBaseUrl(): Promise<string> {
  return resolveAppBaseUrl(getServerEnv(), await headers());
}

/**
 * Skriver ut /rapport/[id] till PDF med den inloggades cookies. `REPORT_RENDER_URL`
 * kan peka Chromium på en intern adress (t.ex. http://127.0.0.1:3000) när den publika
 * adressen inte nås inifrån servern.
 */
export async function renderReportPdf(reportId: string): Promise<Uint8Array> {
  const renderer = getPdfRenderer();
  const jar = await nextCookieJar();
  const base = (process.env.REPORT_RENDER_URL?.trim() || (await appBaseUrl())).replace(/\/+$/, "");
  return renderer.render({
    url: `${base}/rapport/${encodeURIComponent(reportId)}?utskrift=1`,
    cookies: jar.getAll(),
  });
}

/**
 * Renderar rapportmejlen i headless Chromium (/rapport/[id]/epost), där mallen i
 * src/emails kan köras. Returnerar HTML per mottagare.
 */
export async function renderReportEmails(
  reportId: string,
  recipientIds: readonly string[],
  followText: string | null,
): Promise<Record<string, { html: string }>> {
  const renderer = getPdfRenderer();
  const jar = await nextCookieJar();
  const base = (process.env.REPORT_RENDER_URL?.trim() || (await appBaseUrl())).replace(/\/+$/, "");
  const q = new URLSearchParams({ till: recipientIds.join(",") });
  if (followText) q.set("text", followText);
  return renderer.extract<Record<string, { html: string }>>(
    {
      url: `${base}/rapport/${encodeURIComponent(reportId)}/epost?${q.toString()}`,
      cookies: jar.getAll(),
    },
    "__BL_EMAILS__",
  );
}

/** Allt utskicket behöver i den här förfrågan. */
export async function sendDeps(): Promise<SendDeps> {
  const base = await appBaseUrl();
  return {
    mailer: getMailer(),
    store: await userReportStore(),
    render: renderReportPdf,
    renderEmails: renderReportEmails,
    reportUrl: (id) => `${base}/rapport/${id}`,
  };
}

/** Läget för de externa tjänsterna, för en ärlig rad i UI:t. Kastar aldrig. */
export function serviceStatus() {
  return {
    mail: mailerStatus(),
    pdf: pdfStatus(),
    storage: reportStorageStatus(),
  };
}
