"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { RECIPIENT_KINDS, type RecipientKind } from "@/emails/report-content";
import { sampleReportEmails } from "@/emails/sample";
import { formatInt } from "@/lib/format";
import { EmailFrame } from "../epost/email-frame";
import { InboxRow } from "../epost/inbox-row";
import { recipientNotes } from "../epost/recipients";
import { checkEmailHtml, renderedSamples } from "../epost/samples";
import { SpecSection } from "./section";

const KINDS = RECIPIENT_KINDS.map((k) => k.value);
const largest = Math.max(...KINDS.map((k) => checkEmailHtml(renderedSamples[k].html).bytes));

/** Förhandsvisning av rapportmejlet: inkorgsrad, skrivbord 600 px och mobil 375 px. */
export function EmailSection({ index }: { index: number }) {
  const [kind, setKind] = useState<RecipientKind>("delagare");
  const email = renderedSamples[kind];
  const notes = recipientNotes[kind];

  return (
    <SpecSection
      id="e-post"
      index={index}
      eyebrow="E-post"
      title="Ett mejl i tabellayout, tre mottagare."
      aside={`Högst ${formatInt(largest / 1000)} kB, utan klasser och SVG.`}
      actions={
        <Link
          href={`/design/epost?typ=${kind}`}
          className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line-strong bg-surface px-2.5 text-sm font-medium text-fg transition-[background-color,border-color] duration-[120ms] ease-instrument hover:border-line-control hover:bg-hover"
        >
          Hela förhandsvisningen
          <Icon name="chevronRight" className="-mr-0.5 text-subtle" />
        </Link>
      }
    >
      <div className="flex flex-col gap-6 lg:col-span-12">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <Segmented options={RECIPIENT_KINDS} value={kind} onChange={setKind} label="Mottagare" />
          <p className="label text-subtle">
            600 px <span className="text-faint">·</span> tabellayout{" "}
            <span className="text-faint">·</span> inline-stilar{" "}
            <span className="text-faint">·</span> text/plain-version
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,602px)_minmax(0,1fr)] lg:gap-8">
          <InboxRow
            props={sampleReportEmails[kind]}
            subject={email.subject}
            preheader={email.preheader}
          />
          <dl className="grid content-start gap-x-6 gap-y-3 text-sm sm:grid-cols-[112px_minmax(0,1fr)] lg:pt-6">
            <dt className="label pt-0.5 text-subtle">Mottagare</dt>
            <dd className="text-fg">{notes.who}</dd>
            <dt className="label pt-0.5 text-subtle">Innehåll</dt>
            <dd className="text-muted">{notes.gets}</dd>
            <dt className="label pt-0.5 text-subtle">Utelämnas</dt>
            <dd className="text-muted">{notes.omits}</dd>
          </dl>
        </div>

        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,602px)_minmax(0,377px)]">
          <EmailFrame
            html={email.html}
            width={600}
            height={760}
            label="Skrivbord · 600 px"
            title={`Rapportmejl till ${notes.who.toLocaleLowerCase("sv-SE")}, 600 px`}
          />
          <EmailFrame
            html={email.html}
            width={375}
            height={760}
            label="Mobil · 375 px"
            title={`Rapportmejl till ${notes.who.toLocaleLowerCase("sv-SE")}, 375 px`}
          />
        </div>
      </div>
    </SpecSection>
  );
}
