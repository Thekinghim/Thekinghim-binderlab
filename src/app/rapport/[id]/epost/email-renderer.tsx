"use client";

import { useEffect, useState } from "react";

import { renderReportEmail, type ReportEmailProps } from "@/emails/report-email";

export interface EmailJob {
  readonly recipientId: string;
  readonly name: string;
  readonly email: string;
  readonly props: ReportEmailProps;
}

declare global {
  interface Window {
    __BL_EMAILS__?: Record<string, { html: string }>;
  }
}

/**
 * Renderar rapportmejlen med mallen i src/emails (react-dom/server, som Next inte låter
 * köras i Server Components). Servern öppnar sidan i headless Chromium och läser
 * resultatet ur `window.__BL_EMAILS__`; en människa ser samma mejl som förhandsvisning.
 */
export function EmailRenderer({ jobs }: { jobs: readonly EmailJob[] }) {
  const [rendered, setRendered] = useState<
    { job: EmailJob; subject: string; preheader: string; html: string }[] | null
  >(null);

  useEffect(() => {
    const out = jobs.map((job) => ({ job, ...renderReportEmail(job.props) }));
    window.__BL_EMAILS__ = Object.fromEntries(out.map((o) => [o.job.recipientId, { html: o.html }]));
    setRendered(out);
  }, [jobs]);

  if (!rendered) {
    return <p className="meta text-subtle">Mejlen renderas …</p>;
  }
  return (
    <div className="flex flex-col gap-10">
      {rendered.map((r) => (
        <article key={r.job.recipientId} className="flex min-w-0 flex-col gap-3">
          <header className="flex min-w-0 flex-col gap-1">
            <p className="label text-subtle">
              Till {r.job.name} · <span className="normal-case">{r.job.email}</span>
            </p>
            <h2 className="text-md text-balance text-fg">{r.subject}</h2>
            <p className="text-sm text-muted">{r.preheader}</p>
          </header>
          <iframe
            title={`Mejlet till ${r.job.name}`}
            srcDoc={r.html}
            sandbox=""
            className="h-[1400px] w-full max-w-[680px] rounded-md border border-line bg-white"
          />
        </article>
      ))}
    </div>
  );
}
