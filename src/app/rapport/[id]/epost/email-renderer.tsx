"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

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
const noop = () => () => {};

/**
 * Ett ogiltigt datum (saknat värde, visas som "–") blir null på vägen från servern.
 * Mallen vill ha Date, så det återställs här.
 */
function revive(props: ReportEmailProps): ReportEmailProps {
  if (props.recipientKind !== "butik") return props;
  const d = props.details;
  const missing = (v: Date | null) => v ?? new Date(Number.NaN);
  return {
    ...props,
    details: {
      ...d,
      nextVisit: missing(d.nextVisit as Date | null),
      refills: { ...d.refills, last: missing(d.refills.last as Date | null) },
    },
  };
}

export function EmailRenderer({ jobs }: { jobs: readonly EmailJob[] }) {
  // Bara i webbläsaren: mallen renderas inte i serverns förrendering.
  const inBrowser = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const rendered = useMemo(
    () => (inBrowser ? jobs.map((job) => ({ job, ...renderReportEmail(revive(job.props)) })) : null),
    [inBrowser, jobs],
  );

  useEffect(() => {
    if (!rendered) return;
    window.__BL_EMAILS__ = Object.fromEntries(
      rendered.map((o) => [o.job.recipientId, { html: o.html }]),
    );
  }, [rendered]);

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
            className="bg-white h-[1400px] w-full max-w-[680px] rounded-md border border-line"
          />
        </article>
      ))}
    </div>
  );
}
