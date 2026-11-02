"use client";

import Link from "next/link";
import { useState } from "react";
import { SectionHeader } from "@/components/ui/section-header";
import { Segmented } from "@/components/ui/segmented";
import { RECIPIENT_KINDS, type RecipientKind } from "@/emails/report-content";
import { sampleReportEmails } from "@/emails/sample";
import { formatInt } from "@/lib/format";
import { EmailFrame } from "../epost/email-frame";
import { InboxRow } from "../epost/inbox-row";
import { recipientNotes } from "../epost/recipients";
import { checkEmailHtml, renderedSamples } from "../epost/samples";

const KINDS = RECIPIENT_KINDS.map((k) => k.value);
const largest = Math.max(...KINDS.map((k) => checkEmailHtml(renderedSamples[k].html).bytes));

/** Förhandsvisning av rapportmejlet: inkorgsrad, skrivbord 600 px och mobil 375 px. */
export function EmailSection({ index }: { index: number }) {
  const [kind, setKind] = useState<RecipientKind>("delagare");
  const email = renderedSamples[kind];
  const notes = recipientNotes[kind];

  return (
    <section id="e-post" aria-labelledby="e-post-title" className="border-t border-line py-16 md:py-20">
      <SectionHeader
        index={index}
        id="e-post-title"
        eyebrow="E-post"
        title="Rapportmejl i tabellayout."
        aside={`Tre mottagare, en mall, högst ${formatInt(largest / 1000)} kB utan klasser eller SVG.`}
        actions={
          <Link
            href={`/design/epost?typ=${kind}`}
            className="label inline-flex h-7 items-center rounded-sm border border-line-strong px-2.5 text-muted transition-colors duration-[120ms] hover:border-line-control hover:text-fg"
          >
            Hela förhandsvisningen
          </Link>
        }
      />

      <div className="mt-10 flex flex-col gap-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <Segmented options={RECIPIENT_KINDS} value={kind} onChange={setKind} label="Mottagare" />
          <p className="label text-subtle">
            600 px <span className="text-faint">·</span> tabellayout{" "}
            <span className="text-faint">·</span> inline-stilar{" "}
            <span className="text-faint">·</span> text/plain-version
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,600px)_minmax(0,1fr)] lg:gap-8">
          <InboxRow props={sampleReportEmails[kind]} subject={email.subject} preheader={email.preheader} />
          <dl className="grid content-start gap-x-6 gap-y-3 text-sm sm:grid-cols-[112px_minmax(0,1fr)] lg:pt-6">
            <dt className="label pt-0.5 text-subtle">Mottagare</dt>
            <dd className="text-fg">{notes.who}</dd>
            <dt className="label pt-0.5 text-subtle">Innehåll</dt>
            <dd className="text-muted">{notes.gets}</dd>
            <dt className="label pt-0.5 text-subtle">Utelämnas</dt>
            <dd className="text-muted">{notes.omits}</dd>
          </dl>
        </div>

        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,600px)_minmax(0,377px)]">
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
    </section>
  );
}

