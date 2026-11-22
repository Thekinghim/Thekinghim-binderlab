"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { Card, CardBody } from "@/components/v2/card";
import { renderReportEmail, type ReportEmailProps } from "@/emails/report-email";
import { cleanEmailHtml } from "@/server/reports/email-cleanup";

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
    () =>
      inBrowser
        ? jobs.map((job) => {
            const email = renderReportEmail(revive(job.props));
            // Rader utan underlag ("–") tas bort, samma regler som textdelen på servern.
            return { job, ...email, html: cleanEmailHtml(email.html, job.props.recipientKind) };
          })
        : null,
    [inBrowser, jobs],
  );

  useEffect(() => {
    if (!rendered) return;
    window.__BL_EMAILS__ = Object.fromEntries(
      rendered.map((o) => [o.job.recipientId, { html: o.html }]),
    );
  }, [rendered]);

  if (!rendered) {
    return (
      <Card>
        <p role="status" className="v2-empty">
          Mejlen renderas …
        </p>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-[14px] max-[900px]:gap-3">
      {rendered.map((r) => (
        <Card
          key={r.job.recipientId}
          as="article"
          title={
            <>
              <span className="truncate">Till {r.job.name}</span>
              <span className="truncate text-v2-sm font-[450] text-v2-mute">{r.job.email}</span>
            </>
          }
        >
          <CardBody className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-v2-md font-[650] text-balance text-v2-ink">{r.subject}</h3>
              <p className="text-v2-sm text-v2-mute">{r.preheader}</p>
            </div>
            <iframe
              title={`Mejlet till ${r.job.name}`}
              srcDoc={r.html}
              sandbox=""
              className="bg-white h-[1400px] w-full rounded-v2 border border-v2-line"
            />
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
