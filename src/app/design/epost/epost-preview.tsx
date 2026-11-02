"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/frame";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { RECIPIENT_KINDS, type RecipientKind } from "@/emails/report-content";
import { sampleReportEmails } from "@/emails/sample";
import { cn } from "@/lib/cn";
import { formatDecimal, formatInt, NBSP } from "@/lib/format";
import { EmailFrame } from "./email-frame";
import { InboxRow } from "./inbox-row";
import { recipientNotes } from "./recipients";
import { checkEmailHtml, renderedSamples } from "./samples";

/** Gmail kortar mejl över 102 kB och döljer resten bakom en länk. */
const SIZE_LIMIT = 100_000;

function kb(bytes: number): string {
  return `${formatDecimal(bytes / 1000)}${NBSP}kB`;
}

function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function EpostPreview({ initialKind }: { initialKind: RecipientKind }) {
  const router = useRouter();
  const [kind, setKind] = useState(initialKind);
  const email = renderedSamples[kind];
  const notes = recipientNotes[kind];
  const checks = checkEmailHtml(email.html);
  const sections = (email.text.match(/^\d{2} \/ /gm) ?? []).length;
  const lines = email.text.trimEnd().split("\n").length;

  const select = (next: RecipientKind) => {
    setKind(next);
    router.replace(`/design/epost?typ=${next}`, { scroll: false });
  };

  const rows: Array<{ label: string; value: string; ok: boolean; rule: string }> = [
    {
      label: "Storlek",
      value: kb(checks.bytes),
      ok: checks.bytes < SIZE_LIMIT,
      rule: "Under 100 kB. Gmail kortar mejl över 102 kB.",
    },
    {
      label: "class-attribut",
      value: formatInt(checks.classAttributes),
      ok: checks.classAttributes === 0,
      rule: "Alla stilar inline.",
    },
    {
      label: "<svg>",
      value: formatInt(checks.svgElements),
      ok: checks.svgElements === 0,
      rule: "Gmail och Outlook visar inte SVG. Symbol och staplar är tabellceller.",
    },
    {
      label: "Externa stilmallar",
      value: formatInt(checks.externalCss),
      ok: checks.externalCss === 0,
      rule: "Tas bort av de flesta klienter.",
    },
    {
      label: "Bilder",
      value: formatInt(checks.images),
      ok: checks.images === 0,
      rule: "Inget innehåll försvinner när bilder blockeras.",
    },
  ];

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-10 md:px-8 md:py-16">
      <nav aria-label="Plats" className="label flex items-center gap-2 text-subtle">
        <Link href="/design" className="hover:text-fg">
          Designsystem
        </Link>
        <span aria-hidden className="text-faint">
          /
        </span>
        <span aria-current="page" className="text-fg">
          E-post
        </span>
      </nav>

      <header className="mt-6 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <h1 className="max-w-3xl text-xl font-medium text-balance md:text-2xl">
          <span className="text-fg">Rapportmejl till {notes.who.toLocaleLowerCase("sv-SE")}.</span>{" "}
          <span className="text-subtle">
            {formatInt(sections)} sektioner på {kb(checks.bytes)}, textversion på {formatInt(lines)}{" "}
            rader.
          </span>
        </h1>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            iconLeft="download"
            onClick={() => download(`rapportmejl-${kind}.html`, "text/html", email.html)}
          >
            HTML
          </Button>
          <Button
            size="sm"
            iconLeft="download"
            onClick={() => download(`rapportmejl-${kind}.txt`, "text/plain", email.text)}
          >
            Text
          </Button>
        </div>
      </header>

      <div className="mt-10 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Segmented options={RECIPIENT_KINDS} value={kind} onChange={select} label="Mottagare" />
        <p className="label text-subtle">
          600 px{" "}
          <span aria-hidden className="text-faint">
            ·
          </span>{" "}
          tabellayout{" "}
          <span aria-hidden className="text-faint">
            ·
          </span>{" "}
          inline-stilar{" "}
          <span aria-hidden className="text-faint">
            ·
          </span>{" "}
          text/plain-version
        </p>
      </div>

      <InboxRow
        className="mt-6 max-w-[602px]"
        props={sampleReportEmails[kind]}
        subject={email.subject}
        preheader={email.preheader}
      />

      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,602px)_minmax(0,377px)]">
        <EmailFrame
          html={email.html}
          width={600}
          label="Skrivbord · 600 px"
          title={`Rapportmejl till ${notes.who.toLocaleLowerCase("sv-SE")}, 600 px`}
        />
        <EmailFrame
          html={email.html}
          width={375}
          label="Mobil · 375 px"
          title={`Rapportmejl till ${notes.who.toLocaleLowerCase("sv-SE")}, 375 px`}
        />
      </div>

      <div className="mt-12 grid items-start gap-6 lg:grid-cols-2">
        <Panel padded={false}>
          <PanelHeader label="Kontroller av HTML" meta={kind} className="px-4 pt-4 md:px-5" />
          <table className="mt-3 w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th scope="col">Kontroll</th>
                <th scope="col">Värde</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-line align-top">
                  <th scope="row" className="py-3 pr-3 pl-4 text-left font-normal md:pl-5">
                    <span className="block font-mono text-xs text-fg">{r.label}</span>
                    <span className="mt-0.5 block text-muted">{r.rule}</span>
                  </th>
                  <td className="tnum py-3 pr-3 text-right whitespace-nowrap text-fg">{r.value}</td>
                  <td className="py-3 pr-4 md:pr-5">
                    <span
                      className={cn(
                        "label inline-flex items-center gap-1.5",
                        r.ok ? "text-muted" : "text-signal-fg",
                      )}
                    >
                      <Icon name={r.ok ? "check" : "alert"} size={14} />
                      {r.ok ? "OK" : "Fel"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel padded={false}>
          <PanelHeader
            label="text/plain"
            meta={`${formatInt(lines)} rader`}
            className="px-4 pt-4 md:px-5"
          />
          <pre className="mt-3 max-h-[420px] overflow-auto border-t border-line px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap text-muted md:px-5">
            {email.text}
          </pre>
        </Panel>
      </div>

      <section aria-labelledby="alla-title" className="mt-16 border-t border-line pt-10">
        <h2 id="alla-title" className="text-lg font-medium">
          <span className="text-fg">Alla mottagare sida vid sida.</span>{" "}
          <span className="text-subtle">Samma struktur, olika innehåll.</span>
        </h2>
        <div className="mt-6 grid items-start gap-6 md:grid-cols-3">
          {RECIPIENT_KINDS.map((k) => (
            <div key={k.value} className="flex min-w-0 flex-col gap-3">
              <p className="text-sm">
                <span className="text-fg">{recipientNotes[k.value].who}.</span>{" "}
                <span className="text-muted">
                  Utelämnar: {recipientNotes[k.value].omits.toLocaleLowerCase("sv-SE")}
                </span>
              </p>
              <EmailFrame
                html={renderedSamples[k.value].html}
                width={600}
                label={k.label}
                title={`Rapportmejl till ${recipientNotes[k.value].who.toLocaleLowerCase("sv-SE")}`}
              />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
