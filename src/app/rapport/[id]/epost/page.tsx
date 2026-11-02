import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TYPE_LABEL } from "@/server/reports/kinds";
import { appBaseUrl, currentReportViewer, reportSender } from "@/server/reports/runtime";
import {
  eligibleRecipients,
  emailPropsFor,
  getReportFor,
  listRecipientsFor,
  mailAttachments,
  ReportError,
  type ReportDetail,
} from "@/server/reports/service";
import { userReportStore } from "@/server/reports/storage";
import { AuthorizationError } from "@/server/session";

import { EmailRenderer, type EmailJob } from "./email-renderer";

export const metadata: Metadata = { title: "Mejl" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * Rapportmejlen för en rapport, renderade med mallen i src/emails. Visar förhandsvisningen
 * för en människa och används av servern (headless Chromium) när mejlen skickas.
 * ?till=<id,id> väljer mottagare (standard: alla som kan få rapporten), ?text= följetexten.
 * Kräver inloggning och rollen ägare, admin eller läsare.
 */
export default async function EmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const viewer = await currentReportViewer().catch((error: unknown) => {
    if (error instanceof AuthorizationError) redirect("/");
    throw error;
  });
  let report: ReportDetail;
  try {
    report = await getReportFor(viewer, id);
  } catch (error) {
    if (error instanceof ReportError) notFound();
    if (error instanceof AuthorizationError) redirect("/");
    throw error;
  }
  const eligible = eligibleRecipients(report.snapshot, await listRecipientsFor(viewer));
  const wanted = one(sp.till)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const recipients = wanted.length > 0 ? eligible.filter((r) => wanted.includes(r.id)) : eligible;
  const followText = one(sp.text).slice(0, 1000).trim() || null;

  let pdfBytes: Uint8Array = new Uint8Array();
  if (report.storagePath) {
    try {
      pdfBytes = await (await userReportStore()).get(report.storagePath);
    } catch {
      pdfBytes = new Uint8Array();
    }
  }
  const attachments = await mailAttachments(report.snapshot, pdfBytes);
  const base = await appBaseUrl();
  const jobs: EmailJob[] = recipients.map((r) => ({
    recipientId: r.id,
    name: r.name,
    email: r.email,
    props: emailPropsFor(report, r, {
      followText,
      reportUrl: `${base}/rapport/${report.id}`,
      sender: reportSender(viewer.organization.name),
      attachments: attachments.map((a) =>
        a.filename.endsWith(".pdf") && a.content.byteLength === 0
          ? { filename: a.filename, content: { byteLength: Number.NaN } }
          : a,
      ),
    }),
  }));

  return (
    <div className="min-h-dvh bg-bg">
      <div className="sticky top-0 z-10 border-b border-line bg-bg">
        <div className="mx-auto flex h-12 max-w-[1280px] items-center gap-3 px-4 md:px-8">
          <nav aria-label="Sökväg" className="label flex min-w-0 items-center gap-2 text-subtle">
            <Link
              href={`/rapport/${report.id}`}
              className="shrink-0 rounded-xs text-muted transition-colors duration-fast ease-instrument hover:text-fg"
            >
              {TYPE_LABEL[report.snapshot.type]}
            </Link>
            <span aria-hidden className="text-faint">
              /
            </span>
            <span className="truncate">Mejl</span>
          </nav>
        </div>
      </div>
      <main className="mx-auto max-w-[1280px] px-4 py-8 md:px-8">
        {jobs.length === 0 ? (
          <p className="text-base text-muted">
            Ingen aktiv mottagare kan få den här rapporten. Lägg till en under Rapporter →
            Mottagare.
          </p>
        ) : (
          <EmailRenderer jobs={jobs} />
        )}
      </main>
    </div>
  );
}
