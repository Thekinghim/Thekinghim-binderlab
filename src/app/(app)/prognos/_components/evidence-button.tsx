"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

import type { EvidenceView } from "../_lib/evidence";

/**
 * "Underlag": öppnar en dialog med regeln, perioden, talen och länkar till orderna och
 * lagret som siffran bygger på. Varje siffra på sidan har en sådan knapp i sin rad.
 */
export function EvidenceButton({
  evidence,
  title,
  text,
  label = "Underlag",
}: {
  evidence: EvidenceView;
  /** Dialogens rubrik, t.ex. titelns namn. */
  title: string;
  /** Resultatet i en mening (från @/analytics). */
  text?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${label}: ${title}`}
      >
        {label}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} eyebrow="Underlag">
        <EvidenceBody evidence={evidence} text={text} />
      </Modal>
    </>
  );
}

export function EvidenceBody({ evidence, text }: { evidence: EvidenceView; text?: string }) {
  return (
    <div className="flex flex-col gap-6">
      {text ? <p className="text-md text-fg">{text}</p> : null}
      <div className="flex flex-col gap-2">
        <p className="label text-subtle">Regel</p>
        <p className="text-sm text-muted">{evidence.rule}</p>
      </div>
      {evidence.period ? (
        <div className="flex items-baseline justify-between gap-4 border-t border-line pt-3">
          <p className="label text-subtle">Period</p>
          <p className="meta tnum text-fg">{evidence.period}</p>
        </div>
      ) : null}
      {evidence.figures.length > 0 ? (
        <dl className="flex flex-col">
          {evidence.figures.map((f) => (
            <div
              key={f.key}
              className="flex items-baseline justify-between gap-4 border-t border-line py-1.5 last:border-b"
            >
              <dt className="text-sm text-muted">{f.label}</dt>
              <dd className="tnum text-right text-sm text-fg">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {evidence.titles.length > 0 || evidence.machines.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {evidence.titles.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1">
              <p className="label text-subtle">
                {evidence.titles.length === 1 ? "Titel" : `Titlar · ${evidence.titles.length}`}
              </p>
              <p className="text-sm break-words text-fg">{evidence.titles.join(", ")}</p>
            </div>
          ) : null}
          {evidence.machines.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1">
              <p className="label text-subtle">
                {evidence.machines.length === 1
                  ? "Automat"
                  : `Automater · ${evidence.machines.length}`}
              </p>
              <p className="text-sm break-words text-fg">{evidence.machines.join(", ")}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {evidence.dates.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="label text-subtle">Dagar</p>
          <p className="meta tnum text-muted">
            {evidence.dates.join(" · ")}
            {evidence.moreDates > 0 ? ` och ${evidence.moreDates} till` : ""}
          </p>
        </div>
      ) : null}
      {evidence.links.length > 0 ? (
        <ul className="flex flex-col gap-2 border-t border-line pt-3">
          {evidence.links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="rounded-xs text-sm text-fg underline decoration-line-control underline-offset-4 hover:decoration-fg max-md:tap"
              >
                {l.label} →
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
