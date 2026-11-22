import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { formatInt } from "@/lib/format";
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

import { ReportChrome } from "../../_components/report-chrome";
import { EmailRenderer, type EmailJob } from "./email-renderer";
import "./epost.css";

export const metadata: Metadata = { title: "Mejl" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** Rapporttypen i bestämd form, i rubriken. */
const DEFINITE = {
  butik: "butiksrapporten",
  bokforing: "bokföringsunderlaget",
  delagare: "delägarrapporten",
} as const;

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
  // En äldre butiksrapport får en ny PDF vid varje hämtning: den sparade filen gäller inte.
  if (report.storagePath && !report.legacy) {
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
    <ReportChrome
      back={{ href: `/rapport/${report.id}`, label: TYPE_LABEL[report.snapshot.type] }}
      crumb="Mejl"
      // Inga knappar: mejlen skrivs inte ut härifrån.
      actions={<></>}
    >
      <div className="ep-page mx-auto flex w-full max-w-[760px] min-w-0 flex-col gap-[14px] max-[900px]:gap-3">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="text-v2-xl font-[650] text-balance text-v2-ink">
            {jobs.length === 0
              ? "Inget mejl att visa."
              : `${formatInt(jobs.length)} mejl med ${DEFINITE[report.snapshot.type]}.`}
          </h1>
          {jobs.length === 0 ? null : (
            <p className="text-v2-sm text-v2-mute">Så som mottagarna får dem.</p>
          )}
        </header>
        {jobs.length === 0 ? (
          <Card>
            <Empty
              title="Ingen aktiv mottagare kan få den här rapporten."
              action={
                <ButtonLink href="/rapporter?vy=mottagare" variant="act" touch>
                  Lägg till mottagare
                </ButtonLink>
              }
            />
          </Card>
        ) : (
          <EmailRenderer jobs={jobs} />
        )}
      </div>
    </ReportChrome>
  );
}
